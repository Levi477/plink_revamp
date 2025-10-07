// src/utils/logger.js

/**
 * A handy logger with timestamps. Helps keep track of events in the console.
 * @param {string} message - The message to log.
 * @param {any} [data=null] - Optional data to log alongside the message.
 */
export const log = (message, data = null) => {
  const timestamp = new Date().toISOString().split("T")[1].slice(0, -1);
  console.log(`[${timestamp}] ${message}`, data || "");
};
