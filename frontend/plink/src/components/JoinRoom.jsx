import React from "react";
import { motion } from "framer-motion";
import { Key, Zap, AlertCircle, Lock, Hash } from "lucide-react"; // Import new icons

/**
 * This component renders the form for joining a room.
 * It now accepts 'password' and 'setPassword' as props.
 */
const JoinRoom = ({
  roomName,
  setRoomName,
  password, // New prop
  setPassword, // New prop
  joinRoom,
  error,
  serverOnline,
}) => {
  /**
   * Handles the form submission.
   * Prevents default form behavior and calls the joinRoom function.
   */
  const handleSubmit = (e) => {
    e.preventDefault();
    if (!serverOnline || !roomName.trim()) return;
    joinRoom();
  };

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
            {/* Changed icon from Activity to Key for better relevance */}
            <Key className="w-16 h-16 mx-auto mb-4 text-blue-400" />
          </motion.div>
          <h2 className="text-2xl font-bold mb-2">Join or Create a Room</h2>
          <p className="text-sm text-slate-400">
            Enter a room name. Add a password to make it private.
          </p>
        </div>

        {/* Use a form element for better accessibility and 'Enter' key behavior */}
        <form onSubmit={handleSubmit}>
          <div className="space-y-4 mb-6">
            {/* --- Room Name Input --- */}
            <div className="relative">
              <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">
                <Hash className="w-5 h-5" />
              </span>
              <input
                id="room-name"
                value={roomName}
                onChange={(e) => setRoomName(e.target.value)}
                placeholder="my-secret-room"
                className="w-full pl-11 pr-4 py-3 rounded-xl bg-slate-900/70 border-2 border-white/10 focus:outline-none focus:border-blue-400/50 transition flat-button"
                disabled={!serverOnline}
                autoComplete="off"
              />
            </div>

            {/* --- Password Input (New) --- */}
            <div className="relative">
              <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">
                <Lock className="w-5 h-5" />
              </span>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="password (optional)"
                className="w-full pl-11 pr-4 py-3 rounded-xl bg-slate-900/70 border-2 border-white/10 focus:outline-none focus:border-blue-400/50 transition flat-button"
                disabled={!serverOnline}
                autoComplete="current-password"
              />
            </div>
          </div>

          {/* --- Join Button --- */}
          <button
            type="submit" // Triggers form onSubmit
            disabled={!serverOnline || !roomName.trim()}
            className="w-full flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-500 hover:to-cyan-400 transition disabled:opacity-50 disabled:cursor-not-allowed font-medium flat-button"
          >
            <Zap className="w-5 h-5" />
            <span>Join Room</span>
          </button>
        </form>

        {/* --- Error Display --- */}
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
