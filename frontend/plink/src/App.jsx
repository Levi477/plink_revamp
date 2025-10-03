import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Send,
  Wifi,
  WifiOff,
  Upload,
  Download,
  Users,
  AlertCircle,
  Activity,
  Zap,
  Settings,
  Folder,
  LogOut,
  Loader2,
} from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { io } from "socket.io-client";
import { motion, AnimatePresence } from "framer-motion";
import pako from "pako";

// --- CONFIG ---
const DEFAULT_CHUNK_SIZE = 256 * 1024;
const SERVER_URL = "https://plink-revamp-backend.onrender.com";

// --- IndexedDB functions (unchanged) ---
function openDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("plink-file-transfer-db", 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("chunks")) {
        db.createObjectStore("chunks", { keyPath: ["fileId", "index"] });
      }
      if (!db.objectStoreNames.contains("files")) {
        db.createObjectStore("files", { keyPath: "fileId" });
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function storeChunkIndexedDB(fileId, index, data) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["chunks"], "readwrite");
    tx.objectStore("chunks").put({ fileId, index, data });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function saveFileMetadataIndexedDB(fileMeta) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["files"], "readwrite");
    tx.objectStore("files").put(fileMeta);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function readAllChunksIndexedDB(fileId, totalChunks) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["chunks"], "readonly");
    const store = tx.objectStore("chunks");
    const chunks = new Array(totalChunks);
    let got = 0;

    const req = store.openCursor();
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        const { fileId: fId, index, data } = cursor.value;
        if (fId === fileId) {
          chunks[index] = data;
          got++;
        }
        cursor.continue();
      }
    };

    tx.oncomplete = () => {
      resolve(chunks.filter((c) => c));
    };
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteFileIndexedDB(fileId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["chunks", "files"], "readwrite");
    const storeC = tx.objectStore("chunks");
    const req = storeC.openCursor();
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        if (cursor.value.fileId === fileId) cursor.delete();
        cursor.continue();
      }
    };
    tx.objectStore("files").delete(fileId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- Enhanced Starfield Background Component (unchanged) ---
const Starfield = () => {
  const canvasRef = useRef(null);
  const mousePosRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    let animationFrameId;

    const resizeCanvas = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    const handleMouseMove = (e) => {
      mousePosRef.current = {
        x: (e.clientX / window.innerWidth - 0.5) * 0.5,
        y: (e.clientY / window.innerHeight - 0.5) * 0.5,
      };
    };

    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);
    window.addEventListener("mousemove", handleMouseMove);

    const stars = [];
    const starCount = 200;

    for (let i = 0; i < starCount; i++) {
      stars.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        size: Math.random() * 1.2 + 0.3,
        speed: Math.random() * 0.2 + 0.05,
        opacity: Math.random() * 0.7 + 0.3,
        depth: Math.random() * 0.5 + 0.2,
      });
    }

    const render = () => {
      ctx.fillStyle = "black";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      stars.forEach((star) => {
        const parallaxX = mousePosRef.current.x * 5 * star.depth;
        const parallaxY = mousePosRef.current.y * 5 * star.depth;

        let x = star.x + parallaxX;
        let y = star.y + parallaxY + star.speed;

        if (x > canvas.width) x = 0;
        if (x < 0) x = canvas.width;
        if (y > canvas.height) y = 0;
        if (y < 0) y = canvas.height;

        star.x = x;
        star.y = y;

        ctx.beginPath();
        ctx.arc(x, y, star.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${star.opacity})`;
        ctx.fill();
      });

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener("resize", resizeCanvas);
      window.removeEventListener("mousemove", handleMouseMove);
    };
  }, []);

  return <canvas ref={canvasRef} className="fixed inset-0 z-0" />;
};

// --- Helper Component for Animated Stats (unchanged) ---
const AnimatedStat = ({ value, unit }) => {
  return (
    <motion.span
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5 }}
    >
      {value}
      <span className="text-sm text-slate-400">{unit}</span>
    </motion.span>
  );
};

// --- Helper Component for Radial Progress (unchanged) ---
const RadialProgress = ({ progress }) => {
  const radius = 50;
  const stroke = 8;
  const normalizedRadius = radius - stroke * 2;
  const circumference = normalizedRadius * 2 * Math.PI;
  const strokeDashoffset = circumference - (progress / 100) * circumference;

  return (
    <div className="relative flex items-center justify-center w-32 h-32">
      <svg
        height="100%"
        width="100%"
        viewBox="0 0 120 120"
        className="transform -rotate-90"
      >
        <circle
          stroke="rgba(255, 255, 255, 0.1)"
          fill="transparent"
          strokeWidth={stroke}
          r={normalizedRadius}
          cx={radius + stroke}
          cy={radius + stroke}
        />
        <motion.circle
          stroke="url(#progressGradient)"
          fill="transparent"
          strokeWidth={stroke}
          strokeLinecap="round"
          r={normalizedRadius}
          cx={radius + stroke}
          cy={radius + stroke}
          style={{ strokeDasharray: circumference, strokeDashoffset }}
          animate={{ strokeDashoffset }}
          transition={{ duration: 0.5 }}
        />
        <defs>
          <linearGradient
            id="progressGradient"
            x1="0%"
            y1="0%"
            x2="100%"
            y2="100%"
          >
            <stop offset="0%" stopColor="#3b82f6" />
            <stop offset="100%" stopColor="#06b6d4" />
          </linearGradient>
        </defs>
      </svg>
      <div className="absolute flex flex-col items-center justify-center">
        <span className="text-2xl font-bold">
          <AnimatedStat value={progress.toFixed(1)} unit="%" />
        </span>
      </div>
    </div>
  );
};

// --- Settings Modal Component (unchanged) ---
const SettingsModal = ({ isOpen, onClose, settings, onSettingsChange }) => {
  const [localSettings, setLocalSettings] = useState(settings);

  const handleSave = () => {
    onSettingsChange(localSettings);
    onClose();
  };

  const runBenchmark = async () => {
    const testData = new Uint8Array(2 * 1024 * 1024);
    const chunkSizes = [64 * 1024, 128 * 1024, 256 * 1024, 512 * 1024];
    let bestChunkSize = DEFAULT_CHUNK_SIZE;
    let bestSpeed = 0;

    for (const chunkSize of chunkSizes) {
      const startTime = performance.now();
      let chunks = 0;

      for (let i = 0; i < testData.length; i += chunkSize) {
        chunks++;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }

      const endTime = performance.now();
      const speed = testData.length / (endTime - startTime);

      if (speed > bestSpeed) {
        bestSpeed = speed;
        bestChunkSize = chunkSize;
      }
    }

    setLocalSettings((prev) => ({
      ...prev,
      chunkSize: bestChunkSize,
    }));
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
                  chunkSize: parseInt(e.target.value) * 1024,
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

          <button
            onClick={runBenchmark}
            className="w-full py-2 px-4 bg-blue-600/50 hover:bg-blue-600 rounded-xl transition"
          >
            Auto Optimize Chunk Size
          </button>
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

export default function P2PFileSharing() {
  const [roomName, setRoomName] = useState("");
  const [serverOnline, setServerOnline] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [peerConnected, setPeerConnected] = useState(false);
  const [messages, setMessages] = useState([]);
  const [messageInput, setMessageInput] = useState("");
  const [error, setError] = useState("");
  const [transferStats, setTransferStats] = useState(null);
  const [speedData, setSpeedData] = useState([]);
  const [connectionState, setConnectionState] = useState("idle");
  const [isDragging, setIsDragging] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [isZipping, setIsZipping] = useState(false);
  const [settings, setSettings] = useState({
    chunkSize: DEFAULT_CHUNK_SIZE,
    compression: true,
  });

  const socketRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const dataChannelRef = useRef(null);
  const fileChannelRef = useRef(null);
  const fileWriterMapRef = useRef({});
  const fileMetaRef = useRef({});
  const receivedCountRef = useRef({});
  const isFinalizingRef = useRef({});
  const startTimeRef = useRef(0);
  const roomIdRef = useRef(null);
  const pendingIceCandidatesRef = useRef([]);
  const channelsReadyRef = useRef({ chat: false, file: false });
  const maxTimeRef = useRef(0);

  // --- FIX: Add a ref to store promise resolvers for transfer completion ---
  const transferCompletionResolversRef = useRef(new Map());

  // --- NEW: Add helper function for robust ACK waiting ---
  const waitForAck = useCallback((fileId, timeout = 45000) => {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();

      const checkInterval = setInterval(() => {
        // Check if ACK was received
        if (!transferCompletionResolversRef.current.has(fileId)) {
          clearInterval(checkInterval);
          resolve();
          return;
        }

        // Check timeout
        if (Date.now() - startTime > timeout) {
          clearInterval(checkInterval);
          transferCompletionResolversRef.current.delete(fileId);
          reject(new Error(`ACK timeout for file: ${fileId}`));
        }
      }, 100);
    });
  }, []);

  // --- NEW: Add transfer validation helper ---
  const validateTransfer = useCallback(
    (expectedSize, actualSize, expectedChunks, actualChunks) => {
      const sizeMatch = Math.abs(expectedSize - actualSize) < 1024; // Within 1KB
      const chunksMatch = expectedChunks === actualChunks;

      if (!sizeMatch) {
        log(`Size mismatch: expected ${expectedSize}, got ${actualSize}`, {
          difference: expectedSize - actualSize,
        });
      }
      if (!chunksMatch) {
        log(
          `Chunk count mismatch: expected ${expectedChunks}, got ${actualChunks}`,
        );
      }

      return sizeMatch && chunksMatch;
    },
    [],
  );

  const log = useCallback((message, data = null) => {
    const timestamp = new Date().toISOString().split("T")[1].slice(0, -1);
    console.log(`[${timestamp}] ${message}`, data || "");
  }, []);

  const checkServerStatus = async () => {
    try {
      const res = await fetch(`${SERVER_URL}/health`);
      const data = await res.json();
      setServerOnline(data.status === "online");
      if (
        data.status === "online" &&
        error === "Cannot contact signaling server"
      ) {
        setError("");
      }
    } catch (e) {
      setServerOnline(false);
      setError("Cannot contact signaling server");
    }
  };

  useEffect(() => {
    checkServerStatus();
    const id = setInterval(checkServerStatus, 10000);
    return () => clearInterval(id);
  }, [error]);

  const sendWithBackpressure = useCallback(
    (channel, data) => {
      return new Promise((resolve, reject) => {
        const trySend = () => {
          if (channel.readyState !== "open") {
            return reject(new Error("Data channel is not open."));
          }
          const maxBuffer = settings.chunkSize * 16;
          if (channel.bufferedAmount < maxBuffer) {
            try {
              channel.send(data);
              resolve();
            } catch (e) {
              reject(e);
            }
          } else {
            channel.addEventListener("bufferedamountlow", trySend, {
              once: true,
            });
          }
        };
        trySend();
      });
    },
    [settings.chunkSize],
  );

  const setupFileChannel = useCallback(
    (channel) => {
      log("Setting up file channel");
      fileChannelRef.current = channel;
      channel.binaryType = "arraybuffer";

      channel.onopen = () => {
        log("File channel opened - ready state:", channel.readyState);
        channelsReadyRef.current.file = true;
        setMessages((p) => [
          ...p,
          { type: "system", text: "File transfer ready" },
        ]);
      };

      channel.onclose = () => {
        log("File channel closed");
        channelsReadyRef.current.file = false;
        setMessages((p) => [
          ...p,
          { type: "system", text: "File channel disconnected" },
        ]);
      };

      channel.onerror = (e) => {
        log("File channel error", e);
        setError("File channel error occurred");
      };

      channel.onmessage = async (ev) => {
        try {
          if (typeof ev.data === "string") {
            const message = JSON.parse(ev.data);

            if (message.type === "file-metadata") {
              const meta = message;
              log("Received file metadata", meta);

              fileMetaRef.current[meta.fileId] = meta;
              receivedCountRef.current[meta.fileId] = 0;
              isFinalizingRef.current[meta.fileId] = false;
              startTimeRef.current = Date.now();
              maxTimeRef.current = 0;

              setTransferStats({
                fileName: meta.name,
                totalSize: meta.size,
                receivedSize: 0,
                progress: 0,
                speed: 0,
                chunks: 0,
                totalChunks: meta.chunks || 0,
                compressed: meta.compressed || false,
              });
              setSpeedData([]);

              if (window.showSaveFilePicker) {
                try {
                  // Remove .zip extension if it was added for compression
                  const suggestedName =
                    meta.compressed && meta.name.endsWith(".zip")
                      ? meta.name.slice(0, -4)
                      : meta.name;

                  const handle = await window.showSaveFilePicker({
                    suggestedName: suggestedName,
                  });
                  const writable = await handle.createWritable();
                  fileWriterMapRef.current[meta.fileId] = { writable, handle };
                } catch (e) {
                  log("User cancelled save picker or not supported", e.message);
                  // Continue with IndexedDB fallback
                }
              }
              await saveFileMetadataIndexedDB({ fileId: meta.fileId, meta });
            } else if (message.type === "transfer-complete-ack") {
              log(`Received ACK for ${message.fileId}`);
              const resolve = transferCompletionResolversRef.current.get(
                message.fileId,
              );
              if (resolve) {
                resolve(); // This signals the sender's sendFile function to proceed
                transferCompletionResolversRef.current.delete(message.fileId);
              }
            }
          } else {
            // Handle binary chunk data (receiver side)
            const buf = ev.data;
            const fileIds = Object.keys(fileMetaRef.current || {});
            if (fileIds.length === 0) return;
            const fileId = fileIds[0];

            if (!fileMetaRef.current[fileId]) return;

            const currentChunkIndex = receivedCountRef.current[fileId];
            receivedCountRef.current[fileId]++;
            const receivedChunks = receivedCountRef.current[fileId];

            const fw = fileWriterMapRef.current[fileId];
            if (fw && fw.writable) {
              await fw.writable.write(new Uint8Array(buf));
            } else {
              await storeChunkIndexedDB(fileId, currentChunkIndex, buf);
            }

            // Update stats
            setTransferStats((prevStats) => {
              if (!prevStats) return prevStats;
              const newReceived = prevStats.receivedSize + buf.byteLength;
              const totalSize = fileMetaRef.current[fileId].size;
              const elapsed = Math.max(
                (Date.now() - startTimeRef.current) / 1000,
                0.001,
              );
              const speed = newReceived / elapsed;
              const progress = (newReceived / totalSize) * 100;
              return {
                ...prevStats,
                receivedSize: newReceived,
                progress,
                speed,
                chunks: receivedChunks,
              };
            });

            const elapsed = (Date.now() - startTimeRef.current) / 1000;
            if (elapsed > maxTimeRef.current) {
              maxTimeRef.current = elapsed;
              const speed =
                (receivedCountRef.current[fileId] * settings.chunkSize) /
                Math.max(elapsed, 0.001);
              setSpeedData((prev) => [
                ...prev,
                {
                  time: parseFloat(elapsed.toFixed(1)),
                  speed: parseFloat((speed / 1024 / 1024).toFixed(2)),
                },
              ]);
            }

            const totalChunks = fileMetaRef.current[fileId].chunks;

            if (
              receivedChunks >= totalChunks &&
              !isFinalizingRef.current[fileId]
            ) {
              isFinalizingRef.current[fileId] = true;
              log("All chunks received - finalizing", { fileId });

              try {
                // --- NEW: Handle decompression if file was compressed ---
                const meta = fileMetaRef.current[fileId];
                let finalBlob;

                if (fw && fw.writable) {
                  // FileSystem API path
                  await fw.writable.close();
                  log("File saved via FileSystem API");

                  // For FileSystem API, we need to handle decompression by reading back the file
                  if (meta.compressed) {
                    setMessages((p) => [
                      ...p,
                      { type: "system", text: "Decompressing file..." },
                    ]);

                    const file = await fw.handle.getFile();
                    const arrayBuffer = await file.arrayBuffer();
                    const decompressed = pako.inflate(
                      new Uint8Array(arrayBuffer),
                    );

                    // Create new file with decompressed content
                    const newHandle = await window.showSaveFilePicker({
                      suggestedName: meta.name.endsWith(".zip")
                        ? meta.name.slice(0, -4)
                        : meta.name,
                    });
                    const newWritable = await newHandle.createWritable();
                    await newWritable.write(decompressed);
                    await newWritable.close();

                    // Remove the original compressed file
                    await fw.handle.remove();

                    log("File decompressed and saved");
                    setMessages((p) => [
                      ...p,
                      {
                        type: "system",
                        text: `Downloaded and decompressed: ${meta.name}`,
                      },
                    ]);
                  } else {
                    setMessages((p) => [
                      ...p,
                      {
                        type: "system",
                        text: `Downloaded: ${meta.name}`,
                      },
                    ]);
                  }
                } else {
                  // IndexedDB path
                  const chunksArr = await readAllChunksIndexedDB(
                    fileId,
                    totalChunks,
                  );
                  if (chunksArr.length === totalChunks) {
                    let blobData = chunksArr;

                    // --- NEW: Decompress if needed ---
                    if (meta.compressed) {
                      setMessages((p) => [
                        ...p,
                        { type: "system", text: "Decompressing file..." },
                      ]);

                      // Combine all chunks into single array buffer for decompression
                      const totalSize = chunksArr.reduce(
                        (sum, chunk) => sum + chunk.byteLength,
                        0,
                      );
                      const combined = new Uint8Array(totalSize);
                      let offset = 0;
                      chunksArr.forEach((chunk) => {
                        combined.set(new Uint8Array(chunk), offset);
                        offset += chunk.byteLength;
                      });

                      // Decompress
                      const decompressed = pako.inflate(combined);
                      blobData = [decompressed.buffer];

                      log("File decompressed from chunks", {
                        original: totalSize,
                        decompressed: decompressed.length,
                      });
                    }

                    finalBlob = new Blob(blobData, {
                      type: meta.mimeType || "application/octet-stream",
                    });

                    const url = URL.createObjectURL(finalBlob);
                    const a = document.createElement("a");
                    a.href = url;

                    // Use original name (remove .zip if it was added for compression)
                    const downloadName =
                      meta.compressed && meta.name.endsWith(".zip")
                        ? meta.name.slice(0, -4)
                        : meta.name;
                    a.download = downloadName;

                    document.body.appendChild(a);
                    a.click();
                    setTimeout(() => {
                      document.body.removeChild(a);
                      URL.revokeObjectURL(url);
                    }, 100);

                    setMessages((p) => [
                      ...p,
                      {
                        type: "system",
                        text: `Downloaded${meta.compressed ? " and decompressed" : ""}: ${downloadName}`,
                      },
                    ]);
                  } else {
                    setError(
                      `Incomplete transfer: Expected ${totalChunks}, got ${chunksArr.length}`,
                    );
                    throw new Error(
                      `Incomplete transfer: Expected ${totalChunks}, got ${chunksArr.length}`,
                    );
                  }
                }

                // Validate transfer completeness
                const isValid = validateTransfer(
                  meta.size,
                  finalBlob ? finalBlob.size : meta.compressedSize,
                  meta.chunks,
                  receivedChunks,
                );

                if (!isValid) {
                  log("Transfer validation failed", {
                    expectedSize: meta.size,
                    actualSize: finalBlob
                      ? finalBlob.size
                      : meta.compressedSize,
                    expectedChunks: meta.chunks,
                    actualChunks: receivedChunks,
                  });
                  setError(
                    "Transfer validation failed - file may be corrupted",
                  );
                }

                // --- FIX: Send acknowledgment ONLY AFTER successful processing and saving ---
                const completeMessage = {
                  type: "transfer-complete-ack",
                  fileId,
                };
                if (
                  fileChannelRef.current &&
                  fileChannelRef.current.readyState === "open"
                ) {
                  fileChannelRef.current.send(JSON.stringify(completeMessage));
                  log("Sent transfer completion ACK");
                }
              } catch (processingError) {
                log(
                  "Error during file processing/saving",
                  processingError.message,
                );
                setError("File processing error: " + processingError.message);

                // Don't send ACK if processing failed
                return;
              } finally {
                // Cleanup regardless of success/failure
                await deleteFileIndexedDB(fileId);
                delete fileMetaRef.current[fileId];
                delete receivedCountRef.current[fileId];
                delete fileWriterMapRef.current[fileId];
                delete isFinalizingRef.current[fileId];
              }

              setTimeout(() => {
                setTransferStats(null);
                setSpeedData([]);
                maxTimeRef.current = 0;
              }, 3000);
            }
          }
        } catch (e) {
          log("Error handling incoming file channel message", e.message);
          setError("File receive error: " + e.message);
        }
      };
    },
    [log, settings.chunkSize, validateTransfer],
  );

  const setupChatChannel = useCallback(
    (channel) => {
      log("Setting up chat channel");
      dataChannelRef.current = channel;
      channel.onopen = () => {
        log("Chat channel opened");
        channelsReadyRef.current.chat = true;
        setMessages((p) => [...p, { type: "system", text: "Chat ready" }]);
      };
      channel.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.type === "message") {
            setMessages((p) => [...p, { type: "received", text: data.text }]);
          }
        } catch (e) {
          log("Error parsing chat message", e);
        }
      };
      channel.onclose = () => {
        log("Chat channel closed");
        channelsReadyRef.current.chat = false;
      };
      channel.onerror = (e) => {
        log("Chat channel error", e);
      };
    },
    [log],
  );

  const createPeerConnection = useCallback(
    async (isOfferer) => {
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
      }
      channelsReadyRef.current = { chat: false, file: false };
      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
        ],
      });
      peerConnectionRef.current = pc;
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socketRef.current.emit("ice-candidate", {
            roomId: roomIdRef.current,
            candidate: event.candidate,
          });
        }
      };
      pc.onconnectionstatechange = () => {
        log("Connection state changed", pc.connectionState);
        setConnectionState(pc.connectionState);
        if (pc.connectionState === "connected") {
          setPeerConnected(true);
          setError("");
          setMessages((p) => [
            ...p,
            { type: "system", text: "P2P Connection Established" },
          ]);
        } else if (
          ["disconnected", "failed", "closed"].includes(pc.connectionState)
        ) {
          setPeerConnected(false);
          channelsReadyRef.current = { chat: false, file: false };
          if (pc.connectionState !== "closed") setError("Connection lost");
        }
      };
      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === "failed") {
          pc.restartIce();
        }
      };
      if (isOfferer) {
        const chatChannel = pc.createDataChannel("chat");
        setupChatChannel(chatChannel);
        const fileChannel = pc.createDataChannel("file", { ordered: true });
        fileChannel.bufferedAmountLowThreshold = settings.chunkSize * 4;
        setupFileChannel(fileChannel);
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socketRef.current.emit("offer", {
            roomId: roomIdRef.current,
            offer: pc.localDescription,
          });
          log("Offer created and sent");
        } catch (e) {
          log("Error creating offer", e.message);
          setError("Failed to create connection offer");
        }
      } else {
        pc.ondatachannel = (event) => {
          if (event.channel.label === "chat") {
            setupChatChannel(event.channel);
          } else if (event.channel.label === "file") {
            event.channel.bufferedAmountLowThreshold = settings.chunkSize * 4;
            setupFileChannel(event.channel);
          }
        };
      }
    },
    [log, setupFileChannel, setupChatChannel, settings.chunkSize],
  );

  const cleanupPeerConnection = () => {
    pendingIceCandidatesRef.current = [];
    if (dataChannelRef.current) dataChannelRef.current.close();
    dataChannelRef.current = null;
    if (fileChannelRef.current) fileChannelRef.current.close();
    fileChannelRef.current = null;
    if (peerConnectionRef.current) peerConnectionRef.current.close();
    peerConnectionRef.current = null;
    setPeerConnected(false);
    channelsReadyRef.current = { chat: false, file: false };
  };

  const sendFile = useCallback(
    async (file) => {
      if (
        !file ||
        !fileChannelRef.current ||
        fileChannelRef.current.readyState !== "open"
      ) {
        setError(
          `File channel not ready. State: ${fileChannelRef.current?.readyState}`,
        );
        return;
      }
      log("Starting file transfer", { name: file.name, size: file.size });
      let fileToSend = file;
      let isCompressed = false;
      let originalSize = file.size;

      if (settings.compression && file.type !== "application/zip") {
        try {
          setMessages((p) => [
            ...p,
            { type: "system", text: "Compressing file..." },
          ]);
          const arrayBuffer = await file.arrayBuffer();
          const compressed = pako.deflate(new Uint8Array(arrayBuffer));
          fileToSend = new File([compressed], file.name + ".zip", {
            type: "application/octet-stream",
          });
          isCompressed = true;
          log("File compressed", {
            original: originalSize,
            compressed: fileToSend.size,
          });
        } catch (e) {
          log("Compression failed, sending uncompressed", e);
        }
      }
      const totalChunks = Math.ceil(fileToSend.size / settings.chunkSize);
      const fileId = `${Date.now()}-${file.name}`;

      // Enhanced metadata with compression info
      const metadata = {
        type: "file-metadata",
        fileId,
        name: isCompressed ? `${file.name}.zip` : file.name,
        size: originalSize,
        mimeType: file.type,
        chunks: totalChunks,
        compressed: isCompressed,
        compressedSize: isCompressed ? fileToSend.size : originalSize,
        timestamp: Date.now(),
      };

      try {
        log("Sending file metadata", metadata);
        fileChannelRef.current.send(JSON.stringify(metadata));
        const startTime = Date.now();
        maxTimeRef.current = 0;
        let sentBytes = 0;
        setTransferStats({
          fileName: file.name,
          totalSize: originalSize,
          sentSize: 0,
          progress: 0,
          speed: 0,
          chunks: 0,
          totalChunks,
          compressed: isCompressed,
        });
        setSpeedData([]);

        for (let index = 0; index < totalChunks; index++) {
          if (fileChannelRef.current.readyState !== "open") {
            throw new Error("File channel closed during transfer");
          }
          const offset = index * settings.chunkSize;
          const slice = fileToSend.slice(offset, offset + settings.chunkSize);
          const arrayBuffer = await slice.arrayBuffer();
          await sendWithBackpressure(fileChannelRef.current, arrayBuffer);
          sentBytes += arrayBuffer.byteLength;
          const elapsed = (Date.now() - startTime) / 1000;
          const speed = sentBytes / Math.max(elapsed, 0.001);
          const progress = (sentBytes / fileToSend.size) * 100;
          setTransferStats((prev) => ({
            ...prev,
            sentSize: Math.min(sentBytes, fileToSend.size),
            progress,
            speed,
            chunks: index + 1,
          }));
          if (elapsed > maxTimeRef.current) {
            maxTimeRef.current = elapsed;
            setSpeedData((prev) => [
              ...prev,
              {
                time: parseFloat(elapsed.toFixed(1)),
                speed: parseFloat((speed / 1024 / 1024).toFixed(2)),
              },
            ]);
          }
        }

        log(
          `All chunks queued for ${file.name}. Waiting for receiver acknowledgment...`,
        );
        setMessages((p) => [
          ...p,
          {
            type: "system",
            text: `Sent: ${file.name}. Waiting for confirmation...`,
          },
        ]);

        // --- ENHANCED: Robust ACK waiting with timeout and retry ---
        try {
          await waitForAck(fileId, 45000); // 45 second timeout
          log(`ACK received. Transfer for ${file.name} is complete.`);

          setMessages((p) => {
            const newMessages = [...p];
            // Update the waiting message to complete
            const lastMsgIndex = newMessages.length - 1;
            if (
              newMessages[lastMsgIndex]?.text.includes(
                "Waiting for confirmation",
              )
            ) {
              newMessages[lastMsgIndex] = {
                type: "system",
                text: `Transfer completed: ${file.name}`,
              };
            }
            return newMessages;
          });
        } catch (ackError) {
          log("ACK timeout or error", ackError.message);
          setError(`Transfer incomplete: ${ackError.message}`);

          setMessages((p) => [
            ...p,
            {
              type: "system",
              text: `Transfer failed: ${file.name} - ${ackError.message}`,
            },
          ]);
        } finally {
          // Cleanup regardless of ACK status
          setTimeout(() => {
            setTransferStats(null);
            setSpeedData([]);
            maxTimeRef.current = 0;
          }, 3000);

          // Clean up the resolver
          transferCompletionResolversRef.current.delete(fileId);
        }
      } catch (e) {
        log("File transfer failed", e.message);
        setError("Failed to send file: " + e.message);
        setTransferStats(null);
        setSpeedData([]);
        maxTimeRef.current = 0;
        transferCompletionResolversRef.current.delete(fileId);
      }
    },
    [
      log,
      settings.chunkSize,
      settings.compression,
      sendWithBackpressure,
      waitForAck,
    ],
  );

  const sendFolder = useCallback(
    async (files) => {
      if (!files || files.length === 0) {
        return;
      }
      setIsZipping(true);
      try {
        const filesArray = Array.from(files);
        if (filesArray.length === 0) {
          setError("No files selected");
          setIsZipping(false);
          return;
        }
        setMessages((p) => [
          ...p,
          { type: "system", text: `Zipping ${filesArray.length} files...` },
        ]);
        const JSZip = (await import("jszip")).default;
        const zip = new JSZip();
        let folderName = "folder";
        if (filesArray[0]?.webkitRelativePath) {
          folderName =
            filesArray[0].webkitRelativePath.split("/")[0] || folderName;
        } else if (filesArray.length > 1) {
          folderName = "files";
        }
        for (let i = 0; i < filesArray.length; i++) {
          const file = filesArray[i];
          const path = file.webkitRelativePath || file.name;
          const arrayBuffer = await file.arrayBuffer();
          zip.file(path, arrayBuffer);
          if (i % 10 === 0 || i === filesArray.length - 1) {
            setMessages((p) => {
              const newMessages = [...p];
              if (
                newMessages[newMessages.length - 1]?.text.includes("Zipping")
              ) {
                newMessages[newMessages.length - 1] = {
                  type: "system",
                  text: `Zipping ${i + 1}/${filesArray.length} files...`,
                };
              }
              return newMessages;
            });
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        }
        setMessages((p) => [
          ...p.slice(0, -1),
          { type: "system", text: "Generating zip file..." },
        ]);
        const zipBlob = await zip.generateAsync({
          type: "blob",
          compression: "DEFLATE",
          compressionOptions: { level: 6 },
        });
        const zipFile = new File([zipBlob], `${folderName}.zip`, {
          type: "application/zip",
        });
        setMessages((p) => [
          ...p.slice(0, -1),
          {
            type: "system",
            text: `Zip created: ${(zipFile.size / 1024 / 1024).toFixed(2)} MB`,
          },
        ]);
        setIsZipping(false);
        await sendFile(zipFile);
      } catch (error) {
        log("Folder zip error", error.message);
        setError("Failed to zip folder: " + error.message);
        setIsZipping(false);
      }
    },
    [sendFile, log],
  );

  const leaveRoom = () => {
    if (socketRef.current) {
      socketRef.current.emit("leave-room", { roomId: roomIdRef.current });
      socketRef.current.disconnect();
    }
    cleanupPeerConnection();
    setIsConnected(false);
    setPeerConnected(false);
    setRoomName("");
    setMessages([]);
    setError("");
    setConnectionState("idle");
  };

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

  useEffect(() => {
    log("Initializing socket connection");
    const socket = io(SERVER_URL, {
      path: "/socket.io",
      transports: ["websocket", "polling"],
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });
    socketRef.current = socket;
    socket.on("connect", () => log("Socket connected", socket.id));
    socket.on("connect_error", (err) => {
      log("Socket connect_error", err.message);
      setError("Signaling connection error");
    });
    socket.on("waiting-for-peer", () => {
      log("Waiting for peer");
      setIsConnected(true);
      setError("Waiting for peer...");
      setConnectionState("waiting");
    });
    socket.on("room-full", () => {
      log("Room full");
      setError("Room is full.");
      setIsConnected(false);
      setConnectionState("error");
    });
    socket.on("joined-room", ({ room, position }) => {
      log("Joined room", { room, position });
      setIsConnected(true);
      roomIdRef.current = room;
      setError(position === 2 ? "Connected. Waiting..." : "");
    });
    socket.on("user-connected", ({ userId }) => {
      log("User connected", userId);
      setError("Peer joined. Establishing...");
      setConnectionState("connecting");
      setTimeout(() => createPeerConnection(true), 500);
    });
    socket.on("offer", async ({ offer }) => {
      log("Received WebRTC offer");
      setError("Received connection request...");
      setConnectionState("connecting");
      if (!peerConnectionRef.current) await createPeerConnection(false);
      try {
        await peerConnectionRef.current.setRemoteDescription(
          new RTCSessionDescription(offer),
        );
        if (pendingIceCandidatesRef.current.length > 0) {
          for (const candidate of pendingIceCandidatesRef.current) {
            await peerConnectionRef.current.addIceCandidate(
              new RTCIceCandidate(candidate),
            );
          }
          pendingIceCandidatesRef.current = [];
        }
        const answer = await peerConnectionRef.current.createAnswer();
        await peerConnectionRef.current.setLocalDescription(answer);
        socketRef.current.emit("answer", {
          roomId: roomIdRef.current,
          answer: peerConnectionRef.current.localDescription,
        });
      } catch (e) {
        log("Error handling offer", e);
        setError("Failed to establish connection");
      }
    });
    socket.on("answer", async ({ answer }) => {
      log("Received WebRTC answer");
      if (peerConnectionRef.current) {
        try {
          await peerConnectionRef.current.setRemoteDescription(
            new RTCSessionDescription(answer),
          );
          if (pendingIceCandidatesRef.current.length > 0) {
            for (const candidate of pendingIceCandidatesRef.current) {
              await peerConnectionRef.current.addIceCandidate(
                new RTCIceCandidate(candidate),
              );
            }
            pendingIceCandidatesRef.current = [];
          }
        } catch (e) {
          log("Error setting remote description from answer", e);
        }
      }
    });
    socket.on("ice-candidate", async ({ candidate }) => {
      if (!candidate) return;
      try {
        if (peerConnectionRef.current?.remoteDescription) {
          await peerConnectionRef.current.addIceCandidate(
            new RTCIceCandidate(candidate),
          );
        } else {
          pendingIceCandidatesRef.current.push(candidate);
        }
      } catch (e) {
        log("Error adding received ICE candidate", e.message);
      }
    });
    socket.on("user-disconnected", ({ userId }) => {
      log("User disconnected", userId);
      setPeerConnected(false);
      setConnectionState("disconnected");
      setMessages((p) => [...p, { type: "system", text: "Peer disconnected" }]);
      cleanupPeerConnection();
    });
    socket.on("join-error", ({ message }) => {
      log("Join error", message);
      setError(message);
      setConnectionState("error");
    });
    return () => {
      log("Cleaning up socket connection");
      if (socketRef.current) {
        socketRef.current.off();
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      cleanupPeerConnection();
    };
  }, [log, createPeerConnection]);

  useEffect(() => {
    const handleDragOver = (e) => {
      e.preventDefault();
      if (peerConnected && channelsReadyRef.current.file && !isZipping) {
        setIsDragging(true);
      }
    };
    const handleDragLeave = (e) => {
      e.preventDefault();
      if (e.clientX === 0 && e.clientY === 0) {
        setIsDragging(false);
      }
    };
    const handleDrop = async (e) => {
      e.preventDefault();
      setIsDragging(false);
      if (!peerConnected || !channelsReadyRef.current.file || isZipping) {
        setError("File channel not ready for transfer");
        return;
      }
      if (!e.dataTransfer.files?.length) {
        return;
      }
      try {
        if (e.dataTransfer.files.length === 1) {
          await sendFile(e.dataTransfer.files[0]);
        } else {
          await sendFolder(e.dataTransfer.files);
        }
      } catch (err) {
        log("Drop error", err.message);
        setError("Failed to process dropped files");
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
  }, [peerConnected, sendFile, sendFolder, isZipping, log]);

  const joinRoom = useCallback(() => {
    if (!roomName.trim() || !serverOnline) return;
    const socket = socketRef.current;
    if (!socket || !socket.connected) socket.connect();
    socket.emit("join-room", { roomId: roomName, userId: socket.id });
    setError("Joining room...");
  }, [roomName, serverOnline]);

  const sendMessage = useCallback(() => {
    if (!messageInput.trim() || !channelsReadyRef.current.chat) return;
    dataChannelRef.current.send(
      JSON.stringify({ type: "message", text: messageInput }),
    );
    setMessages((p) => [...p, { type: "sent", text: messageInput }]);
    setMessageInput("");
  }, [messageInput]);

  return (
    <div className="min-h-screen bg-black text-slate-200 font-sans p-4 sm:p-6 lg:p-8">
      <style>{`
        .liquid-glass {
          background: rgba(15, 23, 42, 0.4);
          backdrop-filter: blur(20px);
          border: 2px solid rgba(255, 255, 255, 0.15);
          box-shadow: 4px 4px 0px rgba(0, 0, 0, 0.3),
                     8px 8px 0px rgba(0, 0, 0, 0.2);
          transition: all 0.2s ease;
        }

        .liquid-glass:hover {
          border-color: rgba(255, 255, 255, 0.25);
          box-shadow: 4px 4px 0px rgba(59, 130, 246, 0.3),
                     8px 8px 0px rgba(0, 0, 0, 0.2);
          transform: translate(-1px, -1px);
        }

        .shining-effect {
          position: relative;
          overflow: hidden;
        }

        .shining-effect::before {
          content: '';
          position: absolute;
          top: 0;
          left: -100%;
          width: 100%;
          height: 100%;
          background: linear-gradient(
            90deg,
            transparent,
            rgba(255, 255, 255, 0.1),
            transparent
          );
          transition: left 0.5s ease;
        }

        .shining-effect:hover::before {
          left: 100%;
        }

        .flat-button {
          border: 2px solid rgba(255, 255, 255, 0.2);
          box-shadow: 2px 2px 0px rgba(0, 0, 0, 0.3);
          transition: all 0.2s ease;
        }

        .flat-button:hover {
          border-color: rgba(255, 255, 255, 0.3);
          box-shadow: 3px 3px 0px rgba(0, 0, 0, 0.3);
          transform: translate(-1px, -1px);
        }

        .recharts-tooltip-cursor {
          stroke: rgba(59, 130, 246, 0.5);
          stroke-width: 1;
        }
      `}</style>

      <Starfield />

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
      </AnimatePresence>

      <AnimatePresence>
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
              <p className="text-sm text-slate-400">
                Please wait, this may take a moment
              </p>
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

      <div className="max-w-7xl mx-auto relative z-10">
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
              {/* <button
                onClick={() => setShowSettings(true)}
                className="flex items-center gap-2 px-3 py-2 rounded-xl liquid-glass shining-effect transition-all"
              >
                <Settings className="w-5 h-5" />
              </button>*/}
              <button
                onClick={checkServerStatus}
                className={`flex items-center gap-2 px-3 py-2 rounded-xl liquid-glass transition-all ${serverOnline ? "text-emerald-400" : "text-red-400"}`}
              >
                {serverOnline ? (
                  <Wifi className="w-5 h-5" />
                ) : (
                  <WifiOff className="w-5 h-5" />
                )}
                <span className="hidden sm:inline text-sm font-medium">
                  {serverOnline ? "Online" : "Offline"}
                </span>
              </button>
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

        <main>
          {!isConnected ? (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex items-center justify-center min-h-[60vh]"
            >
              <div className="w-full max-w-md liquid-glass shining-effect rounded-3xl p-8">
                <div className="text-center mb-6">
                  <motion.div
                    animate={{ scale: [1, 1.1, 1] }}
                    transition={{
                      duration: 2,
                      repeat: Infinity,
                      ease: "easeInOut",
                    }}
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
          ) : (
            <>
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
                    <div className="text-xs text-slate-400">
                      State: {connectionState}
                    </div>
                  </div>
                </div>
                {peerConnected && (
                  <div className="flex gap-4 mt-2 text-xs">
                    <div
                      className={`px-2 py-1 rounded flat-button ${channelsReadyRef.current.chat ? "bg-emerald-500/20 text-emerald-300" : "bg-amber-500/20 text-amber-300"}`}
                    >
                      Chat:{" "}
                      {channelsReadyRef.current.chat
                        ? "Ready"
                        : "Connecting..."}
                    </div>
                    <div
                      className={`px-2 py-1 rounded flat-button ${channelsReadyRef.current.file ? "bg-emerald-500/20 text-emerald-300" : "bg-amber-500/20 text-amber-300"}`}
                    >
                      File:{" "}
                      {channelsReadyRef.current.file
                        ? "Ready"
                        : "Connecting..."}
                    </div>
                  </div>
                )}
              </motion.div>

              <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
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
                          className={`flex ${m.type === "sent" ? "justify-end" : m.type === "system" ? "justify-center" : "justify-start"}`}
                        >
                          <div
                            className={`max-w-xs px-4 py-2 rounded-2xl flat-button ${m.type === "sent" ? "bg-gradient-to-r from-blue-600 to-cyan-500" : m.type === "system" ? "bg-white/5 text-slate-300 text-xs" : "bg-slate-700/80"}`}
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
                        onKeyDown={(e) => e.key === "Enter" && sendMessage()}
                        placeholder="Type a message..."
                        disabled={!channelsReadyRef.current.chat}
                        className="flex-1 px-4 py-3 rounded-xl bg-slate-900/70 border-2 border-white/10 focus:outline-none focus:border-blue-400/50 transition disabled:opacity-50 flat-button"
                      />
                      <button
                        onClick={sendMessage}
                        disabled={
                          !channelsReadyRef.current.chat || !messageInput.trim()
                        }
                        className="px-4 py-3 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-500 hover:to-cyan-400 transition disabled:opacity-50 flat-button"
                      >
                        <Send className="w-5 h-5" />
                      </button>
                    </div>
                  </div>
                </motion.section>

                <motion.aside
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="lg:col-span-2 space-y-6"
                >
                  <div className="liquid-glass shining-effect rounded-2xl p-6">
                    <h3 className="font-semibold mb-4 text-lg">Send Files</h3>
                    <div className="flex gap-2 mb-2">
                      <input
                        id="file-input"
                        type="file"
                        className="hidden"
                        onChange={(e) => {
                          if (e.target.files?.[0]) {
                            sendFile(e.target.files[0]);
                            e.target.value = "";
                          }
                        }}
                        disabled={!channelsReadyRef.current.file || isZipping}
                      />
                      <label
                        htmlFor="file-input"
                        className={`flex-1 flex items-center justify-center gap-3 py-3 rounded-xl cursor-pointer transition-all flat-button ${channelsReadyRef.current.file && !isZipping ? "bg-blue-600/80 hover:bg-blue-600" : "bg-slate-700 opacity-50 cursor-not-allowed"}`}
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
                        onChange={(e) => {
                          if (e.target.files?.length) {
                            sendFolder(e.target.files);
                            e.target.value = "";
                          }
                        }}
                        disabled={!channelsReadyRef.current.file || isZipping}
                      />
                      <label
                        htmlFor="folder-input"
                        className={`flex-1 flex items-center justify-center gap-3 py-3 rounded-xl cursor-pointer transition-all flat-button ${channelsReadyRef.current.file && !isZipping ? "bg-cyan-600/80 hover:bg-cyan-600" : "bg-slate-700 opacity-50 cursor-not-allowed"}`}
                      >
                        <Folder className="w-5 h-5" />
                        <span className="font-medium">Folder</span>
                      </label>
                    </div>
                    <p className="text-xs text-slate-400 text-center">
                      {channelsReadyRef.current.file && !isZipping
                        ? "Or drag & drop anywhere"
                        : isZipping
                          ? "Zipping in progress..."
                          : "File channel connecting..."}
                    </p>
                  </div>

                  <AnimatePresence>
                    {transferStats && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        className="liquid-glass shining-effect rounded-2xl p-6 overflow-hidden"
                      >
                        <div className="flex items-center gap-3 mb-4">
                          {transferStats.receivedSize !== undefined ? (
                            <Download className="w-5 h-5 text-blue-400" />
                          ) : (
                            <Upload className="w-5 h-5 text-blue-400" />
                          )}
                          <h4 className="font-medium">
                            {transferStats.receivedSize !== undefined
                              ? "Download In Progress"
                              : "Upload In Progress"}
                          </h4>
                        </div>
                        <p className="text-sm text-slate-300 truncate mb-4 font-mono text-center">
                          {transferStats.fileName}
                          {transferStats.compressed && (
                            <span className="text-xs text-amber-400 ml-2">
                              (compressed)
                            </span>
                          )}
                        </p>

                        <div className="flex justify-center mb-4">
                          <RadialProgress progress={transferStats.progress} />
                        </div>

                        <div className="grid grid-cols-2 gap-4 text-sm text-center mb-4">
                          <div>
                            <div className="text-slate-400 text-xs mb-1">
                              Speed
                            </div>
                            <div className="font-mono font-medium text-lg">
                              <AnimatedStat
                                value={(
                                  (transferStats.speed || 0) /
                                  1024 /
                                  1024
                                ).toFixed(2)}
                                unit=" MB/s"
                              />
                            </div>
                          </div>
                          <div>
                            <div className="text-slate-400 text-xs mb-1">
                              Chunks
                            </div>
                            <div className="font-mono font-medium text-lg">
                              <AnimatedStat
                                value={`${transferStats.chunks}/${transferStats.totalChunks}`}
                                unit=""
                              />
                            </div>
                          </div>
                          <div>
                            <div className="text-slate-400 text-xs mb-1">
                              {transferStats.receivedSize !== undefined
                                ? "Downloaded"
                                : "Uploaded"}
                            </div>
                            <div className="font-mono font-medium text-lg">
                              <AnimatedStat
                                value={(
                                  (transferStats.sentSize ||
                                    transferStats.receivedSize ||
                                    0) /
                                  1024 /
                                  1024
                                ).toFixed(2)}
                                unit=" MB"
                              />
                            </div>
                          </div>
                          <div>
                            <div className="text-slate-400 text-xs mb-1">
                              Total Size
                            </div>
                            <div className="font-mono font-medium text-lg">
                              <AnimatedStat
                                value={(
                                  transferStats.totalSize /
                                  1024 /
                                  1024
                                ).toFixed(2)}
                                unit=" MB"
                              />
                            </div>
                          </div>
                        </div>

                        {speedData.length > 1 && (
                          <div className="mt-4 bg-slate-900/70 p-3 rounded-xl flat-button">
                            <ResponsiveContainer width="100%" height={140}>
                              <LineChart
                                data={speedData}
                                margin={{
                                  top: 5,
                                  right: 20,
                                  left: -10,
                                  bottom: 5,
                                }}
                              >
                                <CartesianGrid
                                  strokeDasharray="3 3"
                                  stroke="rgba(255,255,255,0.1)"
                                />
                                <XAxis
                                  type="number"
                                  dataKey="time"
                                  stroke="rgba(255,255,255,0.4)"
                                  fontSize={10}
                                  domain={["dataMin", "dataMax"]}
                                  tickFormatter={(value) => `${value}s`}
                                />
                                <YAxis
                                  stroke="rgba(255,255,255,0.4)"
                                  fontSize={10}
                                  tickFormatter={(value) => `${value}`}
                                  label={{
                                    value: "MB/s",
                                    angle: -90,
                                    position: "insideLeft",
                                    style: {
                                      fontSize: 10,
                                      fill: "rgba(255,255,255,0.4)",
                                    },
                                  }}
                                />
                                <Tooltip
                                  contentStyle={{
                                    backgroundColor: "rgba(15, 23, 42, 0.8)",
                                    border: "1px solid rgba(255,255,255,0.1)",
                                    borderRadius: 8,
                                    color: "#fff",
                                  }}
                                  formatter={(value) => [
                                    `${value} MB/s`,
                                    "Speed",
                                  ]}
                                />
                                <Line
                                  type="monotone"
                                  dataKey="speed"
                                  name="Speed"
                                  stroke="#3b82f6"
                                  strokeWidth={2}
                                  dot={false}
                                  isAnimationActive={false}
                                />
                              </LineChart>
                            </ResponsiveContainer>
                          </div>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.aside>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
