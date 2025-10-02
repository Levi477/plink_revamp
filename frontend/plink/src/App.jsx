import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Send,
  Wifi,
  WifiOff,
  Upload,
  Download,
  Users,
  AlertCircle,
  Activity,
  Zap,
} from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { io } from "socket.io-client";
import { motion, AnimatePresence } from "framer-motion";

// --- CONFIG ---
const CHUNK_SIZE = 256 * 1024; // 256 KB
const SERVER_URL = "https://plink-revamp-backend.onrender.com";
const SENDER_MAX_BUFFER = CHUNK_SIZE * 8; // threshold for backpressure

// --- IndexedDB functions (unchanged) ---
function openDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("plink-file-transfer-db", 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("chunks")) {
        db.createObjectStore("chunks", { keyPath: ["fileId", "index"] });
      }
      if (!db.objectStoreNames.contains("files")) {
        db.createObjectStore("files", { keyPath: "fileId" });
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function storeChunkIndexedDB(fileId, index, data) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["chunks"], "readwrite");
    tx.objectStore("chunks").put({ fileId, index, data });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function saveFileMetadataIndexedDB(fileMeta) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["files"], "readwrite");
    tx.objectStore("files").put(fileMeta);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function readAllChunksIndexedDB(fileId, totalChunks) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["chunks"], "readonly");
    const store = tx.objectStore("chunks");
    const chunks = new Array(totalChunks);
    let got = 0;

    const req = store.openCursor();
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        const { fileId: fId, index, data } = cursor.value;
        if (fId === fileId) {
          chunks[index] = data;
          got++;
        }
        cursor.continue();
      }
    };

    tx.oncomplete = () => {
      resolve(chunks.filter((c) => c));
    };
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteFileIndexedDB(fileId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["chunks", "files"], "readwrite");
    const storeC = tx.objectStore("chunks");
    const req = storeC.openCursor();
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        if (cursor.value.fileId === fileId) cursor.delete();
        cursor.continue();
      }
    };
    tx.objectStore("files").delete(fileId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- Helper Component for Animated Stats ---
const AnimatedStat = ({ value, unit }) => {
  return (
    <motion.span
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5 }}
    >
      {value}
      <span className="text-sm text-slate-400">{unit}</span>
    </motion.span>
  );
};

// --- Helper Component for Radial Progress ---
const RadialProgress = ({ progress }) => {
  const radius = 50;
  const stroke = 8;
  const normalizedRadius = radius - stroke * 2;
  const circumference = normalizedRadius * 2 * Math.PI;
  const strokeDashoffset = circumference - (progress / 100) * circumference;

  return (
    <div className="relative flex items-center justify-center w-32 h-32">
      <svg
        height="100%"
        width="100%"
        viewBox="0 0 120 120"
        className="transform -rotate-90"
      >
        <circle
          stroke="rgba(255, 255, 255, 0.1)"
          fill="transparent"
          strokeWidth={stroke}
          r={normalizedRadius}
          cx={radius + stroke}
          cy={radius + stroke}
        />
        <motion.circle
          stroke="url(#progressGradient)"
          fill="transparent"
          strokeWidth={stroke}
          strokeLinecap="round"
          r={normalizedRadius}
          cx={radius + stroke}
          cy={radius + stroke}
          style={{ strokeDasharray: circumference, strokeDashoffset }}
          animate={{ strokeDashoffset }}
          transition={{ duration: 0.5 }}
        />
        <defs>
          <linearGradient
            id="progressGradient"
            x1="0%"
            y1="0%"
            x2="100%"
            y2="100%"
          >
            <stop offset="0%" stopColor="#3b82f6" />
            <stop offset="100%" stopColor="#06b6d4" />
          </linearGradient>
        </defs>
      </svg>
      <div className="absolute flex flex-col items-center justify-center">
        <span className="text-2xl font-bold">
          <AnimatedStat value={progress.toFixed(1)} unit="%" />
        </span>
      </div>
    </div>
  );
};

