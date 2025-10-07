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
  // State for the UI
  const [roomName, setRoomName] = useState("");
  const [isConnected, setIsConnected] = useState(false);
  const [peerConnected, setPeerConnected] = useState(false);
  const [messages, setMessages] = useState([]);
  const [error, setError] = useState("");
  const [transferStats, setTransferStats] = useState(null);
  const [speedData, setSpeedData] = useState([]);
  const [connectionState, setConnectionState] = useState("idle");
  const [serverOnline, setServerOnline] = useState(false);

  // Refs for WebRTC and connection objects that don't trigger re-renders
  const socketRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const dataChannelRef = useRef(null);
  const fileChannelRef = useRef(null);
  const roomIdRef = useRef(null);
  const pendingIceCandidatesRef = useRef([]);
  const channelsReadyRef = useRef({ chat: false, file: false });

  // Refs for file transfer state
  const fileWriterMapRef = useRef({});
  const fileMetaRef = useRef({});
  const receivedCountRef = useRef({});
  const isFinalizingRef = useRef({});
  const startTimeRef = useRef(0);
  const maxTimeRef = useRef(0);
  const transferCompletionResolversRef = useRef(new Map());

  // --- Core WebRTC and Channel Setup ---

  /**
   * Helper function to wait for the receiver to acknowledge a completed transfer.
   * This ensures the sender knows the file was successfully saved.
   */
  const waitForAck = useCallback((fileId, timeout = 45000) => {
    return new Promise((resolve, reject) => {
      transferCompletionResolversRef.current.set(fileId, resolve);
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
            try {
              channel.send(data);
              resolve();
            } catch (e) {
              reject(e);
            }
          } else {
            // If the buffer is full, wait for it to drain before sending more.
            channel.addEventListener("bufferedamountlow", trySend, {
              once: true,
            });
          }
        };
        trySend();
      });
    },
    [settings.chunkSize],
  );

  /**
   * Sets up the file data channel and its event listeners.
   * This is where incoming files and chunks are processed.
   */
  const setupFileChannel = useCallback(
    (channel) => {
      log("Setting up file channel");
      fileChannelRef.current = channel;
      channel.binaryType = "arraybuffer";

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
              setSpeedData([]);

              // If the browser supports the File System Access API, use it for direct saving.
              if (window.showSaveFilePicker) {
                try {
                  const suggestedName =
                    meta.compressed && meta.name.endsWith(".zip")
                      ? meta.name.slice(0, -4)
                      : meta.name;
                  const handle = await window.showSaveFilePicker({
                    suggestedName,
                  });
                  const writable = await handle.createWritable();
                  fileWriterMapRef.current[meta.fileId] = { writable, handle };
                } catch (e) {
                  log("User cancelled save picker or it's not supported", e);
                }
              }
              await saveFileMetadataIndexedDB({ fileId: meta.fileId, meta });
            } else if (message.type === "transfer-complete-ack") {
              // --- Sender: Handle transfer completion acknowledgment ---
              log(`Received ACK for ${message.fileId}`);
              const resolve = transferCompletionResolversRef.current.get(
                message.fileId,
              );
              if (resolve) {
                resolve(); // This resolves the promise in `waitForAck`.
                transferCompletionResolversRef.current.delete(message.fileId);
              }
            }
          } else {
            // --- Receiver: Handle incoming binary chunk data ---
            const buf = ev.data;
            const fileId = Object.keys(fileMetaRef.current)[0];
            if (!fileId || !fileMetaRef.current[fileId]) return;

            const meta = fileMetaRef.current[fileId];
            const currentChunkIndex = receivedCountRef.current[fileId];
            receivedCountRef.current[fileId]++;
            const receivedChunks = receivedCountRef.current[fileId];

            // Write chunk to File System or IndexedDB
            const fw = fileWriterMapRef.current[fileId];
            if (fw && fw.writable) {
              await fw.writable.write(new Uint8Array(buf));
            } else {
              await storeChunkIndexedDB(fileId, currentChunkIndex, buf);
            }

            // Update progress stats
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
                speed: newReceived / Math.max(elapsed, 0.001),
                chunks: receivedChunks,
              };
            });

            // If all chunks are received, finalize the file
            if (
              receivedChunks >= meta.chunks &&
              !isFinalizingRef.current[fileId]
            ) {
              isFinalizingRef.current[fileId] = true;
              log("All chunks received, finalizing file...", { fileId });

              try {
                let finalBlob;
                let actualSize = 0;

                if (fw && fw.writable) {
                  // --- Finalize with File System Access API ---
                  await fw.writable.close();
                  const file = await fw.handle.getFile();
                  actualSize = file.size;

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
                  if (meta.compressed) {
                    setMessages((p) => [
                      ...p,
                      { type: "system", text: "Decompressing file..." },
                    ]);
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

                  finalBlob = new Blob(blobData, { type: meta.mimeType });
                  actualSize = finalBlob.size;

                  const url = URL.createObjectURL(finalBlob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = meta.compressed
                    ? meta.name.slice(0, -4)
                    : meta.name;
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(url), 100);
                }

                // Validate and send ACK
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
                  fileChannelRef.current.send(
                    JSON.stringify({ type: "transfer-complete-ack", fileId }),
                  );
                  log("Sent transfer completion ACK");
                }
              } catch (processingError) {
                log("Error finalizing file", processingError);
                setError("File processing error: " + processingError.message);
              } finally {
                // Cleanup
                await deleteFileIndexedDB(fileId);
                delete fileMetaRef.current[fileId];
                delete receivedCountRef.current[fileId];
                delete fileWriterMapRef.current[fileId];
                delete isFinalizingRef.current[fileId];
                setTimeout(() => setTransferStats(null), 3000);
              }
            }
          }
        } catch (e) {
          log("Error in file channel onmessage", e);
          setError("File receive error: " + e.message);
        }
      };
    },
    [validateTransfer, setMessages, setError],
  );

  /**
   * Sets up the chat data channel and its event listeners.
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
            setMessages((p) => [...p, { type: "received", text: data.text }]);
          }
        } catch (e) {
          log("Error parsing chat message", e);
        }
      };
      channel.onclose = () => (channelsReadyRef.current.chat = false);
      channel.onerror = (e) => log("Chat channel error", e);
    },
    [setMessages],
  );

  /**
   * Creates and configures the RTCPeerConnection object.
   */
  const createPeerConnection = useCallback(
    async (isOfferer) => {
      if (peerConnectionRef.current) peerConnectionRef.current.close();
      channelsReadyRef.current = { chat: false, file: false };

      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
        ],
      });
      peerConnectionRef.current = pc;

      // Handle ICE candidates by sending them to the other peer via the server.
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socketRef.current.emit("ice-candidate", {
            roomId: roomIdRef.current,
            candidate: event.candidate,
          });
        }
      };

      // Update UI based on connection state changes.
      pc.onconnectionstatechange = () => {
        log("Connection state changed", pc.connectionState);
        setConnectionState(pc.connectionState);
        if (pc.connectionState === "connected") {
          setPeerConnected(true);
          setError("");
          setMessages((p) => [
            ...p,
            { type: "system", text: "P2P Connection Established" },
          ]);
        } else if (
          ["disconnected", "failed", "closed"].includes(pc.connectionState)
        ) {
          setPeerConnected(false);
          channelsReadyRef.current = { chat: false, file: false };
          if (pc.connectionState !== "closed") setError("Connection lost");
        }
      };

      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === "failed") {
          log("ICE connection failed, restarting ICE.");
          pc.restartIce();
        }
      };

      if (isOfferer) {
        // The first peer in the room creates the data channels and the offer.
        const chatChannel = pc.createDataChannel("chat");
        setupChatChannel(chatChannel);
        const fileChannel = pc.createDataChannel("file", { ordered: true });
        fileChannel.bufferedAmountLowThreshold = settings.chunkSize * 4;
        setupFileChannel(fileChannel);

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socketRef.current.emit("offer", {
          roomId: roomIdRef.current,
          offer: pc.localDescription,
        });
        log("Offer created and sent");
      } else {
        // The second peer waits for the data channels to be created.
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
    ],
  );

  /**
   * Gracefully closes all connections and resets state.
   */
  const cleanupPeerConnection = () => {
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

      // Compress the file if enabled and not already a zip
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
      const fileId = `${Date.now()}-${file.name}`;

      const metadata = {
        type: "file-metadata",
        fileId,
        name: file.name,
        size: originalSize,
        mimeType: file.type,
        chunks: totalChunks,
        compressed: isCompressed,
        compressedSize: fileToSend.size,
      };

      try {
        log("Sending file metadata", metadata);
        fileChannelRef.current.send(JSON.stringify(metadata));

        const startTime = Date.now();
        let sentBytes = 0;
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
        setSpeedData([]);

        // Loop through the file, sending one chunk at a time.
        for (let index = 0; index < totalChunks; index++) {
          if (fileChannelRef.current.readyState !== "open") {
            throw new Error("File channel closed during transfer");
          }
          const offset = index * settings.chunkSize;
          const slice = fileToSend.slice(offset, offset + settings.chunkSize);
          const arrayBuffer = await slice.arrayBuffer();
          await sendWithBackpressure(fileChannelRef.current, arrayBuffer);

          sentBytes += arrayBuffer.byteLength;
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

        // Wait for the receiver to confirm they've saved the file.
        await waitForAck(fileId);

        log(`ACK received. Transfer for ${file.name} is complete.`);
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
        setTimeout(() => setTransferStats(null), 3000);
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

    socket.on("connect", () => log("Socket connected", socket.id));
    socket.on("connect_error", (err) => {
      log("Socket connect_error", err.message);
      setError("Signaling connection error");
    });
    socket.on("waiting-for-peer", () => {
      log("Waiting for peer");
      setIsConnected(true);
      setError("Waiting for peer...");
      setConnectionState("waiting");
    });
    socket.on("room-full", () => {
      log("Room full");
      setError("Room is full.");
      setIsConnected(false);
    });
    socket.on("joined-room", ({ room }) => {
      log("Joined room", { room });
      setIsConnected(true);
      roomIdRef.current = room;
    });
    socket.on("user-connected", () => {
      log("Peer connected to room, creating offer");
      setError("Peer joined. Establishing P2P...");
      setConnectionState("connecting");
      createPeerConnection(true);
    });
    socket.on("offer", async ({ offer }) => {
      log("Received WebRTC offer");
      setError("Received connection request...");
      setConnectionState("connecting");
      if (!peerConnectionRef.current) {
        await createPeerConnection(false);
      }
      await peerConnectionRef.current.setRemoteDescription(
        new RTCSessionDescription(offer),
      );
      for (const candidate of pendingIceCandidatesRef.current) {
        await peerConnectionRef.current.addIceCandidate(
          new RTCIceCandidate(candidate),
        );
      }
      pendingIceCandidatesRef.current = [];
      const answer = await peerConnectionRef.current.createAnswer();
      await peerConnectionRef.current.setLocalDescription(answer);
      socket.emit("answer", { roomId: roomIdRef.current, answer });
    });
    socket.on("answer", async ({ answer }) => {
      log("Received WebRTC answer");
      if (peerConnectionRef.current) {
        await peerConnectionRef.current.setRemoteDescription(
          new RTCSessionDescription(answer),
        );
        for (const candidate of pendingIceCandidatesRef.current) {
          await peerConnectionRef.current.addIceCandidate(
            new RTCIceCandidate(candidate),
          );
        }
        pendingIceCandidatesRef.current = [];
      }
    });
    socket.on("ice-candidate", async ({ candidate }) => {
      if (!candidate) return;
      try {
        if (peerConnectionRef.current?.remoteDescription) {
          await peerConnectionRef.current.addIceCandidate(
            new RTCIceCandidate(candidate),
          );
        } else {
          pendingIceCandidatesRef.current.push(candidate);
        }
      } catch (e) {
        log("Error adding received ICE candidate", e.message);
      }
    });
    socket.on("user-disconnected", () => {
      log("User disconnected");
      setPeerConnected(false);
      setMessages((p) => [...p, { type: "system", text: "Peer disconnected" }]);
      cleanupPeerConnection();
    });
    socket.on("join-error", ({ message }) => {
      log("Join error", message);
      setError(message);
    });

    return () => {
      log("Cleaning up socket connection");
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      cleanupPeerConnection();
    };
  }, [createPeerConnection, setMessages, setError]);

  // --- Server Health Check Effect ---
  useEffect(() => {
    const checkServerStatus = async () => {
      try {
        const res = await fetch(`${SERVER_URL}/health`);
        const data = await res.json();
        const isOnline = data.status === "online";
        setServerOnline(isOnline);
        if (isOnline && error === "Cannot contact signaling server") {
          setError("");
        }
      } catch (e) {
        setServerOnline(false);
        if (!isConnected) {
          setError("Cannot contact signaling server");
        }
      }
    };

    checkServerStatus();
    const intervalId = setInterval(checkServerStatus, 10000);
    return () => clearInterval(intervalId);
  }, [error, isConnected]);

  // --- UI Action Handlers ---

  const joinRoom = useCallback(() => {
    if (!roomName.trim() || !serverOnline) return;
    const socket = socketRef.current;
    if (!socket || !socket.connected) socket.connect();
    socket.emit("join-room", { roomId: roomName, userId: socket.id });
    setError("Joining room...");
  }, [roomName, serverOnline]);

  const leaveRoom = () => {
    if (socketRef.current) {
      socketRef.current.emit("leave-room", { roomId: roomIdRef.current });
      socketRef.current.disconnect();
    }
    cleanupPeerConnection();
    setIsConnected(false);
    setPeerConnected(false);
    setRoomName("");
    setMessages([]);
    setError("");
    setConnectionState("idle");
  };

  const sendMessage = useCallback(
    (messageInput, setMessageInput) => {
      if (!messageInput.trim() || !channelsReadyRef.current.chat) return;
      dataChannelRef.current.send(
        JSON.stringify({ type: "message", text: messageInput }),
      );
      setMessages((p) => [...p, { type: "sent", text: messageInput }]);
      setMessageInput("");
    },
    [setMessages],
  );

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
