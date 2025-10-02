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
const SERVER_URL = "https://plink-revamp-backend.onrender.com"; // change if needed

export default function P2PFileSharing() {
  const [roomName, setRoomName] = useState("");
  const [serverOnline, setServerOnline] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [peerConnected, setPeerConnected] = useState(false);
  const [peerStatus, setPeerStatus] = useState("offline");
  const [myStatus, setMyStatus] = useState("idle");
  const [messages, setMessages] = useState([]);
  const [messageInput, setMessageInput] = useState("");
  const [error, setError] = useState("");
  const [transferStats, setTransferStats] = useState(null);
  const [speedData, setSpeedData] = useState([]);

  const socketRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const dataChannelRef = useRef(null);
  const fileChannelRef = useRef(null);
  const peerIdRef = useRef(null);
  const myPositionRef = useRef(null);
  const pendingIceRef = useRef([]);
  const pendingPeerJoinedRef = useRef(false);

  const fileBufferRef = useRef([]);
  const receivedSizeRef = useRef(0);
  const fileMetadataRef = useRef(null);
  const startTimeRef = useRef(0);

  const checkServerStatus = async () => {
    try {
      const res = await fetch(`${SERVER_URL}/health`);
      const data = await res.json();
      setServerOnline(data.status === "online");
      setError("");
    } catch (e) {
      setServerOnline(false);
      setError("Cannot contact signaling server");
    }
  };

  useEffect(() => {
    checkServerStatus();
    const id = setInterval(checkServerStatus, 5000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const socket = io(SERVER_URL, {
      autoConnect: false,
      transports: ["websocket", "polling"],
      reconnectionAttempts: 5,
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      console.log("socket connected", socket.id);
      setError("");
    });

    socket.on("connect_error", (err) => {
      console.warn("socket connect_error", err);
      setError("Signaling connection error");
    });

    socket.on("waiting-for-peer", () => {
      setIsConnected(true);
      setError("Waiting for peer...");
    });

    socket.on("room-full", () => {
      setError("Room full");
      setIsConnected(false);
      socket.disconnect();
    });

    socket.on("joined-room", ({ room, position }) => {
      console.log("joined-room position:", position);
      setIsConnected(true);
      myPositionRef.current = position || myPositionRef.current;
      setError("");
      // If peer joined earlier and we deferred creation, create now:
      if (pendingPeerJoinedRef.current && peerIdRef.current) {
        const isInitiator = myPositionRef.current === 2;
        console.log("deferred createPeerConnection -> initiator:", isInitiator);
        createPeerConnection(isInitiator);
        pendingPeerJoinedRef.current = false;
      }
    });

    socket.on("peer-joined", ({ peerId }) => {
      console.log("peer-joined event, peerId:", peerId);
      peerIdRef.current = peerId;
      // If we already know position, create immediately, else defer until joined-room arrives
      if (myPositionRef.current != null) {
        const isInitiator = myPositionRef.current === 2;
        console.log("createPeerConnection immediate initiator:", isInitiator);
        createPeerConnection(isInitiator);
      } else {
        // position not yet known — set pending flag so joined-room handler can create PC
        console.log("deferring peer connection creation until position known");
        pendingPeerJoinedRef.current = true;
        // small safety: if joined-room doesn't arrive in 1s, attempt default (non-initiator)
        setTimeout(() => {
          if (pendingPeerJoinedRef.current && !peerConnectionRef.current) {
            console.log("timeout fallback: creating PC as non-initiator");
            createPeerConnection(false);
            pendingPeerJoinedRef.current = false;
          }
        }, 1000);
      }
    });

    socket.on("webrtc-offer", async ({ offer, from }) => {
      console.log("webrtc-offer from", from);
      peerIdRef.current = from;
      createPeerConnection(false);
      try {
        await peerConnectionRef.current.setRemoteDescription(
          new RTCSessionDescription(offer),
        );
        const answer = await peerConnectionRef.current.createAnswer();
        await peerConnectionRef.current.setLocalDescription(answer);
        socket.emit("webrtc-answer", {
          answer: peerConnectionRef.current.localDescription,
          to: from,
        });
      } catch (e) {
        console.error("handle offer error", e);
      }
    });

    socket.on("webrtc-answer", async ({ answer }) => {
      console.log("webrtc-answer received");
      if (peerConnectionRef.current) {
        try {
          await peerConnectionRef.current.setRemoteDescription(
            new RTCSessionDescription(answer),
          );
        } catch (e) {
          console.error("setRemoteDescription answer error", e);
        }
      } else {
        console.warn("answer received but peerConnection missing");
      }
    });

    socket.on("ice-candidate", ({ candidate }) => {
      if (!candidate) return;
      if (peerConnectionRef.current) {
        peerConnectionRef.current
          .addIceCandidate(new RTCIceCandidate(candidate))
          .catch((e) => {
            console.warn("addIceCandidate failed", e);
          });
      } else {
        // buffer candidates until PC exists
        pendingIceRef.current.push(candidate);
      }
    });

    socket.on("peer-status", ({ status }) => {
      setPeerStatus(status || "offline");
    });

    socket.on("peer-disconnected", () => {
      setPeerConnected(false);
      setPeerStatus("offline");
      setMessages((p) => [...p, { type: "system", text: "Peer disconnected" }]);
      cleanupPeerConnection();
    });

    socket.on("peer-left", () => {
      setPeerConnected(false);
      setPeerStatus("offline");
      setMessages((p) => [...p, { type: "system", text: "Peer left" }]);
      cleanupPeerConnection();
    });

    const handleBeforeUnload = () => {
      if (socketRef.current && socketRef.current.connected) {
        socketRef.current.emit("leave-room");
        socketRef.current.disconnect();
      }
      cleanupPeerConnection();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      if (socketRef.current) {
        socketRef.current.off();
        socketRef.current.disconnect();
      }
      cleanupPeerConnection();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const createPeerConnection = (isInitiator) => {
    // close previous
    if (peerConnectionRef.current) {
      try {
        peerConnectionRef.current.close();
      } catch (e) {}
      peerConnectionRef.current = null;
    }
    dataChannelRef.current = null;
    fileChannelRef.current = null;

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    pc.pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log("Local ICE candidate created:", event.candidate);
        if (socketRef.current && peerIdRef.current) {
          socketRef.current.emit("ice-candidate", {
            candidate: event.candidate,
            to: peerIdRef.current,
          });
          console.log("Sent candidate to server for", peerIdRef.current);
        } else {
          // send with undefined 'to' so server will fallback to room-broadcast
          socketRef.current &&
            socketRef.current.emit("ice-candidate", {
              candidate: event.candidate,
              to: null,
            });
          console.log("Sent candidate to server with no 'to' (fallback)");
        }
      } else {
        console.log("onicecandidate: null candidate");
      }
    };

    pc.onconnectionstatechange = () => {
      console.log("pc.connectionState", pc.connectionState);
      if (pc.connectionState === "connected") {
        // if channels not yet open, still mark online; channel open handlers will ensure UI is enabled
        setPeerConnected(true);
        setPeerStatus("online");
        updateStatus("online");
      } else if (
        pc.connectionState === "disconnected" ||
        pc.connectionState === "failed"
      ) {
        setPeerConnected(false);
        setPeerStatus("offline");
        updateStatus("offline");
      }
    };

    // helper to set peerConnected when both channels are ready OR when pc connected
    const checkChannelsOpen = () => {
      const chatReady =
        dataChannelRef.current && dataChannelRef.current.readyState === "open";
      const fileReady =
        fileChannelRef.current && fileChannelRef.current.readyState === "open";
      if (chatReady && fileReady) {
        setPeerConnected(true);
        setPeerStatus("online");
        updateStatus("online");
        setMessages((p) => [
          ...p,
          { type: "system", text: "Chat & File channels open" },
        ]);
      }
    };

    if (isInitiator) {
      console.log("we are initiator -> creating data channels & offer");
      const chat = pc.createDataChannel("chat");
      setupChatChannel(chat, checkChannelsOpen);

      const file = pc.createDataChannel("file", { ordered: true });
      setupFileChannel(file, checkChannelsOpen);

      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => {
          if (socketRef.current && peerIdRef.current) {
            socketRef.current.emit("webrtc-offer", {
              offer: pc.localDescription,
              to: peerIdRef.current,
            });
          } else {
            console.warn("no peerId available to send offer");
          }
        })
        .catch((e) => console.error("createOffer error", e));
    } else {
      pc.ondatachannel = (event) => {
        const ch = event.channel;
        if (ch.label === "chat") {
          setupChatChannel(ch, checkChannelsOpen);
        } else if (ch.label === "file") {
          setupFileChannel(ch, checkChannelsOpen);
        }
      };
    }

    peerConnectionRef.current = pc;

    // flush any buffered ICE candidates
    if (pendingIceRef.current.length > 0) {
      pendingIceRef.current.forEach((c) => {
        pc.addIceCandidate(new RTCIceCandidate(c)).catch((e) =>
          console.warn("flush ice failed", e),
        );
      });
      pendingIceRef.current = [];
    }
  };

  const setupChatChannel = (channel, onOpenCheck) => {
    dataChannelRef.current = channel;
    channel.onopen = () => {
      console.log("chat channel open");
      onOpenCheck && onOpenCheck();
    };
    channel.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data);
        if (d.type === "message") {
          setMessages((p) => [...p, { type: "received", text: d.text }]);
        } else if (d.type === "typing") {
          setPeerStatus("typing");
          setTimeout(() => setPeerStatus("online"), 2000);
        }
      } catch (e) {
        console.warn("chat parse error", e);
      }
    };
    channel.onclose = () => console.log("chat channel closed");
  };

  const setupFileChannel = (channel, onOpenCheck) => {
    fileChannelRef.current = channel;
    channel.onopen = () => {
      console.log("file channel open");
      onOpenCheck && onOpenCheck();
    };
    channel.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        try {
          const meta = JSON.parse(ev.data);
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
          console.warn("file metadata parse failed", e);
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
        if (receivedSizeRef.current >= fileMetadataRef.current.size)
          finalizeReceivedFile();
      }
    };
    channel.onclose = () => console.log("file channel closed");
  };

  const finalizeReceivedFile = () => {
    const blob = new Blob(fileBufferRef.current);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fileMetadataRef.current.name || "download";
    a.click();
    URL.revokeObjectURL(a.href);
    setMessages((p) => [
      ...p,
      { type: "system", text: `Downloaded ${fileMetadataRef.current.name}` },
    ]);
    setTimeout(() => {
      setTransferStats(null);
      setSpeedData([]);
    }, 1500);
  };

  const cleanupPeerConnection = () => {
    if (dataChannelRef.current)
      try {
        dataChannelRef.current.close();
      } catch (e) {}
    dataChannelRef.current = null;
    if (fileChannelRef.current)
      try {
        fileChannelRef.current.close();
      } catch (e) {}
    fileChannelRef.current = null;
    if (peerConnectionRef.current)
      try {
        peerConnectionRef.current.close();
      } catch (e) {}
    peerConnectionRef.current = null;
    pendingIceRef.current = [];
    setPeerConnected(false);
    setPeerStatus("offline");
    updateStatus("offline");
  };

  const joinRoom = () => {
    if (!roomName.trim() || !serverOnline) return;
    const s = socketRef.current;
    if (!s) return;
    if (!s.connected) s.connect();
    s.emit("join-room", roomName);
    setError("");
  };

  const sendMessage = () => {
    if (
      !messageInput.trim() ||
      !dataChannelRef.current ||
      dataChannelRef.current.readyState !== "open"
    )
      return;
    dataChannelRef.current.send(
      JSON.stringify({ type: "message", text: messageInput }),
    );
    setMessages((p) => [...p, { type: "sent", text: messageInput }]);
    setMessageInput("");
    updateStatus("idle");
  };

  const handleTyping = () => {
    if (
      dataChannelRef.current &&
      dataChannelRef.current.readyState === "open"
    ) {
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

  const sendFile = (file) => {
    if (
      !file ||
      !fileChannelRef.current ||
      fileChannelRef.current.readyState !== "open"
    )
      return;
    updateStatus("sending-file");
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const metadata = {
      name: file.name,
      size: file.size,
      type: file.type,
      chunks: totalChunks,
    };
    fileChannelRef.current.send(JSON.stringify(metadata));
    let offset = 0;
    const reader = new FileReader();
    reader.onload = (e) => {
      fileChannelRef.current.send(e.target.result);
      offset += e.target.result.byteLength;
      if (offset < file.size) readSlice();
      else {
        setMessages((p) => [
          ...p,
          { type: "system", text: `Sent: ${file.name}` },
        ]);
        updateStatus("idle");
      }
    };
    const readSlice = () => {
      const slice = file.slice(offset, offset + CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);
    };
    readSlice();
  };

  return (
    <div className="min-h-screen bg-black text-white p-6">
      <div className="max-w-6xl mx-auto">
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
              className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-all border ${serverOnline ? "border-blue-400/40" : "border-red-400/30"}`}
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
                  placeholder="e.g., itachi"
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
                      disabled={
                        !peerConnected ||
                        !dataChannelRef.current ||
                        dataChannelRef.current.readyState !== "open"
                      }
                      className="flex-1 px-4 py-2 rounded-xl bg-black/40 border border-white/10"
                    />
                    <button
                      onClick={sendMessage}
                      disabled={
                        !peerConnected ||
                        !messageInput.trim() ||
                        !dataChannelRef.current ||
                        dataChannelRef.current.readyState !== "open"
                      }
                      className="px-4 py-2 rounded-xl bg-blue-600/70"
                    >
                      <Send className="w-5 h-5" />
                    </button>
                  </div>
                </div>
              </section>

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
                    className={`inline-flex items-center gap-2 px-4 py-3 rounded-xl cursor-pointer ${peerConnected && fileChannelRef.current && fileChannelRef.current.readyState === "open" ? "bg-blue-600/70" : "opacity-50 cursor-not-allowed"}`}
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