export default function P2PFileSharing() {
  const [roomName, setRoomName] = useState("");
  const [serverOnline, setServerOnline] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [peerConnected, setPeerConnected] = useState(false);
  const [messages, setMessages] = useState([]);
  const [messageInput, setMessageInput] = useState("");
  const [error, setError] = useState("");
  const [transferStats, setTransferStats] = useState(null);
  const [speedData, setSpeedData] = useState([]);
  const [connectionState, setConnectionState] = useState("idle");
  const [isDragging, setIsDragging] = useState(false);

  const socketRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const dataChannelRef = useRef(null);
  const fileChannelRef = useRef(null);
  const fileWriterMapRef = useRef({});
  const fileMetaRef = useRef({});
  const receivedCountRef = useRef({});
  const isFinalizingRef = useRef({});
  const startTimeRef = useRef(0);
  const roomIdRef = useRef(null);
  const pendingIceCandidatesRef = useRef([]);

  const log = useCallback((message, data = null) => {
    const timestamp = new Date().toISOString().split("T")[1].slice(0, -1);
    console.log(`[${timestamp}] ${message}`, data || "");
  }, []);

  const checkServerStatus = async () => {
    try {
      const res = await fetch(`${SERVER_URL}/health`);
      const data = await res.json();
      setServerOnline(data.status === "online");
      if (
        data.status === "online" &&
        error === "Cannot contact signaling server"
      ) {
        setError("");
      }
    } catch (e) {
      setServerOnline(false);
      setError("Cannot contact signaling server");
    }
  };

  useEffect(() => {
    checkServerStatus();
    const id = setInterval(checkServerStatus, 10000);
    return () => clearInterval(id);
  }, [error]);

  useEffect(() => {
    log("Initializing socket connection");
    const socket = io(SERVER_URL, {
      path: "/socket.io",
      transports: ["websocket", "polling"],
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });

    socketRef.current = socket;
    socket.on("connect", () => log("Socket connected", socket.id));
    socket.on("connect_error", (err) => {
      log("Socket connect_error", err.message);
      setError("Signaling connection error");
    });
    // ... other socket listeners from original code
    // The following listeners are condensed for brevity, but are identical to original.
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
      setConnectionState("error");
    });
    socket.on("joined-room", ({ room, position }) => {
      log("Joined room", { room, position });
      setIsConnected(true);
      roomIdRef.current = room;
      setError(position === 2 ? "Connected. Waiting..." : "");
    });
    socket.on("user-connected", ({ userId }) => {
      log("User connected", userId);
      setError("Peer joined. Establishing...");
      setConnectionState("connecting");
      setTimeout(() => createPeerConnection(true), 500);
    });
    socket.on("offer", async ({ offer }) => {
      log("Received WebRTC offer");
      setError("Received connection request...");
      setConnectionState("connecting");
      if (!peerConnectionRef.current) await createPeerConnection(false);
      try {
        await peerConnectionRef.current.setRemoteDescription(
          new RTCSessionDescription(offer),
        );
        if (pendingIceCandidatesRef.current.length > 0) {
          for (const candidate of pendingIceCandidatesRef.current) {
            await peerConnectionRef.current.addIceCandidate(
              new RTCIceCandidate(candidate),
            );
          }
          pendingIceCandidatesRef.current = [];
        }
        const answer = await peerConnectionRef.current.createAnswer();
        await peerConnectionRef.current.setLocalDescription(answer);
        socketRef.current.emit("answer", {
          roomId: roomIdRef.current,
          answer: peerConnectionRef.current.localDescription,
        });
      } catch (e) {
        log("Error handling offer", e);
        setError("Failed to establish connection");
      }
    });
    socket.on("answer", async ({ answer }) => {
      log("Received WebRTC answer");
      if (peerConnectionRef.current) {
        try {
          await peerConnectionRef.current.setRemoteDescription(
            new RTCSessionDescription(answer),
          );
          if (pendingIceCandidatesRef.current.length > 0) {
            for (const candidate of pendingIceCandidatesRef.current) {
              await peerConnectionRef.current.addIceCandidate(
                new RTCIceCandidate(candidate),
              );
            }
            pendingIceCandidatesRef.current = [];
          }
        } catch (e) {
          log("Error setting remote description from answer", e);
        }
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
    socket.on("user-disconnected", ({ userId }) => {
      log("User disconnected", userId);
      setPeerConnected(false);
      setConnectionState("disconnected");
      setMessages((p) => [...p, { type: "system", text: "Peer disconnected" }]);
      cleanupPeerConnection();
    });
    socket.on("join-error", ({ message }) => {
      log("Join error", message);
      setError(message);
      setConnectionState("error");
    });

    return () => {
      log("Cleaning up socket connection");
      if (socketRef.current) {
        socketRef.current.off();
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      cleanupPeerConnection();
    };
  }, [log]); // log is memoized with useCallback

  const setupFileChannel = useCallback(
    (channel) => {
      log("Setting up file channel");
      fileChannelRef.current = channel;
      channel.binaryType = "arraybuffer";
      channel.onopen = () => {
        log("File channel opened");
        setMessages((p) => [
          ...p,
          { type: "system", text: "File transfer ready" },
        ]);
      };
      channel.onmessage = async (ev) => {
        try {
          if (typeof ev.data === "string") {
            const meta = JSON.parse(ev.data);
            log("Received file metadata", meta);
            fileMetaRef.current[meta.fileId] = meta;
            receivedCountRef.current[meta.fileId] = 0;
            isFinalizingRef.current[meta.fileId] = false;
            startTimeRef.current = Date.now();
            setTransferStats({
              fileName: meta.name,
              totalSize: meta.size,
              receivedSize: 0,
              progress: 0,
              speed: 0,
              chunks: 0,
              totalChunks: meta.chunks || 0,
            });
            setSpeedData([]);
            if (window.showSaveFilePicker) {
              try {
                const handle = await window.showSaveFilePicker({
                  suggestedName: meta.name,
                });
                const writable = await handle.createWritable();
                fileWriterMapRef.current[meta.fileId] = { writable, handle };
              } catch (e) {
                log(
                  "User cancelled save picker or FS API unavailable",
                  e.message,
                );
              }
            }
            await saveFileMetadataIndexedDB({ fileId: meta.fileId, meta });
          } else {
            const buf = ev.data;
            const fileId = Object.keys(fileMetaRef.current || {})[0];
            if (!fileId || !fileMetaRef.current[fileId]) return;

            const currentChunkIndex = receivedCountRef.current[fileId];
            receivedCountRef.current[fileId]++;
            const receivedChunks = receivedCountRef.current[fileId];

            const fw = fileWriterMapRef.current[fileId];
            if (fw && fw.writable) {
              await fw.writable.write(new Uint8Array(buf));
            } else {
              await storeChunkIndexedDB(fileId, currentChunkIndex, buf);
            }

            // --- 🔧 FIX: Use functional update for accurate stats ---
            setTransferStats((prevStats) => {
              if (!prevStats) return prevStats;
              const newReceived =
                (prevStats.receivedSize || 0) + buf.byteLength;
              const totalSize = fileMetaRef.current[fileId].size;
              const elapsed = Math.max(
                (Date.now() - startTimeRef.current) / 1000,
                0.001,
              );
              const speed = newReceived / elapsed;
              const progress = (newReceived / totalSize) * 100;

              return {
                ...prevStats,
                receivedSize: newReceived,
                progress,
                speed,
                chunks: receivedChunks,
              };
            });

            const elapsed = (Date.now() - startTimeRef.current) / 1000;
            const currentSpeed =
              (receivedCountRef.current[fileId] * CHUNK_SIZE) /
              Math.max(elapsed, 0.001);

            // --- 🔧 FIX: Store numeric data for growing chart axis ---
            setSpeedData((prev) => [
              ...prev,
              {
                time: parseFloat(elapsed.toFixed(1)),
                speed: parseFloat((currentSpeed / 1024 / 1024).toFixed(2)),
              },
            ]);

            const totalChunks = fileMetaRef.current[fileId].chunks;
            if (
              receivedChunks >= totalChunks &&
              !isFinalizingRef.current[fileId]
            ) {
              isFinalizingRef.current[fileId] = true;
              log("File transfer complete - finalizing", { fileId });

              // Finalizing logic (unchanged)
              if (fw && fw.writable) {
                await fw.writable.close();
                setMessages((p) => [
                  ...p,
                  {
                    type: "system",
                    text: `Downloaded: ${fileMetaRef.current[fileId].name}`,
                  },
                ]);
                await deleteFileIndexedDB(fileId);
              } else {
                const chunksArr = await readAllChunksIndexedDB(
                  fileId,
                  totalChunks,
                );
                if (chunksArr.length === totalChunks) {
                  const blob = new Blob(chunksArr, {
                    type: fileMetaRef.current[fileId].type,
                  });
                  const a = document.createElement("a");
                  a.href = URL.createObjectURL(blob);
                  a.download = fileMetaRef.current[fileId].name || "download";
                  a.click();
                  URL.revokeObjectURL(a.href);
                  setMessages((p) => [
                    ...p,
                    {
                      type: "system",
                      text: `Downloaded: ${fileMetaRef.current[fileId].name}`,
                    },
                  ]);
                  await deleteFileIndexedDB(fileId);
                } else {
                  setError("Error assembling file from storage.");
                }
              }
              delete fileMetaRef.current[fileId];
              delete receivedCountRef.current[fileId];
              delete fileWriterMapRef.current[fileId];
              delete isFinalizingRef.current[fileId];
              setTimeout(() => {
                setTransferStats(null);
                setSpeedData([]);
              }, 5000);
            }
          }
        } catch (e) {
          log("Error handling incoming file channel message", e.message);
          setError("File receive error: " + e.message);
        }
      };
      channel.onclose = () => log("File channel closed");
      channel.onerror = (e) => log("File channel error", e);
    },
    [log],
  );

  const createPeerConnection = useCallback(
    async (isOfferer) => {
      if (peerConnectionRef.current) peerConnectionRef.current.close();
      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
        ],
      });
      peerConnectionRef.current = pc;
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socketRef.current.emit("ice-candidate", {
            roomId: roomIdRef.current,
            candidate: event.candidate,
          });
        }
      };
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
          if (pc.connectionState !== "closed") setError("Connection lost");
        }
      };
      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === "failed") {
          pc.restartIce();
        }
      };
      if (isOfferer) {
        const chatChannel = pc.createDataChannel("chat");
        setupChatChannel(chatChannel);
        const fileChannel = pc.createDataChannel("file", { ordered: true });
        fileChannel.bufferedAmountLowThreshold = CHUNK_SIZE;
        setupFileChannel(fileChannel);
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socketRef.current.emit("offer", {
            roomId: roomIdRef.current,
            offer: pc.localDescription,
          });
        } catch (e) {
          setError("Failed to create connection offer");
        }
      } else {
        pc.ondatachannel = (event) => {
          if (event.channel.label === "chat") setupChatChannel(event.channel);
          else if (event.channel.label === "file") {
            event.channel.bufferedAmountLowThreshold = CHUNK_SIZE;
            setupFileChannel(event.channel);
          }
        };
      }
    },
    [log, setupFileChannel],
  );

  // Condensed setupChatChannel and cleanupPeerConnection, logic is unchanged
  const setupChatChannel = (channel) => {
    dataChannelRef.current = channel;
    channel.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type === "message")
          setMessages((p) => [...p, { type: "received", text: data.text }]);
      } catch (e) {}
    };
  };
  const cleanupPeerConnection = () => {
    pendingIceCandidatesRef.current = [];
    if (dataChannelRef.current) dataChannelRef.current.close();
    dataChannelRef.current = null;
    if (fileChannelRef.current) fileChannelRef.current.close();
    fileChannelRef.current = null;
    if (peerConnectionRef.current) peerConnectionRef.current.close();
    peerConnectionRef.current = null;
    setPeerConnected(false);
  };

  const sendWithBackpressure = (channel, data) => {
    return new Promise((resolve, reject) => {
      const trySend = () => {
        if (channel.readyState !== "open") {
          return reject(new Error("Data channel is not open."));
        }
        if (channel.bufferedAmount < SENDER_MAX_BUFFER) {
          try {
            channel.send(data);
            resolve();
          } catch (e) {
            reject(e);
          }
        } else {
          channel.addEventListener("bufferedamountlow", () => trySend(), {
            once: true,
          });
        }
      };
      trySend();
    });
  };

  const joinRoom = useCallback(() => {
    if (!roomName.trim() || !serverOnline) return;
    const socket = socketRef.current;
    if (!socket) return;
    if (!socket.connected) socket.connect();
    socket.emit("join-room", { roomId: roomName, userId: socket.id });
    setError("Joining room...");
  }, [roomName, serverOnline]);

  const sendMessage = useCallback(() => {
    if (!messageInput.trim() || dataChannelRef.current?.readyState !== "open")
      return;
    dataChannelRef.current.send(
      JSON.stringify({ type: "message", text: messageInput }),
    );
    setMessages((p) => [...p, { type: "sent", text: messageInput }]);
    setMessageInput("");
  }, [messageInput]);

  const sendFile = useCallback(
    async (file) => {
      if (!file || fileChannelRef.current?.readyState !== "open") return;
      log("Starting file transfer", { name: file.name, size: file.size });
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      const fileId = `${Date.now()}-${file.name}`;
      const metadata = {
        fileId,
        name: file.name,
        size: file.size,
        type: file.type,
        chunks: totalChunks,
      };
      fileChannelRef.current.send(JSON.stringify(metadata));

      const startTime = Date.now();
      let sentBytes = 0;
      setTransferStats({
        fileName: file.name,
        totalSize: file.size,
        sentSize: 0,
        progress: 0,
        speed: 0,
        chunks: 0,
        totalChunks,
      });
      setSpeedData([]);

      for (let index = 0; index < totalChunks; index++) {
        const offset = index * CHUNK_SIZE;
        const slice = file.slice(offset, offset + CHUNK_SIZE);
        const arrayBuffer = await slice.arrayBuffer();
        try {
          await sendWithBackpressure(fileChannelRef.current, arrayBuffer);
        } catch (e) {
          setError("Failed to send chunk: " + e.message);
          setTransferStats(null);
          return;
        }
        sentBytes += arrayBuffer.byteLength;
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = sentBytes / Math.max(elapsed, 0.001);
        const progress = (sentBytes / file.size) * 100;
        setTransferStats((prev) => ({
          ...prev,
          sentSize: sentBytes,
          progress,
          speed,
          chunks: index + 1,
        }));

        // --- 🔧 FIX: Store numeric data for growing chart axis ---
        setSpeedData((prev) => [
          ...prev,
          {
            time: parseFloat(elapsed.toFixed(1)),
            speed: parseFloat((speed / 1024 / 1024).toFixed(2)),
          },
        ]);
      }
      log("File transfer complete");
      setMessages((p) => [
        ...p,
        { type: "system", text: `Sent: ${file.name}` },
      ]);
      setTimeout(() => {
        setTransferStats(null);
        setSpeedData([]);
      }, 5000);
    },
    [log],
  );

  const getConnectionColor = () => {
    if (!isConnected)
      return "from-slate-800/20 to-slate-900/20 border-slate-700";
    switch (connectionState) {
      case "connected":
        return "from-emerald-500/30 to-teal-500/30 border-emerald-400/50";
      case "connecting":
        return "from-amber-500/30 to-orange-500/30 border-amber-400/50";
      case "waiting":
        return "from-blue-500/30 to-cyan-500/30 border-blue-400/50";
      default:
        return "from-red-500/30 to-rose-500/30 border-red-400/50";
    }
  };

  // --- ✨ UX: Add Drag and Drop Effect ---
  useEffect(() => {
    const handleDragOver = (e) => {
      e.preventDefault();
      if (peerConnected) setIsDragging(true);
    };
    const handleDragLeave = (e) => {
      e.preventDefault();
      setIsDragging(false);
    };
    const handleDrop = (e) => {
      e.preventDefault();
      setIsDragging(false);
      if (
        e.dataTransfer.files?.[0] &&
        peerConnected &&
        fileChannelRef.current?.readyState === "open"
      ) {
        sendFile(e.dataTransfer.files[0]);
      }
    };
    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("drop", handleDrop);
    return () => {
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("dragleave", handleDragLeave);
      window.removeEventListener("drop", handleDrop);
    };
  }, [peerConnected, sendFile]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 font-sans p-4 sm:p-6 lg:p-8">
      <style>{`
        .liquid-glass {
          background: rgba(15, 23, 42, 0.6);
          backdrop-filter: blur(30px);
          border: 1px solid rgba(255, 255, 255, 0.1);
          box-shadow: 0 8px 32px rgba(2, 6, 23, 0.5);
          transition: background 0.3s ease, border 0.3s ease;
        }
        .recharts-tooltip-cursor { stroke: rgba(59, 130, 246, 0.5); stroke-width: 1; }
      `}</style>

      {/* Background Blobs */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none z-0">
        <motion.div
          animate={{
            x: [-100, 100, -100],
            y: [-100, 100, -100],
            rotate: [0, 180, 360],
            scale: [1, 1.2, 1],
          }}
          transition={{ duration: 40, repeat: Infinity, ease: "easeInOut" }}
          className="absolute top-1/4 left-1/4 w-96 h-96 bg-blue-900/50 rounded-full blur-3xl"
        />
        <motion.div
          animate={{
            x: [100, -100, 100],
            y: [100, -100, 100],
            rotate: [360, 180, 0],
            scale: [1.2, 1, 1.2],
          }}
          transition={{ duration: 50, repeat: Infinity, ease: "easeInOut" }}
          className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-cyan-900/50 rounded-full blur-3xl"
        />
      </div>

      <AnimatePresence>
        {isDragging && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-md"
          >
            <div className="flex flex-col items-center gap-4 p-12 border-2 border-dashed border-cyan-400 rounded-3xl">
              <Upload className="w-16 h-16 text-cyan-400" />
              <p className="text-xl font-bold">Drop File to Send</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="max-w-7xl mx-auto relative z-10">
        <header className="liquid-glass rounded-3xl p-4 sm:p-6 mb-6">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-2xl bg-gradient-to-br from-blue-500/20 to-cyan-500/20 border border-blue-400/30">
                <Users className="w-8 h-8 text-blue-300" />
              </div>
              <div>
                <h1 className="text-2xl sm:text-3xl font-bold bg-gradient-to-r from-blue-400 to-cyan-300 bg-clip-text text-transparent">
                  P2P File Transfer
                </h1>
                <p className="text-xs sm:text-sm text-slate-400 mt-1">
                  Secure & Resilient WebRTC Sharing
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 sm:gap-4">
              <button
                onClick={checkServerStatus}
                className={`flex items-center gap-2 px-3 py-2 rounded-xl liquid-glass transition-all ${serverOnline ? "text-emerald-400" : "text-red-400"}`}
              >
                {serverOnline ? (
                  <Wifi className="w-5 h-5" />
                ) : (
                  <WifiOff className="w-5 h-5" />
                )}
                <span className="hidden sm:inline text-sm font-medium">
                  {serverOnline ? "Online" : "Offline"}
                </span>
              </button>
              {roomName && isConnected && (
                <div className="liquid-glass px-4 py-2 rounded-xl">
                  <div className="text-xs text-slate-400">Room</div>
                  <div className="font-mono text-blue-300">{roomName}</div>
                </div>
              )}
            </div>
          </div>
        </header>

        <main>
          {!isConnected ? (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex items-center justify-center min-h-[60vh]"
            >
              <div className="w-full max-w-md liquid-glass rounded-3xl p-8">
                <div className="text-center mb-6">
                  <motion.div
                    animate={{ scale: [1, 1.1, 1] }}
                    transition={{
                      duration: 2,
                      repeat: Infinity,
                      ease: "easeInOut",
                    }}
                  >
                    <Activity className="w-16 h-16 mx-auto mb-4 text-blue-400" />
                  </motion.div>
                  <h2 className="text-2xl font-bold mb-2">Join a Room</h2>
                  <p className="text-sm text-slate-400">
                    Enter a room name to connect with a peer.
                  </p>
                </div>
                <div className="flex gap-2">
                  <input
                    value={roomName}
                    onChange={(e) => setRoomName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && joinRoom()}
                    placeholder="Enter room name..."
                    className="flex-1 px-4 py-3 rounded-xl bg-slate-900/70 border border-white/10 focus:outline-none focus:border-blue-400/50 transition"
                    disabled={!serverOnline}
                  />
                  <button
                    onClick={joinRoom}
                    disabled={!serverOnline || !roomName.trim()}
                    className="px-5 py-3 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-500 hover:to-cyan-400 transition disabled:opacity-50 disabled:cursor-not-allowed font-medium"
                  >
                    <Zap />
                  </button>
                </div>
                {error && (
                  <div className="mt-4 p-3 rounded-xl bg-amber-500/10 border border-amber-400/30 text-amber-300 text-sm flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 flex-shrink-0" />
                    <span>{error}</span>
                  </div>
                )}
              </div>
            </motion.div>
          ) : (
            <>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className={`liquid-glass rounded-2xl p-4 mb-6 shadow-xl bg-gradient-to-r border ${getConnectionColor()}`}
              >
                <div className="flex items-center gap-3">
                  <motion.div
                    animate={{ scale: peerConnected ? [1, 1.2, 1] : 1 }}
                    transition={{ duration: 1.5, repeat: Infinity }}
                    className={`w-3 h-3 rounded-full ${peerConnected ? "bg-emerald-400" : "bg-slate-600"}`}
                  />
                  <div>
                    <div className="font-medium text-slate-100">
                      {peerConnected
                        ? "Connected to Peer"
                        : connectionState === "waiting"
                          ? "Waiting for Peer"
                          : "Connecting..."}
                    </div>
                    <div className="text-xs text-slate-400">
                      State: {connectionState}
                    </div>
                  </div>
                </div>
              </motion.div>

              <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
                <motion.section
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="lg:col-span-3 flex flex-col liquid-glass rounded-2xl h-[70vh] overflow-hidden"
                >
                  <div className="p-4 border-b border-white/5">
                    <h3 className="font-semibold text-lg">Chat</h3>
                  </div>
                  <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    <AnimatePresence>
                      {messages.map((m, i) => (
                        <motion.div
                          key={i}
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0 }}
                          className={`flex ${m.type === "sent" ? "justify-end" : m.type === "system" ? "justify-center" : "justify-start"}`}
                        >
                          <div
                            className={`max-w-xs px-4 py-2 rounded-2xl ${m.type === "sent" ? "bg-gradient-to-r from-blue-600 to-cyan-500" : m.type === "system" ? "bg-white/5 text-slate-300 text-xs" : "bg-slate-700/80"}`}
                          >
                            {m.text}
                          </div>
                        </motion.div>
                      ))}
                    </AnimatePresence>
                  </div>
                  <div className="p-4 border-t border-white/5">
                    <div className="flex gap-2">
                      <input
                        value={messageInput}
                        onChange={(e) => setMessageInput(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && sendMessage()}
                        placeholder="Type a message..."
                        disabled={
                          !peerConnected ||
                          dataChannelRef.current?.readyState !== "open"
                        }
                        className="flex-1 px-4 py-3 rounded-xl bg-slate-900/70 border border-white/10 focus:outline-none focus:border-blue-400/50 transition disabled:opacity-50"
                      />
                      <button
                        onClick={sendMessage}
                        disabled={
                          !peerConnected ||
                          !messageInput.trim() ||
                          dataChannelRef.current?.readyState !== "open"
                        }
                        className="px-4 py-3 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-500 hover:to-cyan-400 transition disabled:opacity-50"
                      >
                        <Send className="w-5 h-5" />
                      </button>
                    </div>
                  </div>
                </motion.section>

                <motion.aside
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="lg:col-span-2 space-y-6"
                >
                  <div className="liquid-glass rounded-2xl p-6">
                    <h3 className="font-semibold mb-4 text-lg">Send File</h3>
                    <input
                      id="file-input"
                      type="file"
                      className="hidden"
                      onChange={(e) => sendFile(e.target.files[0])}
                      disabled={
                        !peerConnected ||
                        fileChannelRef.current?.readyState !== "open"
                      }
                    />
                    <label
                      htmlFor="file-input"
                      className={`flex items-center justify-center gap-3 w-full py-4 rounded-xl cursor-pointer transition-all ${peerConnected && fileChannelRef.current?.readyState === "open" ? "bg-blue-600/80 hover:bg-blue-600" : "bg-slate-700 opacity-50 cursor-not-allowed"}`}
                    >
                      <Upload className="w-5 h-5" />
                      <span className="font-medium">Choose File</span>
                    </label>
                    <p className="text-xs text-slate-400 mt-3 text-center">
                      {peerConnected
                        ? "Or drag & drop anywhere"
                        : "Connect to a peer to send files"}
                    </p>
                  </div>

                  <AnimatePresence>
                    {transferStats && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        className="liquid-glass rounded-2xl p-6 overflow-hidden"
                      >
                        <div className="flex items-center gap-3 mb-4">
                          <Download className="w-5 h-5 text-blue-400" />
                          <h4 className="font-medium">Transfer In Progress</h4>
                        </div>
                        <p className="text-sm text-slate-300 truncate mb-4 font-mono text-center">
                          {transferStats.fileName}
                        </p>

                        <div className="flex justify-center mb-4">
                          <RadialProgress progress={transferStats.progress} />
                        </div>

                        <div className="grid grid-cols-2 gap-4 text-sm text-center mb-4">
                          <div>
                            <div className="text-slate-400 text-xs mb-1">
                              Speed
                            </div>
                            <div className="font-mono font-medium text-lg">
                              <AnimatedStat
                                value={(
                                  (transferStats.speed || 0) /
                                  1024 /
                                  1024
                                ).toFixed(2)}
                                unit=" MB/s"
                              />
                            </div>
                          </div>
                          <div>
                            <div className="text-slate-400 text-xs mb-1">
                              Chunks
                            </div>
                            <div className="font-mono font-medium text-lg">
                              <AnimatedStat
                                value={`${transferStats.chunks}/${transferStats.totalChunks}`}
                                unit=""
                              />
                            </div>
                          </div>
                          <div>
                            <div className="text-slate-400 text-xs mb-1">
                              Transferred
                            </div>
                            <div className="font-mono font-medium text-lg">
                              <AnimatedStat
                                value={(
                                  (transferStats.sentSize ||
                                    transferStats.receivedSize ||
                                    0) /
                                  1024 /
                                  1024
                                ).toFixed(2)}
                                unit=" MB"
                              />
                            </div>
                          </div>
                          <div>
                            <div className="text-slate-400 text-xs mb-1">
                              Total Size
                            </div>
                            <div className="font-mono font-medium text-lg">
                              <AnimatedStat
                                value={(
                                  transferStats.totalSize /
                                  1024 /
                                  1024
                                ).toFixed(2)}
                                unit=" MB"
                              />
                            </div>
                          </div>
                        </div>

                        {speedData.length > 1 && (
                          <div className="mt-4 bg-slate-900/70 p-3 rounded-xl">
                            <ResponsiveContainer width="100%" height={140}>
                              <LineChart
                                data={speedData}
                                margin={{
                                  top: 5,
                                  right: 20,
                                  left: -10,
                                  bottom: 5,
                                }}
                              >
                                <CartesianGrid
                                  strokeDasharray="3 3"
                                  stroke="rgba(255,255,255,0.1)"
                                />
                                {/* 🔧 FIX: Added type="number" and domain for growing axis */}
                                <XAxis
                                  type="number"
                                  dataKey="time"
                                  stroke="rgba(255,255,255,0.4)"
                                  fontSize={10}
                                  domain={["dataMin", "dataMax"]}
                                  tickFormatter={(value) => `${value}s`}
                                />
                                <YAxis
                                  stroke="rgba(255,255,255,0.4)"
                                  fontSize={10}
                                  unit="MB/s"
                                />
                                <Tooltip
                                  contentStyle={{
                                    backgroundColor: "rgba(15, 23, 42, 0.8)",
                                    border: "1px solid rgba(255,255,255,0.1)",
                                    borderRadius: 8,
                                    color: "#fff",
                                  }}
                                />
                                <Line
                                  type="monotone"
                                  dataKey="speed"
                                  name="Speed"
                                  stroke="#3b82f6"
                                  strokeWidth={2}
                                  dot={false}
                                />
                              </LineChart>
                            </ResponsiveContainer>
                          </div>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.aside>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
