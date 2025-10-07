// src/components/Header.jsx
import React from "react";
import { Users, Wifi, WifiOff, LogOut } from "lucide-react";

const Header = ({ serverOnline, isConnected, leaveRoom, roomName }) => {
  return (
    <header className="liquid-glass shining-effect rounded-3xl p-4 sm:p-6 mb-6">
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="p-3 rounded-2xl bg-gradient-to-br from-blue-500/20 to-cyan-500/20 border-2 border-blue-400/30 shadow-md">
            <Users className="w-8 h-8 text-blue-300" />
          </div>
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold bg-gradient-to-r from-blue-400 to-cyan-300 bg-clip-text text-transparent">
              plink
            </h1>
            <p className="text-xs sm:text-sm text-slate-400 mt-1">
              Secure and Fast P2P File Transfer
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 sm:gap-4">
          <div
            className={`flex items-center gap-2 px-3 py-2 rounded-xl liquid-glass transition-all ${
              serverOnline ? "text-emerald-400" : "text-red-400"
            }`}
          >
            {serverOnline ? (
              <Wifi className="w-5 h-5" />
            ) : (
              <WifiOff className="w-5 h-5" />
            )}
            <span className="hidden sm:inline text-sm font-medium">
              {serverOnline ? "Online" : "Offline"}
            </span>
          </div>
          {isConnected && (
            <button
              onClick={leaveRoom}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-red-600/80 hover:bg-red-600 transition-all flat-button"
            >
              <LogOut className="w-4 h-4" />
              <span className="text-sm font-medium">Leave</span>
            </button>
          )}
          {roomName && isConnected && (
            <div className="liquid-glass px-4 py-2 rounded-xl">
              <div className="text-xs text-slate-400">Room</div>
              <div className="font-mono text-blue-300">{roomName}</div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};

export default Header;
