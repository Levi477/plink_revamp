const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
// We will use the built-in crypto module for secure, untraceable password handling
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  path: "/socket.io",
  transports: ["websocket", "polling"],
  pingInterval: 25000,
  pingTimeout: 60000,
  maxHttpBufferSize: 1e6,
});

app.use(cors());
app.use(express.json());

/**
 * The 'rooms' Map now stores room data in a new structure:
 * Key: roomId (string)
 * Value: {
 * users: [socket.id_1, socket.id_2],
 * passwordHash: "a-hashed-password-string" | null
 * }
 * We store a hash of the password, not the password itself.
 * This prevents leaking the actual password, even in memory or logs.
 */
const rooms = new Map();

// A simple hashing function using Node.js crypto.
// This is a one-way hash, so we can't reverse it to get the original password.
// We add a 'salt' (which can be static here) to prevent rainbow table attacks.
const hashPassword = (password) => {
  if (!password) return null; // Room has no password
  const salt = "plink-static-salt"; // A static salt is fine for this use case
  return crypto
    .createHash("sha256")
    .update(password + salt)
    .digest("hex");
};

app.get("/health", (req, res) => {
  res.json({
    status: "online",
    timestamp: new Date().toISOString(),
    activeRooms: rooms.size,
    // Update this map to correctly read the new room data structure
    rooms: Array.from(rooms.entries()).map(([name, roomData]) => ({
      name,
      userCount: roomData.users.length,
      hasPassword: !!roomData.passwordHash, // Inform health check if room is password protected
    })),
  });
});

/**
 * Logs the current state of all rooms for debugging.
 * Importantly, this ONLY logs that a password is set, never the hash or password itself.
 */
function logState(label) {
  console.log(
    `[${label}] Active rooms:`,
    Array.from(rooms.entries())
      .map(
        ([name, roomData]) =>
          `${name}: [${roomData.users.join(", ")}] (pass_set: ${!!roomData.passwordHash})`,
      )
      .join(" | "),
  );
}

