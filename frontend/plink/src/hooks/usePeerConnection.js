import { useState, useEffect, useRef, useCallback } from "react";
import { io } from "socket.io-client";
import pako from "pako";
import {
  storeChunkIndexedDB,
  saveFileMetadataIndexedDB,
  readAllChunksIndexedDB,
  deleteFileIndexedDB,
} from "../services/indexedDB";
import { log } from "../utils/logger";
import { SERVER_URL } from "../utils/constants";

/**
 * This custom hook manages the entire lifecycle of the P2P connection,
 * including signaling, data channels, and file transfer logic.
 * @param {object} settings - The user-configurable settings (chunkSize, compression).
 */
export function usePeerConnection(settings) {
  // --- State for the UI ---
  // These state variables will trigger UI re-renders
  const [roomName, setRoomName] = useState("");
  const [isConnected, setIsConnected] = useState(false); // Connected to signaling server
  const [peerConnected, setPeerConnected] = useState(false); // Connected to the other peer (P2P)
  const [messages, setMessages] = useState([]);
  const [error, setError] = useState("");
  const [transferStats, setTransferStats] = useState(null); // Info about current file transfer
  const [speedData, setSpeedData] = useState([]); // For the speed graph
  const [connectionState, setConnectionState] = useState("idle"); // WebRTC connection state
  const [serverOnline, setServerOnline] = useState(false); // Is the signaling server reachable?

  // --- Refs for WebRTC and connection objects ---
  // These refs store objects that should not trigger re-renders on change
  const socketRef = useRef(null); // The WebSocket connection to the signaling server
  const peerConnectionRef = useRef(null); // The RTCPeerConnection object
  const dataChannelRef = useRef(null); // The data channel for chat
  const fileChannelRef = useRef(null); // The data channel for file transfer
  const roomIdRef = useRef(null); // Stores the current room name
  const pendingIceCandidatesRef = useRef([]); // Caches ICE candidates received before connection is ready
  const channelsReadyRef = useRef({ chat: false, file: false }); // Tracks if data channels are open

  // --- Refs for file transfer state ---
  const fileWriterMapRef = useRef({}); // Stores File System Access API writers
  const fileMetaRef = useRef({}); // Stores metadata of the file being received
  const receivedCountRef = useRef({}); // Tracks number of chunks received
  const isFinalizingRef = useRef({}); // Flag to prevent finalizing a file multiple times
  const startTimeRef = useRef(0); // For calculating transfer speed
  const maxTimeRef = useRef(0); // For the speed graph
  // Stores 'resolve' functions for promises that wait for a transfer to be acknowledged
  const transferCompletionResolversRef = useRef(new Map());

  // --- Core WebRTC and Channel Setup ---

  /**
   * Helper function to wait for the receiver to acknowledge a completed transfer.
   * This ensures the sender knows the file was successfully saved.
   * @param {string} fileId - The unique ID of the file to wait for.
   * @param {number} [timeout=45000] - Timeout in milliseconds.
   */
  const waitForAck = useCallback((fileId, timeout = 45000) => {
    return new Promise((resolve, reject) => {
      // Store the 'resolve' function so the 'onmessage' handler can call it
      transferCompletionResolversRef.current.set(fileId, resolve);
      // Set a timeout to reject if no ACK is received
      setTimeout(() => {
        if (transferCompletionResolversRef.current.has(fileId)) {
          transferCompletionResolversRef.current.delete(fileId);
          reject(new Error(`ACK timeout for file: ${fileId}`));
        }
      }, timeout);
    });
  }, []);

  /**
   * Validates the received file against the sender's metadata.
   * @returns {boolean} True if validation passes.
   */
  const validateTransfer = useCallback(
    (expectedSize, actualSize, expectedChunks, actualChunks) => {
      const sizeMatch = expectedSize === actualSize;
      const chunksMatch = expectedChunks === actualChunks;
      if (!sizeMatch || !chunksMatch) {
        log("Transfer validation FAILED", {
          sizeMatch,
          chunksMatch,
          expectedSize,
          actualSize,
        });
      }
      return sizeMatch && chunksMatch;
    },
    [],
  );

  /**
   * Sends data over a data channel, respecting backpressure.
   * This prevents the sender from overwhelming the receiver's buffer.
   * @param {RTCDataChannel} channel - The data channel to send on.
   * @param {ArrayBuffer} data - The data to send.
   */
  const sendWithBackpressure = useCallback(
    (channel, data) => {
      return new Promise((resolve, reject) => {
        const trySend = () => {
          if (channel.readyState !== "open") {
            return reject(new Error("Data channel is not open."));
          }
          // The buffer threshold is set to 16 chunks.
          const maxBuffer = settings.chunkSize * 16;
          if (channel.bufferedAmount < maxBuffer) {
            // Buffer is not full, send the data.
            try {
              channel.send(data);
              resolve();
            } catch (e) {
              reject(e);
            }
          } else {
            // If the buffer is full, wait for it to drain before sending more.
            log("File channel buffer full, waiting...");
            channel.addEventListener("bufferedamountlow", trySend, {
              once: true,
            });
          }
        };
        trySend();
      });
    },
    [settings.chunkSize], // Depends on chunkSize from user settings
  );

  /**
   * Sets up the file data channel and its event listeners.
   * This is where incoming files and chunks are processed.
   * @param {RTCDataChannel} channel - The newly created file data channel.
   */
  const setupFileChannel = useCallback(
    (channel) => {
      log("Setting up file channel");
      fileChannelRef.current = channel;
      channel.binaryType = "arraybuffer"; // We'll be receiving binary data

      channel.onopen = () => {
        log("File channel opened");
        channelsReadyRef.current.file = true;
        setMessages((p) => [
          ...p,
          { type: "system", text: "File transfer ready" },
        ]);
      };

      channel.onclose = () => {
        log("File channel closed");
        channelsReadyRef.current.file = false;
      };

      channel.onerror = (e) => log("File channel error", e);

      // This is the main message handler for the file channel.
      channel.onmessage = async (ev) => {
        try {
          // --- Handle STRING messages (metadata, ACKs) ---
          if (typeof ev.data === "string") {
            const message = JSON.parse(ev.data);

            if (message.type === "file-metadata") {
              // --- Receiver: Handle incoming file metadata ---
              const meta = message;
              log("Received file metadata", meta);

              // Initialize state for the new transfer
              fileMetaRef.current[meta.fileId] = meta;
              receivedCountRef.current[meta.fileId] = 0;
              isFinalizingRef.current[meta.fileId] = false;
              startTimeRef.current = Date.now();
              maxTimeRef.current = 0;

              // Update UI to show transfer progress
              setTransferStats({
                fileName: meta.name,
                totalSize: meta.size,
                receivedSize: 0,
                progress: 0,
                speed: 0,
                chunks: 0,
                totalChunks: meta.chunks || 0,
                compressed: meta.compressed || false,
              });
              setSpeedData([]); // Reset speed graph data

              // If the browser supports the File System Access API, use it for direct saving.
              // This is more memory-efficient as it streams directly to disk.
              if (window.showSaveFilePicker) {
                try {
                  const suggestedName =
                    meta.compressed && meta.name.endsWith(".zip")
                      ? meta.name.slice(0, -4) // Suggest original name if compressed
                      : meta.name;
                  const handle = await window.showSaveFilePicker({
                    suggestedName,
                  });
                  const writable = await handle.createWritable();
                  fileWriterMapRef.current[meta.fileId] = { writable, handle };
                } catch (e) {
                  // User cancelled the "Save" dialog
                  log("User cancelled save picker or it's not supported", e);
                  // We'll fall back to IndexedDB automatically
                }
              }
              // Save metadata to IndexedDB either way (as backup or primary)
              await saveFileMetadataIndexedDB({ fileId: meta.fileId, meta });
            } else if (message.type === "transfer-complete-ack") {
              // --- Sender: Handle transfer completion acknowledgment ---
              log(`Received ACK for ${message.fileId}`);
              // Find the 'resolve' function we stored in `waitForAck`
              const resolve = transferCompletionResolversRef.current.get(
                message.fileId,
              );
              if (resolve) {
                resolve(); // This resolves the promise in `sendFile`
                transferCompletionResolversRef.current.delete(message.fileId);
              }
            }
          } else {
            // --- Receiver: Handle incoming BINARY chunk data ---
            const buf = ev.data; // This is an ArrayBuffer
            // Assume the chunk belongs to the file we're currently tracking
            const fileId = Object.keys(fileMetaRef.current)[0];
            if (!fileId || !fileMetaRef.current[fileId]) return;

            const meta = fileMetaRef.current[fileId];
            const currentChunkIndex = receivedCountRef.current[fileId];
            receivedCountRef.current[fileId]++;
            const receivedChunks = receivedCountRef.current[fileId];

            // Write chunk to File System (if available) or IndexedDB (fallback)
            const fw = fileWriterMapRef.current[fileId];
            if (fw && fw.writable) {
              await fw.writable.write(new Uint8Array(buf));
            } else {
              await storeChunkIndexedDB(fileId, currentChunkIndex, buf);
            }

            // --- Update progress stats for the UI ---
            setTransferStats((prevStats) => {
              if (!prevStats) return prevStats;
              const newReceived = prevStats.receivedSize + buf.byteLength;
              const totalSize = meta.compressed
                ? meta.compressedSize
                : meta.size;
              const elapsed = (Date.now() - startTimeRef.current) / 1000;
              return {
                ...prevStats,
                receivedSize: newReceived,
                progress: (newReceived / totalSize) * 100,
                speed: newReceived / Math.max(elapsed, 0.001), // (bytes / sec)
                chunks: receivedChunks,
              };
            });

            // --- Finalize file if all chunks are received ---
            if (
              receivedChunks >= meta.chunks &&
              !isFinalizingRef.current[fileId]
            ) {
              isFinalizingRef.current[fileId] = true; // Set flag to prevent double-call
              log("All chunks received, finalizing file...", { fileId });

              try {
                let finalBlob;
                let actualSize = 0;

                if (fw && fw.writable) {
                  // --- Finalize with File System Access API ---
                  await fw.writable.close();
                  const file = await fw.handle.getFile();
                  actualSize = file.size;

                  // Handle decompression if needed
                  if (meta.compressed) {
                    setMessages((p) => [
                      ...p,
                      { type: "system", text: "Decompressing file..." },
                    ]);
                    const arrayBuffer = await file.arrayBuffer();
                    const decompressed = pako.inflate(
                      new Uint8Array(arrayBuffer),
                    );
                    actualSize = decompressed.length;

                    // Ask user to save the *decompressed* file
                    const newHandle = await window.showSaveFilePicker({
                      suggestedName: meta.name.slice(0, -4),
                    });
                    const newWritable = await newHandle.createWritable();
                    await newWritable.write(decompressed);
                    await newWritable.close();
                    await fw.handle.remove(); // Clean up the compressed temp file
                  }
                } else {
                  // --- Finalize with IndexedDB ---
                  const chunksArr = await readAllChunksIndexedDB(fileId);
                  if (chunksArr.length !== meta.chunks) {
                    throw new Error(
                      `Incomplete transfer: Expected ${meta.chunks}, got ${chunksArr.length}`,
                    );
                  }

                  let blobData = chunksArr;
                  // Handle decompression if needed
                  if (meta.compressed) {
                    setMessages((p) => [
                      ...p,
                      { type: "system", text: "Decompressing file..." },
                    ]);
                    // Combine all chunks into one Uint8Array
                    const totalSize = chunksArr.reduce(
                      (s, c) => s + c.byteLength,
                      0,
                    );
                    const combined = new Uint8Array(totalSize);
                    let offset = 0;
                    chunksArr.forEach((chunk) => {
                      combined.set(new Uint8Array(chunk), offset);
                      offset += chunk.byteLength;
                    });
                    const decompressed = pako.inflate(combined);
                    blobData = [decompressed.buffer];
                  }

                  // Create a Blob from the chunks (or decompressed data)
                  finalBlob = new Blob(blobData, { type: meta.mimeType });
                  actualSize = finalBlob.size;

                  // Trigger a browser download
                  const url = URL.createObjectURL(finalBlob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = meta.compressed
                    ? meta.name.slice(0, -4) // Use original name
                    : meta.name;
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(url), 100);
                }

                // --- Validate and send ACK to sender ---
                validateTransfer(
                  meta.size,
                  actualSize,
                  meta.chunks,
                  receivedChunks,
                );
                setMessages((p) => [
                  ...p,
                  { type: "system", text: `Downloaded: ${meta.name}` },
                ]);

                if (fileChannelRef.current?.readyState === "open") {
                  // Tell the sender we got the file
                  fileChannelRef.current.send(
                    JSON.stringify({ type: "transfer-complete-ack", fileId }),
                  );
                  log("Sent transfer completion ACK");
                }
              } catch (processingError) {
                log("Error finalizing file", processingError);
                setError("File processing error: " + processingError.message);
              } finally {
                // --- Cleanup after transfer ---
                await deleteFileIndexedDB(fileId);
                delete fileMetaRef.current[fileId];
                delete receivedCountRef.current[fileId];
                delete fileWriterMapRef.current[fileId];
                delete isFinalizingRef.current[fileId];
                setTimeout(() => setTransferStats(null), 3000); // Hide stats UI after 3s
              }
            }
          }
        } catch (e) {
          log("Error in file channel onmessage", e);
          setError("File receive error: " + e.message);
        }
      };
    },
    [validateTransfer, setMessages, setError], // Dependencies for useCallback
  );

  /**
   * Sets up the chat data channel and its event listeners.
   * @param {RTCDataChannel} channel - The newly created chat data channel.
   */
  const setupChatChannel = useCallback(
    (channel) => {
      log("Setting up chat channel");
      dataChannelRef.current = channel;
      channel.onopen = () => {
        log("Chat channel opened");
        channelsReadyRef.current.chat = true;
        setMessages((p) => [...p, { type: "system", text: "Chat ready" }]);
      };
      channel.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.type === "message") {
            // Add received message to the chat UI
            setMessages((p) => [...p, { type: "received", text: data.text }]);
          }
        } catch (e) {
          log("Error parsing chat message", e);
        }
      };
      channel.onclose = () => (channelsReadyRef.current.chat = false);
      channel.onerror = (e) => log("Chat channel error", e);
    },
    [setMessages], // Dependency for useCallback
  );

  /**
   * Creates and configures the RTCPeerConnection object.
   * This is the core of the WebRTC logic.
   * @param {boolean} isOfferer - True if this client should create the offer.
   */
  const createPeerConnection = useCallback(
    async (isOfferer) => {
      // Close any existing connection
      if (peerConnectionRef.current) peerConnectionRef.current.close();
      channelsReadyRef.current = { chat: false, file: false };

      // Create the peer connection with STUN servers
      // (STUN servers help find a path between peers)
      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
        ],
      });
      peerConnectionRef.current = pc;

      // This event fires when a new ICE candidate is found
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          // Send the candidate to the other peer via the signaling server
          socketRef.current.emit("ice-candidate", {
            roomId: roomIdRef.current,
            candidate: event.candidate,
          });
        }
      };

      // Update UI based on connection state changes.
      pc.onconnectionstatechange = () => {
        log("Connection state changed", pc.connectionState);
        setConnectionState(pc.connectionState); // Update UI
        if (pc.connectionState === "connected") {
          setPeerConnected(true);
          setError(""); // Clear any "connecting" errors
          setMessages((p) => [
            ...p,
            { type: "system", text: "P2P Connection Established" },
          ]);
        } else if (
          ["disconnected", "failed", "closed"].includes(pc.connectionState)
        ) {
          // Handle connection loss
          setPeerConnected(false);
          channelsReadyRef.current = { chat: false, file: false };
          if (pc.connectionState !== "closed") setError("Connection lost");
        }
      };

      // Handle ICE connection failures (e.g., network change)
      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === "failed") {
          log("ICE connection failed, restarting ICE.");
          pc.restartIce(); // Attempt to reconnect
        }
      };

      if (isOfferer) {
        // --- Offerer logic (Peer 1) ---
        // The first peer in the room creates the data channels.
        const chatChannel = pc.createDataChannel("chat");
        setupChatChannel(chatChannel);

        const fileChannel = pc.createDataChannel("file", { ordered: true });
        // Set a threshold to trigger 'bufferedamountlow' event
        fileChannel.bufferedAmountLowThreshold = settings.chunkSize * 4;
        setupFileChannel(fileChannel);

        // Create and send the offer to the other peer
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socketRef.current.emit("offer", {
          roomId: roomIdRef.current,
          offer: pc.localDescription,
        });
        log("Offer created and sent");
      } else {
        // --- Answerer logic (Peer 2) ---
        // The second peer waits for the data channels to be created by the offerer.
        pc.ondatachannel = (event) => {
          if (event.channel.label === "chat") {
            setupChatChannel(event.channel);
          } else if (event.channel.label === "file") {
            event.channel.bufferedAmountLowThreshold = settings.chunkSize * 4;
            setupFileChannel(event.channel);
          }
        };
      }
    },
    [
      setupFileChannel,
      setupChatChannel,
      settings.chunkSize,
      setMessages,
      setError,
    ], // Dependencies for useCallback
  );

  /**
   * Gracefully closes all connections and resets P2P state.
   */
  const cleanupPeerConnection = () => {
    log("Cleaning up P2P connection");
    pendingIceCandidatesRef.current = [];
    if (dataChannelRef.current) dataChannelRef.current.close();
    dataChannelRef.current = null;
    if (fileChannelRef.current) fileChannelRef.current.close();
    fileChannelRef.current = null;
    if (peerConnectionRef.current) peerConnectionRef.current.close();
    peerConnectionRef.current = null;
    setPeerConnected(false);
    channelsReadyRef.current = { chat: false, file: false };
  };

  /**
   * The main file sending function.
   * Handles compression, metadata sending, and chunking.
   * @param {File} file - The file object to send.
   */
  const sendFile = useCallback(
    async (file) => {
      if (
        !fileChannelRef.current ||
        fileChannelRef.current.readyState !== "open"
      ) {
        setError("File channel not ready for transfer.");
        return;
      }
      log("Starting file transfer", { name: file.name, size: file.size });

      let fileToSend = file;
      let isCompressed = false;
      const originalSize = file.size;

      // --- Compress the file (if enabled) ---
      if (settings.compression && file.type !== "application/zip") {
        try {
          setMessages((p) => [
            ...p,
            { type: "system", text: "Compressing file..." },
          ]);
          const arrayBuffer = await file.arrayBuffer();
          const compressed = pako.deflate(new Uint8Array(arrayBuffer));
          fileToSend = new File([compressed], file.name + ".zip", {
            type: "application/octet-stream",
          });
          isCompressed = true;
          log("File compressed", {
            original: originalSize,
            compressed: fileToSend.size,
          });
        } catch (e) {
          log("Compression failed, sending uncompressed", e);
        }
      }

      const totalChunks = Math.ceil(fileToSend.size / settings.chunkSize);
      const fileId = `${Date.now()}-${file.name}`; // Unique ID for this transfer

      // --- Prepare file metadata ---
      const metadata = {
        type: "file-metadata",
        fileId,
        name: file.name, // Original name
        size: originalSize, // Original size
        mimeType: file.type, // Original MIME type
        chunks: totalChunks,
        compressed: isCompressed,
        compressedSize: fileToSend.size, // Size of the file being sent
      };

      try {
        log("Sending file metadata", metadata);
        // Send metadata as a JSON string
        fileChannelRef.current.send(JSON.stringify(metadata));

        const startTime = Date.now();
        let sentBytes = 0;
        // Update UI to show sending progress
        setTransferStats({
          fileName: file.name,
          totalSize: originalSize,
          sentSize: 0,
          progress: 0,
          speed: 0,
          chunks: 0,
          totalChunks,
          compressed: isCompressed,
        });
        setSpeedData([]); // Reset speed graph

        // --- Loop through the file, sending one chunk at a time ---
        for (let index = 0; index < totalChunks; index++) {
          if (fileChannelRef.current.readyState !== "open") {
            throw new Error("File channel closed during transfer");
          }
          const offset = index * settings.chunkSize;
          const slice = fileToSend.slice(offset, offset + settings.chunkSize);
          const arrayBuffer = await slice.arrayBuffer();

          // Send chunk, respecting backpressure
          await sendWithBackpressure(fileChannelRef.current, arrayBuffer);

          sentBytes += arrayBuffer.byteLength;
          // Update UI stats
          setTransferStats((prev) => ({
            ...prev,
            sentSize: sentBytes,
            progress: (sentBytes / fileToSend.size) * 100,
            speed: sentBytes / ((Date.now() - startTime) / 1000 || 1),
            chunks: index + 1,
          }));
        }

        log(
          `All chunks sent for ${file.name}. Waiting for receiver acknowledgment...`,
        );
        setMessages((p) => [
          ...p,
          {
            type: "system",
            text: `Sent: ${file.name}. Waiting for confirmation...`,
          },
        ]);

        // --- Wait for the receiver to confirm they've saved the file ---
        await waitForAck(fileId);

        log(`ACK received. Transfer for ${file.name} is complete.`);
        // Update "Waiting" message to "Completed"
        setMessages((p) => {
          const newMessages = [...p];
          const lastMsgIndex = newMessages.findIndex((m) =>
            m.text.includes(`Waiting for confirmation...`),
          );
          if (lastMsgIndex > -1) {
            newMessages[lastMsgIndex] = {
              type: "system",
              text: `Transfer completed: ${file.name}`,
            };
          }
          return newMessages;
        });
      } catch (e) {
        log("File transfer failed", e);
        setError("Failed to send file: " + e.message);
      } finally {
        setTimeout(() => setTransferStats(null), 3000); // Hide stats UI
        transferCompletionResolversRef.current.delete(fileId);
      }
    },
    [
      settings.chunkSize,
      settings.compression,
      sendWithBackpressure,
      waitForAck,
      setMessages,
      setError,
    ],
  );

  // --- Socket.IO Event Handlers for Signaling ---
  useEffect(() => {
    log("Initializing socket connection");
    const socket = io(SERVER_URL, {
      path: "/socket.io",
      transports: ["websocket", "polling"],
      reconnectionAttempts: 5,
    });
    socketRef.current = socket;

    // --- Socket Event Listeners ---
    socket.on("connect", () => log("Socket connected", socket.id));
    socket.on("connect_error", (err) => {
      log("Socket connect_error", err.message);
      setError("Signaling connection error");
    });

    // Server says we are the first, waiting for peer
    socket.on("waiting-for-peer", () => {
      log("Waiting for peer");
      setIsConnected(true);
      setError("Waiting for peer...");
      setConnectionState("waiting");
    });

    // Server says room is full
    socket.on("room-full", () => {
      log("Room full");
      setError("Room is full.");
      setIsConnected(false);
    });

    // Server confirms we joined a room
    socket.on("joined-room", ({ room }) => {
      log("Joined room", { room });
      setIsConnected(true);
      roomIdRef.current = room; // Store the room name
    });

    // A peer has joined our room, we (as offerer) should start P2P
    socket.on("user-connected", () => {
      log("Peer connected to room, creating offer");
      setError("Peer joined. Establishing P2P...");
      setConnectionState("connecting");
      createPeerConnection(true); // Create as offerer
    });

    // Received an offer from the other peer
    socket.on("offer", async ({ offer }) => {
      log("Received WebRTC offer");
      setError("Received connection request...");
      setConnectionState("connecting");
      if (!peerConnectionRef.current) {
        await createPeerConnection(false); // Create as answerer
      }
      await peerConnectionRef.current.setRemoteDescription(
        new RTCSessionDescription(offer),
      );
      // Add any pending ICE candidates
      for (const candidate of pendingIceCandidatesRef.current) {
        await peerConnectionRef.current.addIceCandidate(
          new RTCIceCandidate(candidate),
        );
      }
      pendingIceCandidatesRef.current = [];
      // Create and send the answer
      const answer = await peerConnectionRef.current.createAnswer();
      await peerConnectionRef.current.setLocalDescription(answer);
      socket.emit("answer", { roomId: roomIdRef.current, answer });
    });

    // Received an answer from the other peer
    socket.on("answer", async ({ answer }) => {
      log("Received WebRTC answer");
      if (peerConnectionRef.current) {
        await peerConnectionRef.current.setRemoteDescription(
          new RTCSessionDescription(answer),
        );
        // Add any pending ICE candidates
        for (const candidate of pendingIceCandidatesRef.current) {
          await peerConnectionRef.current.addIceCandidate(
            new RTCIceCandidate(candidate),
          );
        }
        pendingIceCandidatesRef.current = [];
      }
    });

    // Received an ICE candidate from the other peer
    socket.on("ice-candidate", async ({ candidate }) => {
      if (!candidate) return;
      try {
        if (peerConnectionRef.current?.remoteDescription) {
          // If remote description is set, add candidate immediately
          await peerConnectionRef.current.addIceCandidate(
            new RTCIceCandidate(candidate),
          );
        } else {
          // Otherwise, cache it
          pendingIceCandidatesRef.current.push(candidate);
        }
      } catch (e) {
        log("Error adding received ICE candidate", e.message);
      }
    });

    // The other peer disconnected from the room
    socket.on("user-disconnected", () => {
      log("User disconnected");
      setPeerConnected(false);
      setMessages((p) => [...p, { type: "system", text: "Peer disconnected" }]);
      cleanupPeerConnection(); // Clean up our P2P connection
    });

    // Server reports an error joining (e.g., bad password)
    socket.on("join-error", ({ message }) => {
      log("Join error", message);
      setError(message);
    });

    // Cleanup function for when the component unmounts
    return () => {
      log("Cleaning up socket connection");
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      cleanupPeerConnection();
    };
  }, [createPeerConnection, setMessages, setError]); // Dependencies for useEffect

  // --- Server Health Check Effect ---
  // Periodically checks if the signaling server is online
  useEffect(() => {
    const checkServerStatus = async () => {
      try {
        const res = await fetch(`${SERVER_URL}/health`);
        const data = await res.json();
        const isOnline = data.status === "online";
        setServerOnline(isOnline);
        if (isOnline && error === "Cannot contact signaling server") {
          setError(""); // Clear error if server comes back online
        }
      } catch (e) {
        setServerOnline(false);
        if (!isConnected) {
          setError("Cannot contact signaling server");
        }
      }
    };

    checkServerStatus(); // Check immediately
    const intervalId = setInterval(checkServerStatus, 10000); // And every 10s
    return () => clearInterval(intervalId);
  }, [error, isConnected]);

  // --- UI Action Handlers ---

  /**
   * Called by the UI to join a room.
   * Now accepts a password.
   * @param {string} roomPassword - The password for the room (can be empty string or null).
   */
  const joinRoom = useCallback(
    (roomPassword) => {
      if (!roomName.trim() || !serverOnline) return;
      const socket = socketRef.current;
      if (!socket || !socket.connected) socket.connect();
      // Send roomName, userId, and password to the server
      socket.emit("join-room", {
        roomId: roomName,
        userId: socket.id,
        password: roomPassword || null, // Send null if password is empty
      });
      setError("Joining room...");
    },
    [roomName, serverOnline], // Dependencies for useCallback
  );

  /**
   * Called by the UI to leave a room.
   */
  const leaveRoom = () => {
    if (socketRef.current) {
      socketRef.current.emit("leave-room", { roomId: roomIdRef.current });
      socketRef.current.disconnect();
    }
    cleanupPeerConnection(); // Clean up P2P
    // Reset all state
    setIsConnected(false);
    setPeerConnected(false);
    setRoomName("");
    setMessages([]);
    setError("");
    setConnectionState("idle");
  };

  /**
   * Called by the UI to send a chat message.
   */
  const sendMessage = useCallback(
    (messageInput, setMessageInput) => {
      if (!messageInput.trim() || !channelsReadyRef.current.chat) return;
      dataChannelRef.current.send(
        JSON.stringify({ type: "message", text: messageInput }),
      );
      // Add to local UI immediately
      setMessages((p) => [...p, { type: "sent", text: messageInput }]);
      setMessageInput(""); // Clear the input field
    },
    [setMessages], // Dependency for useCallback
  );

  // Expose all state and actions to the App component
  return {
    // State
    roomName,
    isConnected,
    peerConnected,
    messages,
    error,
    transferStats,
    speedData,
    connectionState,
    channelsReady: channelsReadyRef.current,
    serverOnline,
    // Setters & Actions
    setRoomName,
    setMessages,
    joinRoom,
    leaveRoom,
    sendMessage,
    sendFile,
  };
}
