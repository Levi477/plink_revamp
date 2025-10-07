// src/components/FileActions.jsx
import React from "react";
import { Upload, Folder } from "lucide-react";

const FileActions = ({
  channelsReady,
  isZipping,
  onFileSelect,
  onFolderSelect,
}) => {
  const handleFileChange = (e) => {
    if (e.target.files?.[0]) {
      onFileSelect(e.target.files[0]);
      e.target.value = ""; // Reset input to allow selecting the same file again
    }
  };

  const handleFolderChange = (e) => {
    if (e.target.files?.length) {
      onFolderSelect(e.target.files);
      e.target.value = "";
    }
  };

  const isReady = channelsReady.file && !isZipping;

  return (
    <div className="liquid-glass shining-effect rounded-2xl p-6">
      <h3 className="font-semibold mb-4 text-lg">Send Files</h3>
      <div className="flex gap-2 mb-2">
        <input
          id="file-input"
          type="file"
          className="hidden"
          onChange={handleFileChange}
          disabled={!isReady}
        />
        <label
          htmlFor="file-input"
          className={`flex-1 flex items-center justify-center gap-3 py-3 rounded-xl cursor-pointer transition-all flat-button ${
            isReady
              ? "bg-blue-600/80 hover:bg-blue-600"
              : "bg-slate-700 opacity-50 cursor-not-allowed"
          }`}
        >
          <Upload className="w-5 h-5" />
          <span className="font-medium">File</span>
        </label>

        <input
          id="folder-input"
          type="file"
          webkitdirectory=""
          directory=""
          multiple
          className="hidden"
          onChange={handleFolderChange}
          disabled={!isReady}
        />
        <label
          htmlFor="folder-input"
          className={`flex-1 flex items-center justify-center gap-3 py-3 rounded-xl cursor-pointer transition-all flat-button ${
            isReady
              ? "bg-cyan-600/80 hover:bg-cyan-600"
              : "bg-slate-700 opacity-50 cursor-not-allowed"
          }`}
        >
          <Folder className="w-5 h-5" />
          <span className="font-medium">Folder</span>
        </label>
      </div>
      <p className="text-xs text-slate-400 text-center">
        {isReady
          ? "Or drag & drop anywhere"
          : isZipping
            ? "Zipping in progress..."
            : "File channel connecting..."}
      </p>
    </div>
  );
};

export default FileActions;
