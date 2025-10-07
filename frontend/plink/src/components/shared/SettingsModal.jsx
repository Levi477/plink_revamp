import React, { useState } from "react";
import { motion } from "framer-motion";
import { DEFAULT_CHUNK_SIZE } from "../../utils/constants";

const SettingsModal = ({ isOpen, onClose, settings, onSettingsChange }) => {
  const [localSettings, setLocalSettings] = useState(settings);

  const handleSave = () => {
    onSettingsChange(localSettings);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.9, opacity: 0 }}
        className="liquid-glass rounded-2xl p-6 w-96 max-w-full mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold mb-4">Settings</h3>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-2">
              Chunk Size: {Math.round(localSettings.chunkSize / 1024)} KB
            </label>
            <input
              type="range"
              min="64"
              max="2048"
              step="64"
              value={Math.round(localSettings.chunkSize / 1024)}
              onChange={(e) =>
                setLocalSettings((prev) => ({
                  ...prev,
                  chunkSize: parseInt(e.target.value, 10) * 1024,
                }))
              }
              className="w-full"
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="compression"
              checked={localSettings.compression}
              onChange={(e) =>
                setLocalSettings((prev) => ({
                  ...prev,
                  compression: e.target.checked,
                }))
              }
              className="rounded"
            />
            <label htmlFor="compression" className="text-sm">
              Enable Compression
            </label>
          </div>
        </div>
        <div className="flex gap-2 mt-6">
          <button
            onClick={onClose}
            className="flex-1 py-2 px-4 bg-slate-700/50 hover:bg-slate-700 rounded-xl transition"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="flex-1 py-2 px-4 bg-blue-600 hover:bg-blue-500 rounded-xl transition"
          >
            Save
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
};

export default SettingsModal;
