// src/components/JoinRoom.jsx
import React from "react";
import { motion } from "framer-motion";
import { Activity, Zap, AlertCircle } from "lucide-react";

const JoinRoom = ({ roomName, setRoomName, joinRoom, error, serverOnline }) => {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-center justify-center min-h-[60vh]"
    >
      <div className="w-full max-w-md liquid-glass shining-effect rounded-3xl p-8">
        <div className="text-center mb-6">
          <motion.div
            animate={{ scale: [1, 1.1, 1] }}
            transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
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
            className="flex-1 px-4 py-3 rounded-xl bg-slate-900/70 border-2 border-white/10 focus:outline-none focus:border-blue-400/50 transition flat-button"
            disabled={!serverOnline}
          />
          <button
            onClick={joinRoom}
            disabled={!serverOnline || !roomName.trim()}
            className="px-5 py-3 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-500 hover:to-cyan-400 transition disabled:opacity-50 disabled:cursor-not-allowed font-medium flat-button"
          >
            <Zap />
          </button>
        </div>
        {error && (
          <div className="mt-4 p-3 rounded-xl bg-amber-500/10 border-2 border-amber-400/30 text-amber-300 text-sm flex items-center gap-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>
    </motion.div>
  );
};

export default JoinRoom;
