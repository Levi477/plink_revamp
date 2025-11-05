import React, { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Upload, Loader2 } from "lucide-react";

import Starfield from "./components/shared/Starfield";
import SettingsModal from "./components/shared/SettingsModal";
import Header from "./components/Header";
import JoinRoom from "./components/JoinRoom";
import StatusDisplay from "./components/StatusDisplay";
import Chat from "./components/Chat";
import FileActions from "./components/FileActions";
import TransferStats from "./components/TransferStats";

import { usePeerConnection } from "./hooks/usePeerConnection";
import { processAndZipFolder } from "./services/fileHandler";
import { DEFAULT_CHUNK_SIZE } from "./utils/constants";
import { log } from "./utils/logger";

import "./index.css";

export default function App() {
  // --- UI State Management ---
  const [isDragging, setIsDragging] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [isZipping, setIsZipping] = useState(false);
  const [settings, setSettings] = useState({
    chunkSize: DEFAULT_CHUNK_SIZE,
    compression: true,
  });

  // --- New state for password ---
  const [password, setPassword] = useState("");

  // --- Core Logic Hook ---
  // All the complex WebRTC/Socket logic is handled by this custom hook.
  // We get the 'joinRoom' function from it.
  const {
    roomName,
    setRoomName,
    isConnected,
    peerConnected,
    messages,
    setMessages,
    error,
    transferStats,
    speedData,
    connectionState,
    channelsReady,
    joinRoom, // This function now expects the password
    leaveRoom,
    sendMessage,
    sendFile,
    serverOnline,
  } = usePeerConnection(settings);

  // --- Event Handlers ---

  /**
   * Wrapper for the `leaveRoom` hook.
   * We add logic to also clear the password when leaving.
   */
  const handleLeaveRoom = () => {
    leaveRoom();
    setPassword(""); // Clear password on leave
  };

  /**
   * Handles zipping a folder before sending.
   */
  const handleSendFolder = useCallback(
    async (files) => {
      setIsZipping(true);
      try {
        await processAndZipFolder(files, sendFile, setMessages);
      } catch (err) {
        log("Folder processing failed", err.message);
      } finally {
        setIsZipping(false);
      }
    },
    [sendFile, setMessages],
  );

  // --- Effects ---

  // Effect for handling drag-and-drop functionality
  useEffect(() => {
    const handleDragOver = (e) => {
      e.preventDefault();
      if (peerConnected && channelsReady.file && !isZipping) {
        setIsDragging(true);
      }
    };
    const handleDragLeave = (e) => {
      e.preventDefault();
      setIsDragging(false);
    };
    const handleDrop = async (e) => {
      e.preventDefault();
      setIsDragging(false);
      if (!peerConnected || !channelsReady.file || isZipping) {
        return;
      }
      if (!e.dataTransfer.files?.length) {
        return;
      }
      if (e.dataTransfer.files.length === 1) {
        await sendFile(e.dataTransfer.files[0]);
      } else {
        await handleSendFolder(e.dataTransfer.files);
      }
    };

    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("drop", handleDrop);

    return () => {
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("dragleave", handleDragLeave);
      window.removeEventListener("drop", handleDrop);
    };
  }, [
    peerConnected,
    channelsReady.file,
    isZipping,
    sendFile,
    handleSendFolder,
  ]);

  return (
    <div className="min-h-screen bg-black text-slate-200 font-sans p-4 sm:p-6 lg:p-8">
      <Starfield />

      {/* --- Modals and Overlays --- */}
      <AnimatePresence>
        {isDragging && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-md"
          >
            <div className="flex flex-col items-center gap-4 p-12 border-2 border-dashed border-cyan-400 rounded-3xl liquid-glass shining-effect">
              <Upload className="w-16 h-16 text-cyan-400" />
              <p className="text-xl font-bold">Drop File or Folder to Send</p>
            </div>
          </motion.div>
        )}
        {isZipping && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md"
          >
            <div className="flex flex-col items-center gap-4 p-12 liquid-glass shining-effect rounded-3xl">
              <Loader2 className="w-16 h-16 text-blue-400 animate-spin" />
              <p className="text-xl font-bold">Zipping Folder...</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <SettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        settings={settings}
        onSettingsChange={setSettings}
      />

      {/* --- Main Layout --- */}
      <div className="max-w-7xl mx-auto relative z-10">
        <Header
          serverOnline={serverOnline}
          isConnected={isConnected}
          leaveRoom={handleLeaveRoom} // Use the new wrapper function
          roomName={roomName}
        />
        <main>
          {!isConnected ? (
            // --- Join Room View ---
            // Pass down password state and the wrapped joinRoom function
            <JoinRoom
              roomName={roomName}
              setRoomName={setRoomName}
              password={password}
              setPassword={setPassword}
              joinRoom={() => joinRoom(password)} // Pass the password to the hook's function
              error={error}
              serverOnline={serverOnline}
            />
          ) : (
            // --- Connected View ---
            <>
              <StatusDisplay
                isConnected={isConnected}
                peerConnected={peerConnected}
                connectionState={connectionState}
                channelsReady={channelsReady}
              />
              <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
                <Chat
                  messages={messages}
                  sendMessage={sendMessage}
                  channelsReady={channelsReady}
                />
                <motion.aside
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="lg:col-span-2 space-y-6"
                >
                  <FileActions
                    channelsReady={channelsReady}
                    isZipping={isZipping}
                    onFileSelect={sendFile}
                    onFolderSelect={handleSendFolder}
                  />
                  <TransferStats
                    transferStats={transferStats}
                    speedData={speedData}
                  />
                </motion.aside>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
