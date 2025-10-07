import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Upload, Download } from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import RadialProgress from "./shared/RadialProgress";
import AnimatedStat from "./shared/AnimatedStat";

const TransferStats = ({ transferStats, speedData }) => {
  if (!transferStats) return null;

  const isDownloading = transferStats.receivedSize !== undefined;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, height: 0 }}
        animate={{ opacity: 1, height: "auto" }}
        exit={{ opacity: 0, height: 0 }}
        className="liquid-glass shining-effect rounded-2xl p-6 overflow-hidden"
      >
        <div className="flex items-center gap-3 mb-4">
          {isDownloading ? (
            <Download className="w-5 h-5 text-blue-400" />
          ) : (
            <Upload className="w-5 h-5 text-blue-400" />
          )}
          <h4 className="font-medium">
            {isDownloading ? "Download In Progress" : "Upload In Progress"}
          </h4>
        </div>
        <p className="text-sm text-slate-300 truncate mb-4 font-mono text-center">
          {transferStats.fileName}
          {transferStats.compressed && (
            <span className="text-xs text-amber-400 ml-2">(compressed)</span>
          )}
        </p>
        <div className="flex justify-center mb-4">
          <RadialProgress progress={transferStats.progress} />
        </div>
        <div className="grid grid-cols-2 gap-4 text-sm text-center mb-4">
          <div>
            <div className="text-slate-400 text-xs mb-1">Speed</div>
            <div className="font-mono font-medium text-lg">
              <AnimatedStat
                value={((transferStats.speed || 0) / 1024 / 1024).toFixed(2)}
                unit=" MB/s"
              />
            </div>
          </div>
          <div>
            <div className="text-slate-400 text-xs mb-1">Chunks</div>
            <div className="font-mono font-medium text-lg">
              <AnimatedStat
                value={`${transferStats.chunks}/${transferStats.totalChunks}`}
                unit=""
              />
            </div>
          </div>
          <div>
            <div className="text-slate-400 text-xs mb-1">
              {isDownloading ? "Downloaded" : "Uploaded"}
            </div>
            <div className="font-mono font-medium text-lg">
              <AnimatedStat
                value={(
                  (transferStats.sentSize || transferStats.receivedSize || 0) /
                  1024 /
                  1024
                ).toFixed(2)}
                unit=" MB"
              />
            </div>
          </div>
          <div>
            <div className="text-slate-400 text-xs mb-1">Total Size</div>
            <div className="font-mono font-medium text-lg">
              <AnimatedStat
                value={(transferStats.totalSize / 1024 / 1024).toFixed(2)}
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
                margin={{ top: 5, right: 20, left: -10, bottom: 5 }}
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
                  label={{
                    value: "MB/s",
                    angle: -90,
                    position: "insideLeft",
                    style: { fontSize: 10, fill: "rgba(255,255,255,0.4)" },
                  }}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "rgba(15, 23, 42, 0.8)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: 8,
                    color: "#fff",
                  }}
                  formatter={(value) => [`${value} MB/s`, "Speed"]}
                />
                <Line
                  type="monotone"
                  dataKey="speed"
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
    </AnimatePresence>
  );
};

export default TransferStats;
