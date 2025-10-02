import React, { useState, useEffect, useRef } from "react";
import {
  Send,
  Wifi,
  WifiOff,
  Upload,
  Download,
  Users,
  AlertCircle,
  CheckCircle,
  Loader,
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
import io from "socket.io-client";

const CHUNK_SIZE = 256 * 1024; // chunks size
const SERVER_URL = "http://localhost:3001";

export default function P2PFileSharing() {
  const [roomName, setRoomName] = useState("");
  const [isConnected, setIsConnected] = useState(false);
  const [peerConnected, setPeerConnected] = useState(false);
  const [serverOnline, setServerOnline] = useState(false);
  const [messages, setMessages] = useState([]);
  const [messageInput, setMessageInput] = useState("");
  const [peerStatus, setPeerStatus] = useState("offline");
  const [myStatus, setMyStatus] = useState("idle");
  const [transferStats, setTransferStats] = useState(null);
  const [speedData, setSpeedData] = useState([]);
  const [error, setError] = useState("");

  const socketRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const dataChannelRef = useRef(null);
  const fileChannelRef = useRef(null);
  const peerIdRef = useRef(null);
  const fileBufferRef = useRef([]);
  const receivedSizeRef = useRef(0);
  const startTimeRef = useRef(0);
  const fileMetadataRef = useRef(null);

  // Check server status
  const checkServerStatus = async () => {
    try {
      const response = await fetch(`${SERVER_URL}/health`);
      const data = await response.json();
      setServerOnline(data.status === "online");
      setError("");
    } catch (err) {
      setServerOnline(false);
      setError("Cannot connect to server");
    }
  };

  useEffect(() => {
    checkServerStatus();
    const interval = setInterval(checkServerStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  // Initialize Socket.io
  const initializeSocket = () => {
    socketRef.current = io(SERVER_URL);

    socketRef.current.on("connect", () => {
      console.log("Connected to signaling server");
    });

    socketRef.current.on("waiting-for-peer", () => {
      setError("Waiting for peer to join...");
    });

    socketRef.current.on("room-full", () => {
      setError("Room is full! Try a different room name.");
      setIsConnected(false);
    });

    socketRef.current.on("peer-joined", ({ peerId }) => {
      console.log("Peer joined:", peerId);
      peerIdRef.current = peerId;
      createPeerConnection(true);
    });

    socketRef.current.on("webrtc-offer", ({ offer, from }) => {
      peerIdRef.current = from;
      createPeerConnection(false);
      peerConnectionRef.current
        .setRemoteDescription(new RTCSessionDescription(offer))
        .then(() => peerConnectionRef.current.createAnswer())
        .then((answer) => peerConnectionRef.current.setLocalDescription(answer))
        .then(() => {
          socketRef.current.emit("webrtc-answer", {
            answer: peerConnectionRef.current.localDescription,
            to: from,
          });
        });
    });

    socketRef.current.on("webrtc-answer", ({ answer }) => {
      peerConnectionRef.current.setRemoteDescription(
        new RTCSessionDescription(answer),
      );
    });

    socketRef.current.on("ice-candidate", ({ candidate }) => {
      peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
    });

    socketRef.current.on("peer-status", ({ status }) => {
      setPeerStatus(status);
    });

    socketRef.current.on("peer-disconnected", () => {
      setPeerConnected(false);
      setPeerStatus("offline");
      setMessages((prev) => [
        ...prev,
        { type: "system", text: "Peer disconnected" },
      ]);
    });
  };

  // Create WebRTC connection
  const createPeerConnection = (isInitiator) => {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socketRef.current.emit("ice-candidate", {
          candidate: event.candidate,
          to: peerIdRef.current,
        });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log("Connection state:", pc.connectionState);
      if (pc.connectionState === "connected") {
        setPeerConnected(true);
        setError("");
        setMessages((prev) => [
          ...prev,
          { type: "system", text: "Connected to peer!" },
        ]);
      } else if (
        pc.connectionState === "disconnected" ||
        pc.connectionState === "failed"
      ) {
        setPeerConnected(false);
      }
    };

    // Chat channel
    if (isInitiator) {
      const chatChannel = pc.createDataChannel("chat");
      setupChatChannel(chatChannel);

      const fileChannel = pc.createDataChannel("file", { ordered: true });
      setupFileChannel(fileChannel);
    } else {
      pc.ondatachannel = (event) => {
        if (event.channel.label === "chat") {
          setupChatChannel(event.channel);
        } else if (event.channel.label === "file") {
          setupFileChannel(event.channel);
        }
      };
    }

    peerConnectionRef.current = pc;

    if (isInitiator) {
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => {
          socketRef.current.emit("webrtc-offer", {
            offer: pc.localDescription,
            to: peerIdRef.current,
          });
        });
    }
  };

  const setupChatChannel = (channel) => {
    dataChannelRef.current = channel;

    channel.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === "message") {
        setMessages((prev) => [...prev, { type: "received", text: data.text }]);
      } else if (data.type === "typing") {
        setPeerStatus("typing");
        setTimeout(() => setPeerStatus("idle"), 2000);
      }
    };

    channel.onopen = () => console.log("Chat channel opened");
    channel.onclose = () => console.log("Chat channel closed");
  };

  const setupFileChannel = (channel) => {
    fileChannelRef.current = channel;

    channel.onmessage = (event) => {
      if (typeof event.data === "string") {
        const metadata = JSON.parse(event.data);
        fileMetadataRef.current = metadata;
        fileBufferRef.current = [];
        receivedSizeRef.current = 0;
        startTimeRef.current = Date.now();

        setTransferStats({
          fileName: metadata.name,
          totalSize: metadata.size,
          receivedSize: 0,
          progress: 0,
          speed: 0,
          chunks: 0,
          totalChunks: metadata.chunks,
        });
        setSpeedData([]);
      } else {
        fileBufferRef.current.push(event.data);
        receivedSizeRef.current += event.data.byteLength;

        const elapsed = (Date.now() - startTimeRef.current) / 1000;
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
          {
            time: elapsed.toFixed(1),
            speed: (speed / 1024 / 1024).toFixed(2),
          },
        ]);

        if (receivedSizeRef.current === fileMetadataRef.current.size) {
          saveFile();
        }
      }
    };
  };

  const saveFile = () => {
    const blob = new Blob(fileBufferRef.current);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileMetadataRef.current.name;
    a.click();
    URL.revokeObjectURL(url);

    setMessages((prev) => [
      ...prev,
      {
        type: "system",
        text: `Downloaded: ${fileMetadataRef.current.name}`,
      },
    ]);

    setTimeout(() => {
      setTransferStats(null);
      setSpeedData([]);
    }, 3000);
  };

  const joinRoom = () => {
    if (!roomName.trim() || !serverOnline) return;

    initializeSocket();
    socketRef.current.emit("join-room", roomName);
    setIsConnected(true);
    setError("");
  };

  const sendMessage = () => {
    if (!messageInput.trim() || !peerConnected) return;

    dataChannelRef.current.send(
      JSON.stringify({
        type: "message",
        text: messageInput,
      }),
    );

    setMessages((prev) => [...prev, { type: "sent", text: messageInput }]);
    setMessageInput("");
    updateStatus("idle");
  };

  const handleTyping = () => {
    if (peerConnected && dataChannelRef.current) {
      dataChannelRef.current.send(JSON.stringify({ type: "typing" }));
    }
  };

  const updateStatus = (status) => {
    setMyStatus(status);
    if (socketRef.current && peerIdRef.current) {
      socketRef.current.emit("status-update", {
        status,
        to: peerIdRef.current,
      });
    }
  };

  const sendFile = async (file) => {
    if (!peerConnected || !file) return;

    updateStatus("sending-file");

    const chunks = Math.ceil(file.size / CHUNK_SIZE);
    const metadata = {
      name: file.name,
      size: file.size,
      type: file.type,
      chunks,
    };

    fileChannelRef.current.send(JSON.stringify(metadata));

    let offset = 0;
    const reader = new FileReader();

    const readSlice = () => {
      const slice = file.slice(offset, offset + CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);
    };

    reader.onload = (e) => {
      fileChannelRef.current.send(e.target.result);
      offset += e.target.result.byteLength;

      if (offset < file.size) {
        readSlice();
      } else {
        setMessages((prev) => [
          ...prev,
          { type: "system", text: `Sent: ${file.name}` },
        ]);
        updateStatus("idle");
      }
    };

    readSlice();
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 text-white p-4">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6 bg-white/10 backdrop-blur-lg rounded-2xl p-4 border border-white/20">
          <div className="flex items-center gap-3">
            <div className="bg-gradient-to-r from-purple-500 to-pink-500 p-3 rounded-xl">
              <Users className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">P2P File Share</h1>
              <p className="text-sm text-gray-300">
                Secure peer-to-peer transfer
              </p>
            </div>
          </div>

          <button
            onClick={checkServerStatus}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-all ${
              serverOnline
                ? "bg-green-500/20 text-green-300 hover:bg-green-500/30"
                : "bg-red-500/20 text-red-300 hover:bg-red-500/30"
            }`}
          >
            {serverOnline ? (
              <Wifi className="w-5 h-5" />
            ) : (
              <WifiOff className="w-5 h-5" />
            )}
            <span className="font-medium">
              {serverOnline ? "Server Online" : "Server Offline"}
            </span>
          </button>
        </div>

        {!isConnected ? (
          <div className="flex items-center justify-center min-h-[70vh]">
            <div className="bg-white/10 backdrop-blur-xl rounded-3xl p-8 border border-white/20 max-w-md w-full transform hover:scale-105 transition-transform">
              <div className="text-center mb-6">
                <div className="bg-gradient-to-r from-purple-500 to-pink-500 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Users className="w-8 h-8" />
                </div>
                <h2 className="text-3xl font-bold mb-2">Join a Room</h2>
                <p className="text-gray-300">
                  Enter a room name to connect with a peer
                </p>
              </div>

              <input
                type="text"
                placeholder="e.g., physics-123"
                value={roomName}
                onChange={(e) => setRoomName(e.target.value)}
                onKeyPress={(e) => e.key === "Enter" && joinRoom()}
                className="w-full bg-white/10 border border-white/20 rounded-xl px-4 py-3 mb-4 focus:outline-none focus:ring-2 focus:ring-purple-500 transition-all"
                disabled={!serverOnline}
              />

              <button
                onClick={joinRoom}
                disabled={!serverOnline || !roomName.trim()}
                className="w-full bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 disabled:from-gray-500 disabled:to-gray-600 rounded-xl py-3 font-semibold transition-all transform hover:scale-105 disabled:scale-100 disabled:cursor-not-allowed"
              >
                {serverOnline ? "Connect" : "Server Offline"}
              </button>

              {error && (
                <div className="mt-4 flex items-center gap-2 text-yellow-300 bg-yellow-500/20 rounded-lg p-3">
                  <AlertCircle className="w-5 h-5 flex-shrink-0" />
                  <span className="text-sm">{error}</span>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Status Bar */}
            <div className="lg:col-span-3 bg-white/10 backdrop-blur-lg rounded-2xl p-4 border border-white/20">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2">
                    <div
                      className={`w-3 h-3 rounded-full ${peerConnected ? "bg-green-400 animate-pulse" : "bg-gray-400"}`}
                    ></div>
                    <span className="font-medium">
                      {peerConnected ? "Connected" : "Connecting..."}
                    </span>
                  </div>
                  <div className="h-6 w-px bg-white/20"></div>
                  <div className="text-sm text-gray-300">
                    Room:{" "}
                    <span className="font-mono text-purple-300">
                      {roomName}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-4 text-sm">
                  <div>
                    You:{" "}
                    <span className="text-purple-300 capitalize">
                      {myStatus}
                    </span>
                  </div>
                  <div>
                    Peer:{" "}
                    <span
                      className={`capitalize ${peerStatus === "offline" ? "text-red-300" : "text-green-300"}`}
                    >
                      {peerStatus}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Chat Section */}
            <div className="lg:col-span-2 bg-white/10 backdrop-blur-lg rounded-2xl border border-white/20 flex flex-col h-[600px]">
              <div className="p-4 border-b border-white/20">
                <h3 className="font-semibold text-lg">Chat</h3>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {messages.map((msg, idx) => (
                  <div
                    key={idx}
                    className={`flex ${msg.type === "sent" ? "justify-end" : msg.type === "system" ? "justify-center" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-xs px-4 py-2 rounded-2xl ${
                        msg.type === "sent"
                          ? "bg-gradient-to-r from-purple-500 to-pink-500"
                          : msg.type === "system"
                            ? "bg-white/10 text-gray-300 text-sm"
                            : "bg-white/20"
                      }`}
                    >
                      {msg.text}
                    </div>
                  </div>
                ))}
              </div>

              <div className="p-4 border-t border-white/20">
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="Type a message..."
                    value={messageInput}
                    onChange={(e) => {
                      setMessageInput(e.target.value);
                      handleTyping();
                    }}
                    onKeyPress={(e) => e.key === "Enter" && sendMessage()}
                    disabled={!peerConnected}
                    className="flex-1 bg-white/10 border border-white/20 rounded-xl px-4 py-2 focus:outline-none focus:ring-2 focus:ring-purple-500 disabled:opacity-50"
                  />
                  <button
                    onClick={sendMessage}
                    disabled={!peerConnected || !messageInput.trim()}
                    className="bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 disabled:from-gray-500 disabled:to-gray-600 rounded-xl px-4 py-2 transition-all disabled:cursor-not-allowed"
                  >
                    <Send className="w-5 h-5" />
                  </button>
                </div>
              </div>
            </div>

            {/* File Transfer Section */}
            <div className="space-y-6">
              <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-4 border border-white/20">
                <h3 className="font-semibold text-lg mb-4">Send File</h3>
                <input
                  type="file"
                  onChange={(e) => sendFile(e.target.files[0])}
                  disabled={!peerConnected}
                  className="hidden"
                  id="file-input"
                />
                <label
                  htmlFor="file-input"
                  className={`flex items-center justify-center gap-2 bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 rounded-xl px-4 py-3 cursor-pointer transition-all ${
                    !peerConnected && "opacity-50 cursor-not-allowed"
                  }`}
                >
                  <Upload className="w-5 h-5" />
                  <span className="font-medium">Choose File</span>
                </label>
              </div>

              {transferStats && (
                <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-4 border border-white/20 animate-in fade-in">
                  <div className="flex items-center gap-2 mb-4">
                    <Download className="w-5 h-5 text-green-400 animate-bounce" />
                    <h3 className="font-semibold">Receiving File</h3>
                  </div>

                  <div className="space-y-3">
                    <div className="text-sm text-gray-300 truncate">
                      {transferStats.fileName}
                    </div>

                    <div className="bg-white/10 rounded-full h-2 overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-green-500 to-emerald-500 transition-all duration-300"
                        style={{ width: `${transferStats.progress}%` }}
                      ></div>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <div className="text-gray-400">Progress</div>
                        <div className="font-mono">
                          {transferStats.progress.toFixed(1)}%
                        </div>
                      </div>
                      <div>
                        <div className="text-gray-400">Speed</div>
                        <div className="font-mono">
                          {(transferStats.speed / 1024 / 1024).toFixed(2)} MB/s
                        </div>
                      </div>
                      <div>
                        <div className="text-gray-400">Chunks</div>
                        <div className="font-mono">
                          {transferStats.chunks}/{transferStats.totalChunks}
                        </div>
                      </div>
                      <div>
                        <div className="text-gray-400">Size</div>
                        <div className="font-mono">
                          {(transferStats.receivedSize / 1024 / 1024).toFixed(
                            2,
                          )}{" "}
                          MB
                        </div>
                      </div>
                    </div>

                    {speedData.length > 0 && (
                      <div className="bg-white/5 rounded-lg p-2 mt-4">
                        <ResponsiveContainer width="100%" height={150}>
                          <LineChart data={speedData}>
                            <CartesianGrid
                              strokeDasharray="3 3"
                              stroke="rgba(255,255,255,0.1)"
                            />
                            <XAxis
                              dataKey="time"
                              stroke="rgba(255,255,255,0.5)"
                              fontSize={10}
                            />
                            <YAxis
                              stroke="rgba(255,255,255,0.5)"
                              fontSize={10}
                            />
                            <Tooltip
                              contentStyle={{
                                backgroundColor: "rgba(0,0,0,0.8)",
                                border: "none",
                                borderRadius: "8px",
                              }}
                            />
                            <Line
                              type="monotone"
                              dataKey="speed"
                              stroke="#10b981"
                              strokeWidth={2}
                              dot={false}
                            />
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
