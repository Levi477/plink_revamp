// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  transports: ["websocket", "polling"],
  pingInterval: 25000,
  pingTimeout: 60000,
  maxHttpBufferSize: 1e6,
});

app.use(cors());
app.use(express.json());

/**
 * rooms: Map<roomName, Array<socketId>>
 */
const rooms = new Map();

app.get("/health", (req, res) => {
  res.json({
    status: "online",
    timestamp: new Date().toISOString(),
    activeRooms: rooms.size,
  });
});

function removeSocketFromAnyRoom(socket) {
  for (const [name, arr] of rooms.entries()) {
    const idx = arr.indexOf(socket.id);
    if (idx !== -1) {
      arr.splice(idx, 1);
      // notify other peer in that room that this socket left
      if (arr.length > 0) {
        const otherId = arr[0];
        io.to(otherId).emit("peer-left");
      }
      if (arr.length === 0) {
        rooms.delete(name);
      } else {
        rooms.set(name, arr);
      }
      // no need to keep searching since socket can be only in one logical room
      break;
    }
  }
}

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("join-room", (roomName) => {
    try {
      if (!roomName || typeof roomName !== "string") {
        socket.emit("join-error", { message: "Invalid room name" });
        return;
      }

      console.log(`User ${socket.id} joining room: ${roomName}`);

      // Remove this socket from any previous room state we have
      removeSocketFromAnyRoom(socket);

      // Ensure room array exists
      if (!rooms.has(roomName)) {
        rooms.set(roomName, []);
      }
      const room = rooms.get(roomName);

      // Prevent duplicate entries
      if (room.includes(socket.id)) {
        socket.emit("joined-room", { room: roomName });
        return;
      }

      // Max 2 users
      if (room.length >= 2) {
        socket.emit("room-full");
        return;
      }

      // Add and join
      room.push(socket.id);
      socket.join(roomName);
      socket.roomName = roomName;
      rooms.set(roomName, room);

      if (room.length === 1) {
        // first user - waiting
        socket.emit("waiting-for-peer");
        socket.emit("joined-room", { room: roomName, position: 1 });
        console.log(`Room ${roomName} created by ${socket.id}`);
      } else if (room.length === 2) {
        // second user - notify both
        const [a, b] = room;
        io.to(a).emit("peer-joined", { peerId: b });
        io.to(b).emit("peer-joined", { peerId: a });
        io.to(a).emit("joined-room", { room: roomName, position: 1 });
        io.to(b).emit("joined-room", { room: roomName, position: 2 });
        console.log(`Room ${roomName} is now full. Users: ${a}, ${b}`);
      }
    } catch (err) {
      console.error("join-room error:", err);
      socket.emit("join-error", { message: "Server error joining room" });
    }
  });

  // WebRTC signaling
  socket.on("webrtc-offer", ({ offer, to }) => {
    if (!to) return;
    io.to(to).emit("webrtc-offer", { offer, from: socket.id });
  });

  socket.on("webrtc-answer", ({ answer, to }) => {
    if (!to) return;
    io.to(to).emit("webrtc-answer", { answer, from: socket.id });
  });

  socket.on("ice-candidate", ({ candidate, to }) => {
    if (!to) return;
    io.to(to).emit("ice-candidate", { candidate, from: socket.id });
  });

  socket.on("status-update", ({ status, to }) => {
    if (!to) return;
    io.to(to).emit("peer-status", { status });
  });

  socket.on("disconnect", (reason) => {
    console.log("User disconnected:", socket.id, "reason:", reason);
    // Clean up room state and notify peer
    if (socket.roomName) {
      const room = rooms.get(socket.roomName);
      if (room) {
        const index = room.indexOf(socket.id);
        if (index > -1) {
          room.splice(index, 1);
          if (room.length > 0) {
            io.to(room[0]).emit("peer-disconnected");
          }
          if (room.length === 0) {
            rooms.delete(socket.roomName);
          } else {
            rooms.set(socket.roomName, room);
          }
        }
      }
      socket.roomName = null;
    } else {
      // In case socket.roomName is missing, remove from any room entries
      removeSocketFromAnyRoom(socket);
    }
  });

  // defensive: allow client to explicitly leave
  socket.on("leave-room", () => {
    removeSocketFromAnyRoom(socket);
    socket.leave(socket.roomName || "");
    socket.roomName = null;
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check available at http://localhost:${PORT}/health`);
});
