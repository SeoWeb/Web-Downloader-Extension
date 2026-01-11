import JSZip from "jszip";
import { FilePartition } from "./file-partitioner";

/**
 * Generate a README file content for the specific part.
 */
function createReadmeContent(partNumber: number, totalParts: number): string {
  return `MULTI-PART DOWNLOAD
===================
This website has been split into ${totalParts} parts for download.

EXTRACTION INSTRUCTIONS:
1. Download all ${totalParts} parts (files ending in .zip)
2. Create a new folder for the website
3. Extract each ZIP file into the SAME folder
4. All files will merge into the correct directory structure
5. Open index.html to view the website

This is Part ${partNumber} of ${totalParts}
`;
}

/**
 * Generate a ZIP blob for a specific partition.
 */
export async function generatePartZip(
  partition: FilePartition,
  totalParts: number,
  compressionLevel: number = 6
): Promise<Blob> {
  const zip = new JSZip();

  // Add files from the partition
  for (const item of partition.files) {
    // We need to read the content from the original JSZip object
    // item.file is a JSZipObject. We can get its content using async methods.
    // However, JSZip instances are separate. We can't easily "move" a JSZipObject 
    // to a new JSZip instance without reading it.
    
    // Efficiently copy content:
    // If it's a stream or blob, we want to pass it through.
    // async('blob') or async('uint8array') is standard.
    const content = await item.file.async('blob');
    zip.file(item.path, content);
  }

  // Add README
  zip.file("README.txt", createReadmeContent(partition.partNumber, totalParts));
  
  // Add part marker
  zip.file(`PART_${partition.partNumber}_OF_${totalParts}.txt`, `This is part ${partition.partNumber} of ${totalParts}`);

  // Generate the blob
  return zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: compressionLevel },
  });
}
