import { log } from "../utils/logger";

/**
 * Takes an array of files (from a folder input), zips them, and then
 * initiates a file transfer.
 * @param {FileList} files - The list of files to zip.
 * @param {function} sendFile - The function to call to send the final zipped file.
 * @param {function} setMessages - React state setter to update the UI with progress.
 * @returns {Promise<File>} The generated zip file.
 */
export async function processAndZipFolder(files, sendFile, setMessages) {
  if (!files || files.length === 0) {
    log("No files selected for zipping.");
    return;
  }

  try {
    const filesArray = Array.from(files);
    log(`Starting to zip ${filesArray.length} files.`);
    setMessages((p) => [
      ...p,
      { type: "system", text: `Zipping ${filesArray.length} files...` },
    ]);

    // Dynamically import JSZip to keep the initial bundle small.
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();

    // Try to determine a sensible name for the zip file.
    let folderName = "folder";
    if (filesArray[0]?.webkitRelativePath) {
      folderName = filesArray[0].webkitRelativePath.split("/")[0] || folderName;
    }

    // Add each file to the zip archive.
    for (let i = 0; i < filesArray.length; i++) {
      const file = filesArray[i];
      const path = file.webkitRelativePath || file.name;
      const arrayBuffer = await file.arrayBuffer();
      zip.file(path, arrayBuffer);

      // Update the UI every 10 files to avoid too many re-renders.
      if (i % 10 === 0 || i === filesArray.length - 1) {
        setMessages((p) => {
          const newMessages = [...p];
          if (newMessages[newMessages.length - 1]?.text.includes("Zipping")) {
            newMessages[newMessages.length - 1] = {
              type: "system",
              text: `Zipping ${i + 1}/${filesArray.length} files...`,
            };
          }
          return newMessages;
        });
        // Yield to the event loop to keep the UI responsive.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    setMessages((p) => [
      ...p.slice(0, -1),
      { type: "system", text: "Generating zip file..." },
    ]);

    // Generate the final zip file as a Blob.
    const zipBlob = await zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 6 }, // A good balance of speed and compression.
    });

    const zipFile = new File([zipBlob], `${folderName}.zip`, {
      type: "application/zip",
    });

    log(`Zip created: ${zipFile.name}, size: ${zipFile.size} bytes`);
    setMessages((p) => [
      ...p.slice(0, -1),
      {
        type: "system",
        text: `Zip created: ${(zipFile.size / 1024 / 1024).toFixed(2)} MB`,
      },
    ]);

    // Finally, send the created zip file.
    await sendFile(zipFile);
  } catch (error) {
    log("Folder zip error", error.message);
    throw new Error("Failed to zip folder: " + error.message);
  }
}
