// server.js
const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.use(cors());
app.use(express.json());

// Store rooms and their users
const rooms = new Map();

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "online",
    timestamp: new Date().toISOString(),
    activeRooms: rooms.size,
  });
});

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("join-room", (roomName) => {
    console.log(`User ${socket.id} joining room: ${roomName}`);

    // Leave any previous rooms
    Array.from(socket.rooms).forEach((room) => {
      if (room !== socket.id) {
        socket.leave(room);
      }
    });

    // Get or create room
    if (!rooms.has(roomName)) {
      rooms.set(roomName, []);
    }

    const room = rooms.get(roomName);

    // Check if room is full (max 2 users)
    if (room.length >= 2) {
      socket.emit("room-full");
      return;
    }

    // Add user to room
    room.push(socket.id);
    socket.join(roomName);
    socket.roomName = roomName;

    // If this is the second user, initiate connection
    if (room.length === 2) {
      const [user1, user2] = room;

      // Notify both users that they can start WebRTC connection
      io.to(user1).emit("peer-joined", { peerId: user2 });
      io.to(user2).emit("peer-joined", { peerId: user1 });

      console.log(`Room ${roomName} is now full. Users: ${user1}, ${user2}`);
    } else {
      socket.emit("waiting-for-peer");
    }
  });

  // WebRTC signaling
  socket.on("webrtc-offer", ({ offer, to }) => {
    console.log(`Forwarding offer from ${socket.id} to ${to}`);
    io.to(to).emit("webrtc-offer", { offer, from: socket.id });
  });

  socket.on("webrtc-answer", ({ answer, to }) => {
    console.log(`Forwarding answer from ${socket.id} to ${to}`);
    io.to(to).emit("webrtc-answer", { answer, from: socket.id });
  });

  socket.on("ice-candidate", ({ candidate, to }) => {
    console.log(`Forwarding ICE candidate from ${socket.id} to ${to}`);
    io.to(to).emit("ice-candidate", { candidate, from: socket.id });
  });

  // Status updates
  socket.on("status-update", ({ status, to }) => {
    io.to(to).emit("peer-status", { status });
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);

    // Remove user from room and notify peer
    if (socket.roomName) {
      const room = rooms.get(socket.roomName);
      if (room) {
        const index = room.indexOf(socket.id);
        if (index > -1) {
          room.splice(index, 1);

          // Notify the other user
          if (room.length > 0) {
            io.to(room[0]).emit("peer-disconnected");
          }

          // Clean up empty rooms
          if (room.length === 0) {
            rooms.delete(socket.roomName);
          }
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check available at http://localhost:${PORT}/health`);
});
