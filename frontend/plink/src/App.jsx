import React, { useState, useEffect, useRef } from "react";
import {
  Send,
  Wifi,
  WifiOff,
  Upload,
  Download,
  Users,
  AlertCircle,
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
const SERVER_URL = "https://plink-revamp-backend.onrender.com";

export default function P2PFileSharing() {
  const [roomName, setRoomName] = useState("");
  const [isConnected, setIsConnected] = useState(false); // server-level joined
  const [peerConnected, setPeerConnected] = useState(false); // WebRTC connected
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

  // Periodically check server health
  const checkServerStatus = async () => {
    try {
      const res = await fetch(`${SERVER_URL}/health`);
      const data = await res.json();
      setServerOnline(data.status === "online");
      setError("");
    } catch (err) {
      setServerOnline(false);
      setError("Cannot connect to server");
    }
  };

  useEffect(() => {
    checkServerStatus();
    const id = setInterval(checkServerStatus, 5000);
    return () => clearInterval(id);
  }, []);

  // create single socket instance once
  useEffect(() => {
    socketRef.current = io(SERVER_URL, {
      autoConnect: false,
      transports: ["websocket", "polling"],
      reconnectionAttempts: 5,
    });

    const s = socketRef.current;

    // attach handlers
    s.on("connect", () => {
      console.log("Connected to signaling server", s.id);
      setError("");
    });

    s.on("connect_error", (err) => {
      console.warn("Socket connect_error:", err?.message || err);
      setError("Signaling server connection error");
    });

    s.on("waiting-for-peer", () => {
      setIsConnected(true);
      setError("Waiting for peer to join...");
    });

    s.on("room-full", () => {
      setError("Room is full! Try a different room name.");
      setIsConnected(false);
      s.disconnect();
    });

    s.on("joined-room", ({ room, position }) => {
      setIsConnected(true);
      setError("");
    });

    s.on("peer-joined", ({ peerId }) => {
      peerIdRef.current = peerId;
      // initiator is the one which joined first? We keep simple: if we are not the second position,
      // create offer as initiator. Server sets peer-joined to both; caller createsOffer true for the peer who got 'peerId' set after both in room.
      createPeerConnection(true);
    });

    s.on("webrtc-offer", ({ offer, from }) => {
      peerIdRef.current = from;
      createPeerConnection(false);
      if (peerConnectionRef.current) {
        peerConnectionRef.current
          .setRemoteDescription(new RTCSessionDescription(offer))
          .then(() => peerConnectionRef.current.createAnswer())
          .then((answer) =>
            peerConnectionRef.current.setLocalDescription(answer),
          )
          .then(() => {
            s.emit("webrtc-answer", {
              answer: peerConnectionRef.current.localDescription,
              to: from,
            });
          })
          .catch((e) => console.error("answer error:", e));
      }
    });

    s.on("webrtc-answer", ({ answer }) => {
      if (peerConnectionRef.current) {
        peerConnectionRef.current.setRemoteDescription(
          new RTCSessionDescription(answer),
        );
      }
    });

    s.on("ice-candidate", ({ candidate }) => {
      if (peerConnectionRef.current && candidate) {
        peerConnectionRef.current.addIceCandidate(
          new RTCIceCandidate(candidate),
        );
      }
    });

    s.on("peer-status", ({ status }) => {
      setPeerStatus(status);
    });

    s.on("peer-disconnected", () => {
      setPeerConnected(false);
      setPeerStatus("offline");
      setMessages((p) => [...p, { type: "system", text: "Peer disconnected" }]);
      // close existing peer connection
      if (peerConnectionRef.current) {
        try {
          peerConnectionRef.current.close();
        } catch (e) {}
        peerConnectionRef.current = null;
      }
    });

    s.on("peer-left", () => {
      setPeerConnected(false);
      setPeerStatus("offline");
      setMessages((p) => [...p, { type: "system", text: "Peer left" }]);
    });

    // cleanup on unmount
    const handleUnload = () => {
      if (socketRef.current && socketRef.current.connected) {
        socketRef.current.emit("leave-room");
        socketRef.current.disconnect();
      }
      if (peerConnectionRef.current) {
        try {
          peerConnectionRef.current.close();
        } catch (e) {}
        peerConnectionRef.current = null;
      }
    };
    window.addEventListener("beforeunload", handleUnload);

    return () => {
      window.removeEventListener("beforeunload", handleUnload);
      if (socketRef.current) {
        socketRef.current.off();
        socketRef.current.disconnect();
      }
      if (peerConnectionRef.current) {
        try {
          peerConnectionRef.current.close();
        } catch (e) {}
        peerConnectionRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Peer connection helper
  const createPeerConnection = (isInitiator) => {
    // if already exists, close and recreate
    if (peerConnectionRef.current) {
      try {
        peerConnectionRef.current.close();
      } catch (e) {}
      peerConnectionRef.current = null;
      dataChannelRef.current = null;
      fileChannelRef.current = null;
      setPeerConnected(false);
    }

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.current && peerIdRef.current) {
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
        setMessages((p) => [
          ...p,
          { type: "system", text: "Connected to peer!" },
        ]);
      } else if (
        pc.connectionState === "disconnected" ||
        pc.connectionState === "failed"
      ) {
        setPeerConnected(false);
      }
    };

    if (isInitiator) {
      const chatChannel = pc.createDataChannel("chat");
      setupChatChannel(chatChannel);

      const fileChannel = pc.createDataChannel("file", { ordered: true });
      setupFileChannel(fileChannel);

      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => {
          if (socketRef.current && peerIdRef.current) {
            socketRef.current.emit("webrtc-offer", {
              offer: pc.localDescription,
              to: peerIdRef.current,
            });
          }
        })
        .catch((e) => console.error("offer error:", e));
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
  };

  const setupChatChannel = (channel) => {
    dataChannelRef.current = channel;
    channel.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "message") {
          setMessages((p) => [...p, { type: "received", text: data.text }]);
        } else if (data.type === "typing") {
          setPeerStatus("typing");
          setTimeout(() => setPeerStatus("idle"), 2000);
        }
      } catch (e) {
        console.warn("chat onmessage parse failed", e);
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
    channel.onopen = () => console.log("File channel opened");
    channel.onclose = () => console.log("File channel closed");
  };

  const saveFile = () => {
    try {
      const blob = new Blob(fileBufferRef.current);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileMetadataRef.current.name || "download";
      a.click();
      URL.revokeObjectURL(url);
      setMessages((p) => [
        ...p,
        { type: "system", text: `Downloaded: ${fileMetadataRef.current.name}` },
      ]);
    } finally {
      setTimeout(() => {
        setTransferStats(null);
        setSpeedData([]);
      }, 2000);
    }
  };

  const joinRoom = async () => {
    if (!roomName.trim() || !serverOnline) return;
    // connect socket once then emit join
    if (!socketRef.current) return;
    if (!socketRef.current.connected) socketRef.current.connect();
    socketRef.current.emit("join-room", roomName);
    setError("");
  };

  const sendMessage = () => {
    if (!messageInput.trim() || !peerConnected || !dataChannelRef.current)
      return;
    dataChannelRef.current.send(
      JSON.stringify({ type: "message", text: messageInput }),
    );
    setMessages((p) => [...p, { type: "sent", text: messageInput }]);
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
    if (!peerConnected || !file || !fileChannelRef.current) return;
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
        setMessages((p) => [
          ...p,
          { type: "system", text: `Sent: ${file.name}` },
        ]);
        updateStatus("idle");
      }
    };
    readSlice();
  };

  // Simple UI — liquid glass style (black / white / blue)
  return (
    <div className="min-h-screen bg-black text-white p-6">
      <div className="max-w-6xl mx-auto">
        {/* Header - glass */}
        <header className="flex items-center justify-between p-4 rounded-2xl bg-white/4 backdrop-blur-md border border-white/10 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-xl bg-gradient-to-br from-blue-600/30 to-white/5 border border-white/10">
              <Users className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold">P2P File Share</h1>
              <p className="text-sm text-gray-300">Direct WebRTC file & chat</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={checkServerStatus}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-all border ${
                serverOnline ? "border-blue-400/40" : "border-red-400/30"
              }`}
            >
              {serverOnline ? (
                <Wifi className="w-5 h-5" />
              ) : (
                <WifiOff className="w-5 h-5" />
              )}
              <span className="font-medium text-sm">
                {serverOnline ? "Server Online" : "Server Offline"}
              </span>
            </button>
            <div className="text-sm text-gray-300">
              Room:{" "}
              <span className="font-mono text-blue-300">{roomName || "-"}</span>
            </div>
          </div>
        </header>

        <main className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
          {!isConnected ? (
            <div className="lg:col-span-3 flex items-center justify-center min-h-[60vh]">
              <div className="w-full max-w-md p-8 rounded-3xl bg-white/5 backdrop-blur-lg border border-white/10">
                <h2 className="text-2xl font-semibold mb-2 text-white">
                  Join a room
                </h2>
                <p className="text-sm text-gray-300 mb-4">
                  Use the same room name to connect to a peer
                </p>
                <input
                  value={roomName}
                  onChange={(e) => setRoomName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && joinRoom()}
                  placeholder="e.g., physics-123"
                  className="w-full px-4 py-3 rounded-xl bg-black/40 border border-white/10 mb-4 focus:outline-none"
                  disabled={!serverOnline}
                />
                <button
                  onClick={joinRoom}
                  disabled={!serverOnline || !roomName.trim()}
                  className="w-full px-4 py-3 rounded-xl bg-blue-600/70 hover:bg-blue-600 transition disabled:opacity-50"
                >
                  Connect
                </button>

                {error && (
                  <div className="mt-4 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-yellow-300 text-sm flex items-center gap-2">
                    <AlertCircle className="w-4 h-4" />
                    <span>{error}</span>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <>
              {/* Status bar */}
              <div className="lg:col-span-3 p-4 rounded-2xl bg-white/4 backdrop-blur-md border border-white/10 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div
                    className={`w-3 h-3 rounded-full ${peerConnected ? "bg-blue-400 animate-pulse" : "bg-gray-600"}`}
                  />
                  <div className="text-sm">
                    {peerConnected ? "Connected" : "Waiting for peer..."}
                  </div>
                </div>
                <div className="flex gap-6 text-sm text-gray-300">
                  <div>
                    You:{" "}
                    <span className="capitalize text-blue-300">{myStatus}</span>
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

              {/* Chat */}
              <section className="lg:col-span-2 flex flex-col rounded-2xl bg-white/4 border border-white/10 h-[600px] overflow-hidden">
                <div className="p-4 border-b border-white/6">
                  <h3 className="font-semibold">Chat</h3>
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                  {messages.map((m, i) => (
                    <div
                      key={i}
                      className={`flex ${m.type === "sent" ? "justify-end" : m.type === "system" ? "justify-center" : "justify-start"}`}
                    >
                      <div
                        className={`max-w-xs px-4 py-2 rounded-2xl ${m.type === "sent" ? "bg-blue-600/60" : m.type === "system" ? "bg-white/6 text-gray-300 text-sm" : "bg-white/5"}`}
                      >
                        {m.text}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="p-4 border-t border-white/6">
                  <div className="flex gap-2">
                    <input
                      value={messageInput}
                      onChange={(e) => {
                        setMessageInput(e.target.value);
                        handleTyping();
                      }}
                      onKeyDown={(e) => e.key === "Enter" && sendMessage()}
                      placeholder="Type a message..."
                      disabled={!peerConnected}
                      className="flex-1 px-4 py-2 rounded-xl bg-black/40 border border-white/10"
                    />
                    <button
                      onClick={sendMessage}
                      disabled={!peerConnected || !messageInput.trim()}
                      className="px-4 py-2 rounded-xl bg-blue-600/70"
                    >
                      <Send className="w-5 h-5" />
                    </button>
                  </div>
                </div>
              </section>

              {/* File area */}
              <aside className="space-y-6">
                <div className="p-4 rounded-2xl bg-white/4 border border-white/10">
                  <h3 className="font-semibold mb-3">Send File</h3>
                  <input
                    id="file-input"
                    type="file"
                    className="hidden"
                    onChange={(e) => sendFile(e.target.files[0])}
                  />
                  <label
                    htmlFor="file-input"
                    className={`inline-flex items-center gap-2 px-4 py-3 rounded-xl cursor-pointer ${peerConnected ? "bg-blue-600/70" : "opacity-50 cursor-not-allowed"}`}
                  >
                    <Upload className="w-5 h-5" />
                    <span className="font-medium">Choose File</span>
                  </label>
                </div>

                {transferStats && (
                  <div className="p-4 rounded-2xl bg-white/5 border border-white/8">
                    <div className="flex items-center gap-2 mb-3">
                      <Download className="w-5 h-5" />
                      <h4 className="font-medium">Receiving File</h4>
                    </div>
                    <div className="text-sm text-gray-300 truncate mb-3">
                      {transferStats.fileName}
                    </div>
                    <div className="bg-white/6 rounded-full h-2 overflow-hidden mb-3">
                      <div
                        className="h-full bg-blue-400 transition-all"
                        style={{ width: `${transferStats.progress}%` }}
                      />
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
                      <div className="mt-4 bg-white/4 p-2 rounded-lg">
                        <ResponsiveContainer width="100%" height={140}>
                          <LineChart data={speedData}>
                            <CartesianGrid
                              strokeDasharray="3 3"
                              stroke="rgba(255,255,255,0.06)"
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
                                borderRadius: 8,
                              }}
                            />
                            <Line
                              type="monotone"
                              dataKey="speed"
                              stroke="#60A5FA"
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
            </>
          )}
        </main>
      </div>
    </div>
  );
}
