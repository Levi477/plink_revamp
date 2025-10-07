// src/services/indexedDB.js

const DB_NAME = "plink-file-transfer-db";
const DB_VERSION = 1;

/**
 * Opens a connection to the IndexedDB database.
 * Handles the initial setup and creation of object stores if they don't exist.
 */
function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      // This event fires if the DB version changes or doesn't exist.
      const db = request.result;
      if (!db.objectStoreNames.contains("chunks")) {
        // Store for individual file chunks. Keyed by fileId and chunk index.
        db.createObjectStore("chunks", { keyPath: ["fileId", "index"] });
      }
      if (!db.objectStoreNames.contains("files")) {
        // Store for file metadata.
        db.createObjectStore("files", { keyPath: "fileId" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Stores a single file chunk in the 'chunks' object store.
 * @param {string} fileId - The unique ID of the file.
 * @param {number} index - The index of this chunk.
 * @param {ArrayBuffer} data - The binary data of the chunk.
 */
export async function storeChunkIndexedDB(fileId, index, data) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["chunks"], "readwrite");
    tx.objectStore("chunks").put({ fileId, index, data });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Saves the metadata for a file being received.
 * @param {object} fileMeta - The file metadata object.
 */
export async function saveFileMetadataIndexedDB(fileMeta) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["files"], "readwrite");
    tx.objectStore("files").put(fileMeta);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Retrieves all stored chunks for a given fileId to reconstruct the file.
 * @param {string} fileId - The unique ID of the file.
 * @param {number} totalChunks - The expected number of chunks.
 */
export async function readAllChunksIndexedDB(fileId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["chunks"], "readonly");
    const store = tx.objectStore("chunks");
    const chunks = [];

    const request = store.openCursor();
    request.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        if (cursor.value.fileId === fileId) {
          // Store chunks in order.
          chunks[cursor.value.index] = cursor.value.data;
        }
        cursor.continue();
      }
    };

    tx.oncomplete = () => {
      // Filter out any potential empty spots if a chunk was missed.
      resolve(chunks.filter((c) => c));
    };
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Cleans up all data associated with a file transfer from IndexedDB.
 * @param {string} fileId - The unique ID of the file to delete.
 */
export async function deleteFileIndexedDB(fileId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["chunks", "files"], "readwrite");
    // Delete all associated chunks.
    const chunkStore = tx.objectStore("chunks");
    const request = chunkStore.openCursor();
    request.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        if (cursor.value.fileId === fileId) {
          cursor.delete();
        }
        cursor.continue();
      }
    };
    // Delete the file metadata entry.
    tx.objectStore("files").delete(fileId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
