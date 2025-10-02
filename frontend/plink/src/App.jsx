import React, { useState, useEffect, useRef } from "react";
import {
  Send,
  Wifi,
  WifiOff,
  Upload,
  Download,
  Users,
  AlertCircle,
  Activity,
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

const CHUNK_SIZE = 256 * 1024;
const SERVER_URL = "http://localhost:3001";

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

  const socketRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const dataChannelRef = useRef(null);
  const fileChannelRef = useRef(null);

  const fileBufferRef = useRef([]);
  const receivedSizeRef = useRef(0);
  const fileMetadataRef = useRef(null);
  const startTimeRef = useRef(0);
  const roomIdRef = useRef(null);

  const log = (message, data = null) => {
    const timestamp = new Date().toISOString().split("T")[1].slice(0, -1);
    console.log(`[${timestamp}] ${message}`, data || "");
  };

  const checkServerStatus = async () => {
    try {
      const res = await fetch(`${SERVER_URL}/health`);
      const data = await res.json();
      setServerOnline(data.status === "online");
      setError("");
      log("Server status check", data);
    } catch (e) {
      setServerOnline(false);
      setError("Cannot contact signaling server");
      log("Server check failed", e.message);
    }
  };

  useEffect(() => {
    checkServerStatus();
    const id = setInterval(checkServerStatus, 10000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    log("Initializing socket connection");
    const socket = io(SERVER_URL, {
      transports: ["websocket", "polling"],
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      log("Socket connected", socket.id);
      setError("");
    });

    socket.on("connect_error", (err) => {
      log("Socket connect_error", err.message);
      setError("Signaling connection error");
    });

    socket.on("waiting-for-peer", () => {
      log("Waiting for peer to join");
      setIsConnected(true);
      setError("Waiting for peer to join...");
      setConnectionState("waiting");
    });

    socket.on("room-full", () => {
      log("Room is full");
      setError("Room is full. Try a different room name.");
      setIsConnected(false);
      setConnectionState("error");
    });

    socket.on("joined-room", ({ room, position }) => {
      log("Joined room", { room, position });
      setIsConnected(true);
      roomIdRef.current = room;
      setError("");
    });

    socket.on("user-connected", ({ userId }) => {
      log("User connected event received", userId);
      setError("Peer joined. Establishing connection...");
      setConnectionState("connecting");

      setTimeout(() => {
        log("Creating peer connection as offerer");
        createPeerConnection(true);
      }, 500);
    });

    socket.on("offer", async ({ offer }) => {
      log("Received WebRTC offer");
      setConnectionState("connecting");

      if (!peerConnectionRef.current) {
        log("Creating peer connection as answerer");
        await createPeerConnection(false);
      }

      try {
        await peerConnectionRef.current.setRemoteDescription(
          new RTCSessionDescription(offer),
        );
        log("Remote description set from offer");

        const answer = await peerConnectionRef.current.createAnswer();
        await peerConnectionRef.current.setLocalDescription(answer);
        log("Created and set local answer");

        socketRef.current.emit("answer", {
          roomId: roomIdRef.current,
          answer: peerConnectionRef.current.localDescription,
        });
        log("Sent answer to peer");
      } catch (e) {
        log("Error handling offer", e.message);
      }
    });

    socket.on("answer", async ({ answer }) => {
      log("Received WebRTC answer");
      if (peerConnectionRef.current) {
        try {
          await peerConnectionRef.current.setRemoteDescription(
            new RTCSessionDescription(answer),
          );
          log("Remote description set from answer");
        } catch (e) {
          log("Error setting remote description", e.message);
        }
      }
    });

    socket.on("ice-candidate", async ({ candidate }) => {
      if (!candidate) return;

      log("Received ICE candidate");
      if (peerConnectionRef.current) {
        try {
          await peerConnectionRef.current.addIceCandidate(
            new RTCIceCandidate(candidate),
          );
          log("ICE candidate added successfully");
        } catch (e) {
          log("Error adding ICE candidate", e.message);
        }
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
      socket.off();
      socket.disconnect();
      cleanupPeerConnection();
    };
  }, []);

  const createPeerConnection = async (isOfferer) => {
    log("Creating peer connection", { isOfferer });

    if (peerConnectionRef.current) {
      log("Closing existing peer connection");
      try {
        peerConnectionRef.current.close();
      } catch (e) {
        log("Error closing existing PC", e.message);
      }
    }

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
    });

    peerConnectionRef.current = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        log("Local ICE candidate generated");
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
          { type: "system", text: "Connected to peer" },
        ]);
      } else if (
        pc.connectionState === "disconnected" ||
        pc.connectionState === "failed"
      ) {
        setPeerConnected(false);
        setError("Connection lost");
      }
    };

    pc.oniceconnectionstatechange = () => {
      log("ICE connection state", pc.iceConnectionState);
    };

    if (isOfferer) {
      log("Setting up data channels as offerer");

      const chatChannel = pc.createDataChannel("chat");
      setupChatChannel(chatChannel);

      const fileChannel = pc.createDataChannel("file", { ordered: true });
      setupFileChannel(fileChannel);

      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        log("Created and set local offer");

        socketRef.current.emit("offer", {
          roomId: roomIdRef.current,
          offer: pc.localDescription,
        });
        log("Sent offer to peer");
      } catch (e) {
        log("Error creating offer", e.message);
      }
    } else {
      log("Waiting for data channels as answerer");
      pc.ondatachannel = (event) => {
        log("Data channel received", event.channel.label);

        if (event.channel.label === "chat") {
          setupChatChannel(event.channel);
        } else if (event.channel.label === "file") {
          setupFileChannel(event.channel);
        }
      };
    }
  };

  const setupChatChannel = (channel) => {
    log("Setting up chat channel");
    dataChannelRef.current = channel;

    channel.onopen = () => {
      log("Chat channel opened");
      setMessages((p) => [
        ...p,
        { type: "system", text: "Chat channel ready" },
      ]);
    };

    channel.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type === "message") {
          log("Received chat message");
          setMessages((p) => [...p, { type: "received", text: data.text }]);
        }
      } catch (e) {
        log("Error parsing chat message", e.message);
      }
    };

    channel.onclose = () => log("Chat channel closed");
    channel.onerror = (e) => log("Chat channel error", e);
  };

  const setupFileChannel = (channel) => {
    log("Setting up file channel");
    fileChannelRef.current = channel;

    channel.onopen = () => {
      log("File channel opened");
      setMessages((p) => [
        ...p,
        { type: "system", text: "File transfer ready" },
      ]);
    };

    channel.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        try {
          const meta = JSON.parse(ev.data);
          log("Received file metadata", meta);
          fileMetadataRef.current = meta;
          fileBufferRef.current = [];
          receivedSizeRef.current = 0;
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
        } catch (e) {
          log("Error parsing file metadata", e.message);
        }
      } else {
        fileBufferRef.current.push(ev.data);
        receivedSizeRef.current += ev.data.byteLength;

        const elapsed = Math.max(
          (Date.now() - startTimeRef.current) / 1000,
          0.001,
        );
        const speed = receivedSizeRef.current / elapsed;
        const progress =
          (receivedSizeRef.current / fileMetadataRef.current.size) * 100;

        setTransferStats((prev) => ({
          ...prev,
          receivedSize: receivedSizeRef.current,
          progress,
          speed,
          chunks: fileBufferRef.current.length,
        }));

        setSpeedData((prev) => [
          ...prev.slice(-20),
          { time: elapsed.toFixed(1), speed: (speed / 1024 / 1024).toFixed(2) },
        ]);

        if (receivedSizeRef.current >= fileMetadataRef.current.size) {
          log("File transfer complete");
          finalizeReceivedFile();
        }
      }
    };

    channel.onclose = () => log("File channel closed");
    channel.onerror = (e) => log("File channel error", e);
  };

  const finalizeReceivedFile = () => {
    log("Finalizing received file");
    const blob = new Blob(fileBufferRef.current);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fileMetadataRef.current.name || "download";
    a.click();
    URL.revokeObjectURL(a.href);

    setMessages((p) => [
      ...p,
      { type: "system", text: `Downloaded: ${fileMetadataRef.current.name}` },
    ]);

    setTimeout(() => {
      setTransferStats(null);
      setSpeedData([]);
    }, 2000);
  };

  const cleanupPeerConnection = () => {
    log("Cleaning up peer connection");

    if (dataChannelRef.current) {
      try {
        dataChannelRef.current.close();
      } catch (e) {}
      dataChannelRef.current = null;
    }

    if (fileChannelRef.current) {
      try {
        fileChannelRef.current.close();
      } catch (e) {}
      fileChannelRef.current = null;
    }

    if (peerConnectionRef.current) {
      try {
        peerConnectionRef.current.close();
      } catch (e) {}
      peerConnectionRef.current = null;
    }

    setPeerConnected(false);
  };

  const joinRoom = () => {
    if (!roomName.trim() || !serverOnline) {
      log("Cannot join - invalid room or server offline");
      return;
    }

    log("Joining room", roomName);
    const socket = socketRef.current;

    if (!socket) {
      log("Socket not initialized");
      return;
    }

    if (!socket.connected) {
      log("Connecting socket first");
      socket.connect();
    }

    socket.emit("join-room", { roomId: roomName, userId: socket.id });
    setError("Joining room...");
  };

  const sendMessage = () => {
    if (
      !messageInput.trim() ||
      !dataChannelRef.current ||
      dataChannelRef.current.readyState !== "open"
    ) {
      return;
    }

    log("Sending message");
    dataChannelRef.current.send(
      JSON.stringify({ type: "message", text: messageInput }),
    );
    setMessages((p) => [...p, { type: "sent", text: messageInput }]);
    setMessageInput("");
  };

  const sendFile = (file) => {
    if (
      !file ||
      !fileChannelRef.current ||
      fileChannelRef.current.readyState !== "open"
    ) {
      log("Cannot send file - channel not ready");
      return;
    }

    log("Starting file transfer", { name: file.name, size: file.size });

    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const metadata = {
      name: file.name,
      size: file.size,
      type: file.type,
      chunks: totalChunks,
    };

    fileChannelRef.current.send(JSON.stringify(metadata));
    log("Sent file metadata");

    let offset = 0;
    const reader = new FileReader();

    reader.onload = (e) => {
      fileChannelRef.current.send(e.target.result);
      offset += e.target.result.byteLength;

      if (offset < file.size) {
        readSlice();
      } else {
        log("File transfer complete");
        setMessages((p) => [
          ...p,
          { type: "system", text: `Sent: ${file.name}` },
        ]);
      }
    };

    const readSlice = () => {
      const slice = file.slice(offset, offset + CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);
    };

    readSlice();
  };

  const getConnectionColor = () => {
    switch (connectionState) {
      case "connected":
        return "from-emerald-500/20 to-teal-500/20 border-emerald-400/30";
      case "connecting":
        return "from-amber-500/20 to-orange-500/20 border-amber-400/30";
      case "waiting":
        return "from-blue-500/20 to-cyan-500/20 border-blue-400/30";
      case "disconnected":
      case "failed":
        return "from-red-500/20 to-rose-500/20 border-red-400/30";
      default:
        return "from-slate-500/20 to-gray-500/20 border-slate-400/30";
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-white p-4 sm:p-6">
      <style>{`
        @keyframes liquid-float {
          0%, 100% { transform: translate(0, 0) rotate(0deg); }
          33% { transform: translate(30px, -30px) rotate(5deg); }
          66% { transform: translate(-20px, 20px) rotate(-5deg); }
        }
        @keyframes pulse-glow {
          0%, 100% { opacity: 0.3; }
          50% { opacity: 0.6; }
        }
        .liquid-glass {
          background: linear-gradient(
            135deg,
            rgba(255, 255, 255, 0.05) 0%,
            rgba(255, 255, 255, 0.02) 100%
          );
          backdrop-filter: blur(20px);
          border: 1px solid rgba(255, 255, 255, 0.08);
        }
        .liquid-blob {
          animation: liquid-float 20s ease-in-out infinite;
        }
        .pulse-glow {
          animation: pulse-glow 2s ease-in-out infinite;
        }
      `}</style>

      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-20 left-20 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl liquid-blob" />
        <div
          className="absolute bottom-20 right-20 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl liquid-blob"
          style={{ animationDelay: "-5s" }}
        />
        <div
          className="absolute top-1/2 left-1/2 w-96 h-96 bg-cyan-500/10 rounded-full blur-3xl liquid-blob"
          style={{ animationDelay: "-10s" }}
        />
      </div>

      <div className="max-w-7xl mx-auto relative z-10">
        <header className="liquid-glass rounded-3xl p-6 mb-6 shadow-2xl">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="p-4 rounded-2xl bg-gradient-to-br from-blue-500/20 to-cyan-500/20 border border-blue-400/30">
                <Users className="w-8 h-8 text-blue-400" />
              </div>
              <div>
                <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-400 to-cyan-400 bg-clip-text text-transparent">
                  P2P File Transfer
                </h1>
                <p className="text-sm text-slate-400 mt-1">
                  Secure WebRTC file sharing
                </p>
              </div>
            </div>

            <div className="flex items-center gap-4">
              <button
                onClick={checkServerStatus}
                className={`flex items-center gap-2 px-4 py-2 rounded-xl liquid-glass transition-all ${
                  serverOnline
                    ? "border-emerald-400/40 text-emerald-400"
                    : "border-red-400/40 text-red-400"
                }`}
              >
                {serverOnline ? (
                  <Wifi className="w-5 h-5" />
                ) : (
                  <WifiOff className="w-5 h-5" />
                )}
                <span className="text-sm font-medium">
                  {serverOnline ? "Server Online" : "Server Offline"}
                </span>
              </button>

              {roomName && (
                <div className="liquid-glass px-4 py-2 rounded-xl border border-blue-400/30">
                  <div className="text-xs text-slate-400">Room</div>
                  <div className="font-mono text-blue-400">{roomName}</div>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className="space-y-6">
          {!isConnected ? (
            <div className="flex items-center justify-center min-h-[70vh]">
              <div className="w-full max-w-md liquid-glass rounded-3xl p-8 shadow-2xl">
                <div className="text-center mb-6">
                  <Activity className="w-16 h-16 mx-auto mb-4 text-blue-400" />
                  <h2 className="text-2xl font-bold mb-2">Join a Room</h2>
                  <p className="text-sm text-slate-400">
                    Enter the same room name on both devices to connect
                  </p>
                </div>

                <input
                  value={roomName}
                  onChange={(e) => setRoomName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && joinRoom()}
                  placeholder="Enter room name..."
                  className="w-full px-4 py-3 rounded-xl bg-black/30 border border-white/10 mb-4 focus:outline-none focus:border-blue-400/50 transition"
                  disabled={!serverOnline}
                />

                <button
                  onClick={joinRoom}
                  disabled={!serverOnline || !roomName.trim()}
                  className="w-full px-4 py-3 rounded-xl bg-gradient-to-r from-blue-500/80 to-cyan-500/80 hover:from-blue-500 hover:to-cyan-500 transition disabled:opacity-50 disabled:cursor-not-allowed font-medium"
                >
                  Connect to Room
                </button>

                {error && (
                  <div className="mt-4 p-3 rounded-xl bg-amber-500/10 border border-amber-400/30 text-amber-300 text-sm flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 flex-shrink-0" />
                    <span>{error}</span>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <>
              <div
                className={`liquid-glass rounded-2xl p-4 shadow-xl bg-gradient-to-r ${getConnectionColor()}`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div
                      className={`w-3 h-3 rounded-full ${
                        peerConnected
                          ? "bg-emerald-400 pulse-glow"
                          : "bg-slate-600"
                      }`}
                    />
                    <div>
                      <div className="font-medium">
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
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <section className="lg:col-span-2 flex flex-col liquid-glass rounded-2xl shadow-xl h-[600px] overflow-hidden">
                  <div className="p-4 border-b border-white/5">
                    <h3 className="font-semibold text-lg">Chat</h3>
                  </div>

                  <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    {messages.map((m, i) => (
                      <div
                        key={i}
                        className={`flex ${
                          m.type === "sent"
                            ? "justify-end"
                            : m.type === "system"
                              ? "justify-center"
                              : "justify-start"
                        }`}
                      >
                        <div
                          className={`max-w-xs px-4 py-2 rounded-2xl ${
                            m.type === "sent"
                              ? "bg-gradient-to-r from-blue-500/60 to-cyan-500/60"
                              : m.type === "system"
                                ? "bg-white/5 text-slate-300 text-sm"
                                : "bg-white/10"
                          }`}
                        >
                          {m.text}
                        </div>
                      </div>
                    ))}
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
                          !dataChannelRef.current ||
                          dataChannelRef.current.readyState !== "open"
                        }
                        className="flex-1 px-4 py-3 rounded-xl bg-black/30 border border-white/10 focus:outline-none focus:border-blue-400/50 transition disabled:opacity-50"
                      />
                      <button
                        onClick={sendMessage}
                        disabled={
                          !peerConnected ||
                          !messageInput.trim() ||
                          !dataChannelRef.current ||
                          dataChannelRef.current.readyState !== "open"
                        }
                        className="px-6 py-3 rounded-xl bg-gradient-to-r from-blue-500/80 to-cyan-500/80 hover:from-blue-500 hover:to-cyan-500 transition disabled:opacity-50"
                      >
                        <Send className="w-5 h-5" />
                      </button>
                    </div>
                  </div>
                </section>

                <aside className="space-y-6">
                  <div className="liquid-glass rounded-2xl p-6 shadow-xl">
                    <h3 className="font-semibold mb-4 text-lg">Send File</h3>
                    <input
                      id="file-input"
                      type="file"
                      className="hidden"
                      onChange={(e) => sendFile(e.target.files[0])}
                      disabled={
                        !peerConnected ||
                        !fileChannelRef.current ||
                        fileChannelRef.current.readyState !== "open"
                      }
                    />
                    <label
                      htmlFor="file-input"
                      className={`flex items-center justify-center gap-3 px-6 py-4 rounded-xl cursor-pointer transition ${
                        peerConnected &&
                        fileChannelRef.current &&
                        fileChannelRef.current.readyState === "open"
                          ? "bg-gradient-to-r from-blue-500/80 to-cyan-500/80 hover:from-blue-500 hover:to-cyan-500"
                          : "opacity-50 cursor-not-allowed bg-slate-700/50"
                      }`}
                    >
                      <Upload className="w-5 h-5" />
                      <span className="font-medium">Choose File</span>
                    </label>
                    <p className="text-xs text-slate-400 mt-3 text-center">
                      {peerConnected
                        ? "Click to select a file to send"
                        : "Connect to peer first"}
                    </p>
                  </div>

                  {transferStats && (
                    <div className="liquid-glass rounded-2xl p-6 shadow-xl border border-blue-400/30">
                      <div className="flex items-center gap-3 mb-4">
                        <Download className="w-5 h-5 text-blue-400" />
                        <h4 className="font-medium">Receiving File</h4>
                      </div>

                      <div className="text-sm text-slate-300 truncate mb-4 font-mono">
                        {transferStats.fileName}
                      </div>

                      <div className="bg-black/30 rounded-full h-3 overflow-hidden mb-4">
                        <div
                          className="h-full bg-gradient-to-r from-blue-500 to-cyan-500 transition-all duration-300"
                          style={{ width: `${transferStats.progress}%` }}
                        />
                      </div>

                      <div className="grid grid-cols-2 gap-4 text-sm">
                        <div>
                          <div className="text-slate-400 text-xs mb-1">
                            Progress
                          </div>
                          <div className="font-mono font-medium">
                            {transferStats.progress.toFixed(1)}%
                          </div>
                        </div>
                        <div>
                          <div className="text-slate-400 text-xs mb-1">
                            Speed
                          </div>
                          <div className="font-mono font-medium">
                            {(transferStats.speed / 1024 / 1024).toFixed(2)}{" "}
                            MB/s
                          </div>
                        </div>
                        <div>
                          <div className="text-slate-400 text-xs mb-1">
                            Chunks
                          </div>
                          <div className="font-mono font-medium">
                            {transferStats.chunks}/{transferStats.totalChunks}
                          </div>
                        </div>
                        <div>
                          <div className="text-slate-400 text-xs mb-1">
                            Received
                          </div>
                          <div className="font-mono font-medium">
                            {(transferStats.receivedSize / 1024 / 1024).toFixed(
                              2,
                            )}{" "}
                            MB
                          </div>
                        </div>
                      </div>

                      {speedData.length > 0 && (
                        <div className="mt-4 bg-black/30 p-3 rounded-xl">
                          <ResponsiveContainer width="100%" height={140}>
                            <LineChart data={speedData}>
                              <CartesianGrid
                                strokeDasharray="3 3"
                                stroke="rgba(255,255,255,0.05)"
                              />
                              <XAxis
                                dataKey="time"
                                stroke="rgba(255,255,255,0.3)"
                                fontSize={10}
                              />
                              <YAxis
                                stroke="rgba(255,255,255,0.3)"
                                fontSize={10}
                              />
                              <Tooltip
                                contentStyle={{
                                  backgroundColor: "rgba(0,0,0,0.9)",
                                  border: "1px solid rgba(255,255,255,0.1)",
                                  borderRadius: 8,
                                }}
                              />
                              <Line
                                type="monotone"
                                dataKey="speed"
                                stroke="#3b82f6"
                                strokeWidth={2}
                                dot={false}
                              />
                            </LineChart>
                          </ResponsiveContainer>
                        </div>
                      )}
                    </div>
                  )}
                </aside>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
