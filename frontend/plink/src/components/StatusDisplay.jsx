// src/components/StatusDisplay.jsx
import React from "react";
import { motion } from "framer-motion";

const StatusDisplay = ({
  isConnected,
  peerConnected,
  connectionState,
  channelsReady,
}) => {
  const getConnectionColor = () => {
    if (!isConnected)
      return "from-slate-800/20 to-slate-900/20 border-slate-700";
    switch (connectionState) {
      case "connected":
        return "from-emerald-500/30 to-teal-500/30 border-emerald-400/50";
      case "connecting":
        return "from-amber-500/30 to-orange-500/30 border-amber-400/50";
      case "waiting":
        return "from-blue-500/30 to-cyan-500/30 border-blue-400/50";
      default:
        return "from-red-500/30 to-rose-500/30 border-red-400/50";
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className={`liquid-glass shining-effect rounded-2xl p-4 mb-6 shadow-xl bg-gradient-to-r border-2 ${getConnectionColor()}`}
    >
      <div className="flex items-center gap-3">
        <motion.div
          animate={{ scale: peerConnected ? [1, 1.2, 1] : 1 }}
          transition={{ duration: 1.5, repeat: Infinity }}
          className={`w-3 h-3 rounded-full ${peerConnected ? "bg-emerald-400" : "bg-slate-600"}`}
        />
        <div>
          <div className="font-medium text-slate-100">
            {peerConnected
              ? "Connected to Peer"
              : connectionState === "waiting"
                ? "Waiting for Peer"
                : "Connecting..."}
          </div>
          <div className="text-xs text-slate-400">State: {connectionState}</div>
        </div>
      </div>
      {peerConnected && (
        <div className="flex gap-4 mt-2 text-xs">
          <div
            className={`px-2 py-1 rounded flat-button ${
              channelsReady.chat
                ? "bg-emerald-500/20 text-emerald-300"
                : "bg-amber-500/20 text-amber-300"
            }`}
          >
            Chat: {channelsReady.chat ? "Ready" : "Connecting..."}
          </div>
          <div
            className={`px-2 py-1 rounded flat-button ${
              channelsReady.file
                ? "bg-emerald-500/20 text-emerald-300"
                : "bg-amber-500/20 text-amber-300"
            }`}
          >
            File: {channelsReady.file ? "Ready" : "Connecting..."}
          </div>
        </div>
      )}
    </motion.div>
  );
};

export default StatusDisplay;
