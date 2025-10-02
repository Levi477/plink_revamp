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

const rooms = new Map();

app.get("/health", (req, res) => {
  res.json({
    status: "online",
    timestamp: new Date().toISOString(),
    activeRooms: rooms.size,
    rooms: Array.from(rooms.entries()).map(([name, users]) => ({
      name,
      userCount: users.length,
    })),
  });
});

function logState(label) {
  console.log(
    `[${label}] Active rooms:`,
    Array.from(rooms.entries())
      .map(([name, users]) => `${name}: [${users.join(", ")}]`)
      .join(" | "),
  );
}

io.on("connection", (socket) => {
  console.log(`[CONNECTION] User connected: ${socket.id}`);

  socket.on("join-room", (data) => {
    try {
      const roomId = typeof data === "string" ? data : data.roomId;
      const userId = typeof data === "object" ? data.userId : socket.id;

      if (!roomId) {
        console.error(`[JOIN-ROOM] Invalid room ID from ${socket.id}`);
        socket.emit("join-error", { message: "Invalid room name" });
        return;
      }

      console.log(
        `[JOIN-ROOM] ${socket.id} (userId: ${userId}) joining room: ${roomId}`,
      );

      // Leave any previous room
      if (socket.currentRoom) {
        const prevRoom = rooms.get(socket.currentRoom);
        if (prevRoom) {
          const idx = prevRoom.indexOf(socket.id);
          if (idx !== -1) {
            prevRoom.splice(idx, 1);
            console.log(
              `[JOIN-ROOM] Removed ${socket.id} from previous room ${socket.currentRoom}`,
            );
          }
          if (prevRoom.length === 0) {
            rooms.delete(socket.currentRoom);
            console.log(`[JOIN-ROOM] Deleted empty room ${socket.currentRoom}`);
          }
        }
        socket.leave(socket.currentRoom);
      }

      // Initialize room if it doesn't exist
      if (!rooms.has(roomId)) {
        rooms.set(roomId, []);
        console.log(`[JOIN-ROOM] Created new room: ${roomId}`);
      }

      const room = rooms.get(roomId);

      // Check if already in room
      if (room.includes(socket.id)) {
        console.log(`[JOIN-ROOM] ${socket.id} already in room ${roomId}`);
        socket.emit("joined-room", { room: roomId });
        return;
      }

      // Check room capacity
      if (room.length >= 2) {
        console.log(`[JOIN-ROOM] Room ${roomId} is full`);
        socket.emit("room-full");
        return;
      }

      // Add to room
      room.push(socket.id);
      socket.join(roomId);
      socket.currentRoom = roomId;
      socket.userId = userId;

      console.log(
        `[JOIN-ROOM] ${socket.id} successfully joined ${roomId}. Room size: ${room.length}`,
      );
      logState("AFTER-JOIN");

      if (room.length === 1) {
        // First user in room
        socket.emit("waiting-for-peer");
        socket.emit("joined-room", { room: roomId, position: 1 });
        console.log(
          `[JOIN-ROOM] ${socket.id} is waiting for peer in ${roomId}`,
        );
      } else if (room.length === 2) {
        // Second user joined - notify both
        const [user1, user2] = room;
        console.log(
          `[JOIN-ROOM] Room ${roomId} now has 2 users: ${user1}, ${user2}`,
        );

        // Notify first user about second user
        io.to(user1).emit("user-connected", { userId: user2 });
        io.to(user1).emit("joined-room", { room: roomId, position: 1 });

        // Notify second user about first user
        io.to(user2).emit("user-connected", { userId: user1 });
        io.to(user2).emit("joined-room", { room: roomId, position: 2 });

        console.log(`[JOIN-ROOM] Both users notified in room ${roomId}`);
      }
    } catch (err) {
      console.error(`[JOIN-ROOM] Error:`, err);
      socket.emit("join-error", { message: "Server error joining room" });
    }
  });

  socket.on("offer", ({ roomId, offer }) => {
    if (!roomId || !offer) {
      console.error(`[OFFER] Missing roomId or offer from ${socket.id}`);
      return;
    }

    console.log(`[OFFER] Received from ${socket.id} in room ${roomId}`);
    const room = rooms.get(roomId);

    if (!room) {
      console.error(`[OFFER] Room ${roomId} not found`);
      return;
    }

    // Send to other user in room
    room.forEach((userId) => {
      if (userId !== socket.id) {
        console.log(`[OFFER] Forwarding offer from ${socket.id} to ${userId}`);
        io.to(userId).emit("offer", { offer });
      }
    });
  });

  socket.on("answer", ({ roomId, answer }) => {
    if (!roomId || !answer) {
      console.error(`[ANSWER] Missing roomId or answer from ${socket.id}`);
      return;
    }

    console.log(`[ANSWER] Received from ${socket.id} in room ${roomId}`);
    const room = rooms.get(roomId);

    if (!room) {
      console.error(`[ANSWER] Room ${roomId} not found`);
      return;
    }

    // Send to other user in room
    room.forEach((userId) => {
      if (userId !== socket.id) {
        console.log(
          `[ANSWER] Forwarding answer from ${socket.id} to ${userId}`,
        );
        io.to(userId).emit("answer", { answer });
      }
    });
  });

  socket.on("ice-candidate", ({ roomId, candidate }) => {
    if (!roomId) {
      console.error(`[ICE] Missing roomId from ${socket.id}`);
      return;
    }

    console.log(
      `[ICE] Received from ${socket.id} in room ${roomId}, candidate: ${candidate ? "present" : "null"}`,
    );
    const room = rooms.get(roomId);

    if (!room) {
      console.error(`[ICE] Room ${roomId} not found`);
      return;
    }

    // Forward to other user in room
    room.forEach((userId) => {
      if (userId !== socket.id) {
        console.log(
          `[ICE] Forwarding candidate from ${socket.id} to ${userId}`,
        );
        io.to(userId).emit("ice-candidate", { candidate });
      }
    });
  });

  socket.on("leave-room", ({ roomId }) => {
    if (!roomId) return;

    console.log(`[LEAVE-ROOM] ${socket.id} leaving room ${roomId}`);
    const room = rooms.get(roomId);

    if (room) {
      const index = room.indexOf(socket.id);
      if (index > -1) {
        room.splice(index, 1);

        // Notify other user
        if (room.length > 0) {
          io.to(room[0]).emit("user-disconnected", { userId: socket.id });
          console.log(
            `[LEAVE-ROOM] Notified ${room[0]} that ${socket.id} left`,
          );
        }

        // Delete room if empty
        if (room.length === 0) {
          rooms.delete(roomId);
          console.log(`[LEAVE-ROOM] Deleted empty room ${roomId}`);
        }
      }
    }

    socket.leave(roomId);
    socket.currentRoom = null;
    logState("AFTER-LEAVE");
  });

  socket.on("disconnect", (reason) => {
    console.log(`[DISCONNECT] ${socket.id} disconnected. Reason: ${reason}`);

    if (socket.currentRoom) {
      const room = rooms.get(socket.currentRoom);
      if (room) {
        const index = room.indexOf(socket.id);
        if (index > -1) {
          room.splice(index, 1);
          console.log(
            `[DISCONNECT] Removed ${socket.id} from room ${socket.currentRoom}`,
          );

          // Notify other user
          if (room.length > 0) {
            io.to(room[0]).emit("user-disconnected", { userId: socket.id });
            console.log(
              `[DISCONNECT] Notified ${room[0]} that ${socket.id} disconnected`,
            );
          }

          // Delete room if empty
          if (room.length === 0) {
            rooms.delete(socket.currentRoom);
            console.log(
              `[DISCONNECT] Deleted empty room ${socket.currentRoom}`,
            );
          }
        }
      }
    }

    logState("AFTER-DISCONNECT");
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`========================================`);
});
