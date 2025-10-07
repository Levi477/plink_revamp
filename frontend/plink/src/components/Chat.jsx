import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Send } from "lucide-react";

const Chat = ({ messages, sendMessage, channelsReady }) => {
  const [messageInput, setMessageInput] = useState("");

  const handleSendMessage = () => {
    sendMessage(messageInput, setMessageInput);
  };

  return (
    <motion.section
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      className="lg:col-span-3 flex flex-col liquid-glass shining-effect rounded-2xl h-[70vh] overflow-hidden"
    >
      <div className="p-4 border-b-2 border-white/5">
        <h3 className="font-semibold text-lg">Chat</h3>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        <AnimatePresence>
          {messages.map((m, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className={`flex ${
                m.type === "sent"
                  ? "justify-end"
                  : m.type === "system"
                    ? "justify-center"
                    : "justify-start"
              }`}
            >
              <div
                className={`max-w-xs px-4 py-2 rounded-2xl flat-button ${
                  m.type === "sent"
                    ? "bg-gradient-to-r from-blue-600 to-cyan-500"
                    : m.type === "system"
                      ? "bg-white/5 text-slate-300 text-xs"
                      : "bg-slate-700/80"
                }`}
              >
                {m.text}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
      <div className="p-4 border-t-2 border-white/5">
        <div className="flex gap-2">
          <input
            value={messageInput}
            onChange={(e) => setMessageInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSendMessage()}
            placeholder="Type a message..."
            disabled={!channelsReady.chat}
            className="flex-1 px-4 py-3 rounded-xl bg-slate-900/70 border-2 border-white/10 focus:outline-none focus:border-blue-400/50 transition disabled:opacity-50 flat-button"
          />
          <button
            onClick={handleSendMessage}
            disabled={!channelsReady.chat || !messageInput.trim()}
            className="px-4 py-3 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-500 hover:to-cyan-400 transition disabled:opacity-50 flat-button"
          >
            <Send className="w-5 h-5" />
          </button>
        </div>
      </div>
    </motion.section>
  );
};

export default Chat;