io.on("connection", (socket) => {
  console.log(`[CONNECTION] User connected: ${socket.id}`);

  // 'join-room' handler is updated to accept a password
  socket.on("join-room", (data) => {
    try {
      // Destructure data from the client
      const { roomId, userId, password } = data;

      if (!roomId) {
        console.error(`[JOIN-ROOM] Invalid room ID from ${socket.id}`);
        socket.emit("join-error", { message: "Invalid room name" });
        return;
      }

      // IMPORTANT: We only log the room ID, never the password.
      console.log(
        `[JOIN-ROOM] ${socket.id} (userId: ${userId}) attempting to join room: ${roomId}`,
      );

      // Hash the password provided by the user for comparison
      const providedPasswordHash = hashPassword(password);

      // --- Handle leaving previous room ---
      if (socket.currentRoom) {
        const prevRoom = rooms.get(socket.currentRoom);
        if (prevRoom) {
          // Update to read from `prevRoom.users`
          const idx = prevRoom.users.indexOf(socket.id);
          if (idx !== -1) {
            prevRoom.users.splice(idx, 1);
            console.log(
              `[JOIN-ROOM] Removed ${socket.id} from previous room ${socket.currentRoom}`,
            );
          }
          // Update to read from `prevRoom.users`
          if (prevRoom.users.length === 0) {
            rooms.delete(socket.currentRoom);
            console.log(`[JOIN-ROOM] Deleted empty room ${socket.currentRoom}`);
          }
        }
        socket.leave(socket.currentRoom);
      }

      // --- Handle joining new room ---

      // Case 1: Room doesn't exist. Create it.
      if (!rooms.has(roomId)) {
        rooms.set(roomId, {
          users: [],
          passwordHash: providedPasswordHash, // Set the password hash for this new room
        });
        console.log(
          `[JOIN-ROOM] Created new room: ${roomId} (pass_set: ${!!providedPasswordHash})`,
        );
      }

      const room = rooms.get(roomId);

      // Case 2: Room exists. Check password.
      // We compare the hash of the provided password with the stored hash.
      if (room.passwordHash !== providedPasswordHash) {
        console.log(
          `[JOIN-ROOM] Invalid password for room ${roomId} from ${socket.id}`,
        );
        socket.emit("join-error", { message: "Invalid password." });
        return;
      }

      // Check if already in room (using new structure)
      if (room.users.includes(socket.id)) {
        console.log(`[JOIN-ROOM] ${socket.id} already in room ${roomId}`);
        socket.emit("joined-room", { room: roomId });
        return;
      }

      // Check room capacity (using new structure)
      if (room.users.length >= 2) {
        console.log(`[JOIN-ROOM] Room ${roomId} is full`);
        socket.emit("room-full");
        return;
      }

      // --- Add user to room ---
      room.users.push(socket.id); // Add to `room.users`
      socket.join(roomId);
      socket.currentRoom = roomId;
      socket.userId = userId;

      console.log(
        `[JOIN-ROOM] ${socket.id} successfully joined ${roomId}. Room size: ${room.users.length}`,
      );
      logState("AFTER-JOIN");

      // --- Emit events to users ---
      if (room.users.length === 1) {
        // First user in room
        socket.emit("waiting-for-peer");
        socket.emit("joined-room", { room: roomId, position: 1 });
        console.log(
          `[JOIN-ROOM] ${socket.id} is waiting for peer in ${roomId}`,
        );
      } else if (room.users.length === 2) {
        // Second user joined - get users from `room.users`
        const [user1, user2] = room.users;
        console.log(
          `[JOIN-ROOM] Room ${roomId} now has 2 users: ${user1}, ${user2}`,
        );

        // Only notify first user to create offer
        io.to(user1).emit("user-connected", { userId: user2 });
        io.to(user1).emit("joined-room", { room: roomId, position: 1 });

        // Second user just joins and waits for offer
        io.to(user2).emit("joined-room", { room: roomId, position: 2 });

        console.log(`[JOIN-ROOM] User1 will initiate connection to User2`);
      }
    } catch (err) {
      console.error(`[JOIN-ROOM] Error:`, err);
      socket.emit("join-error", { message: "Server error joining room" });
    }
  });

  // --- WebRTC Signaling (no changes needed) ---
  // These handlers just forward messages and don't need the room data.
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
    room.users.forEach((userId) => {
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
    room.users.forEach((userId) => {
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
    room.users.forEach((userId) => {
      if (userId !== socket.id) {
        console.log(
          `[ICE] Forwarding candidate from ${socket.id} to ${userId}`,
        );
        io.to(userId).emit("ice-candidate", { candidate });
      }
    });
  });

  // --- Disconnect / Leave Handlers (Updated) ---
  socket.on("leave-room", ({ roomId }) => {
    if (!roomId) return;
    console.log(`[LEAVE-ROOM] ${socket.id} leaving room ${roomId}`);
    const room = rooms.get(roomId);

    if (room) {
      // Update to use `room.users`
      const index = room.users.indexOf(socket.id);
      if (index > -1) {
        room.users.splice(index, 1);

        // Notify other user
        if (room.users.length > 0) {
          io.to(room.users[0]).emit("user-disconnected", { userId: socket.id });
          console.log(
            `[LEAVE-ROOM] Notified ${room.users[0]} that ${socket.id} left`,
          );
        }

        // Delete room if empty
        if (room.users.length === 0) {
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
        // Update to use `room.users`
        const index = room.users.indexOf(socket.id);
        if (index > -1) {
          room.users.splice(index, 1);
          console.log(
            `[DISCONNECT] Removed ${socket.id} from room ${socket.currentRoom}`,
          );

          // Notify other user
          if (room.users.length > 0) {
            io.to(room.users[0]).emit("user-disconnected", {
              userId: socket.id,
            });
            console.log(
              `[DISCONNECT] Notified ${room.users[0]} that ${socket.id} disconnected`,
            );
          }

          // Delete room if empty
          if (room.users.length === 0) {
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
