// src/components/shared/AnimatedStat.jsx
import React from "react";
import { motion } from "framer-motion";

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

export default AnimatedStat;
