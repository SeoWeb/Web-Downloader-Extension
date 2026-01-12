
import JSZip from "jszip";

/**
 * SplitZipGenerator
 * 
 * Generates a standard multi-part (spanned) ZIP archive from a JSZip stream.
 * 
 * Key Features:
 * - Prepends the required Spanned Archive Signature (0x08074b50) to the first part (.z01).
 * - Buffers the Central Directory (CD) to ensuring it resides entirely in the last part (.zip).
 * - Patches CD records to reflect the correct Disk Number and Relative Offset for each file.
 * - Patches the End of Central Directory (EOCD) to report the correct Total Disks.
 */
export class SplitZipGenerator {
  private partSize: number;
  private currentBuffer: Uint8Array[] = [];
  private currentBufferSize: number = 0;
  private partNumber: number = 1;
  private totalParts: number = 0; // Track total parts
  private partCallback: (blob: Blob, partNumber: number, isLast: boolean, totalParts: number) => Promise<void>;
  
  // Stream state
  private streamHelper: any;
  private isFlushing: boolean = false;
  private totalBytesOutput: number = 0; // Tracks bytes written across all parts (excluding current buffer)

  // Central Directory Buffering
  private cdBuffer: Uint8Array[] = [];
  private cdBufferSize: number = 0;
  private isCollectingCD: boolean = false;
  private lastChunkTail: Uint8Array = new Uint8Array(0); // For detecting signatures across chunk boundaries
  
  // File Position Tracking
  // The type includes needsSignatureAdjustment to track whether the 4-byte spanned signature
  // was already counted in totalBytesOutput when this file's position was captured.
  private filePositions: Map<number, { diskNumber: number; offsetInDisk: number; needsSignatureAdjustment: boolean }> = new Map();
  private fileIndex: number = 0;
  private lastLocalHeaderTail: Uint8Array = new Uint8Array(0); // For detecting local file headers across chunk boundaries
  
  // Multi-part flag: set to true when we flush an intermediate part (not the last)
  // This indicates we need the spanned signature offset adjustment
  private isMultiPart: boolean = false;
  
  // Magic Signatures
  private readonly SIG_LOCAL_FILE = 0x04034b50;  // Local File Header
  private readonly SIG_CD_HEADER = 0x02014b50; // Central Directory File Header
  private readonly SIG_EOCD = 0x06054b50;      // End of Central Directory
  private readonly SIG_SPANNED = 0x08074b50;   // Spanned Archive Signature

  constructor(public zip: JSZip, partSize: number = 25 * 1024 * 1024) { // Default 25MB (reduced to prevent memory crashes)
    this.partSize = partSize;
    this.partCallback = async () => {};
  }

  onPartReady(callback: (blob: Blob, partNumber: number, isLast: boolean, totalParts: number) => Promise<void>) {
    this.partCallback = callback;
  }

  async start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const stream = (this.zip as any).generateInternalStream({
        type: "uint8array",
        streamFiles: true,
        compression: "DEFLATE",
        compressionOptions: { level: 5 }
      });
      this.streamHelper = stream;

      stream.on("data", (data: Uint8Array) => {
        this.accumulate(data);
      });

      stream.on("error", (err: Error) => {
        reject(err);
      });

      stream.on("end", async () => {
        try {
          // Final flush of any remaining file data + Buffered CD
          await this.finish();
          resolve();
        } catch (e) {
          reject(e);
        }
      });

      stream.resume();
    });
  }

  /**
   * Accumulate data from the stream.
   * Detecting the start of the Central Directory to switch to buffering mode.
   */
  private accumulate(data: Uint8Array) {
    if (this.isCollectingCD) {
      this.cdBuffer.push(data);
      this.cdBufferSize += data.length;
      return;
    }

    // Track local file headers BEFORE adding to buffer
    this.trackLocalFileHeaders(data);

    // Check for Central Directory Signature (0x50, 0x4b, 0x01, 0x02)
    // Combine last 3 bytes of previous chunk with current chunk to detect signatures across boundaries
    const searchData = this.lastChunkTail.length > 0 
      ? this.concatBuffers([this.lastChunkTail, data])
      : data;
    
    const cdIndex = this.findSignature(searchData, this.SIG_CD_HEADER);
    
    if (cdIndex !== -1) {
       // Adjust index based on tail offset
       const actualIndex = cdIndex - this.lastChunkTail.length;
       
       if (actualIndex < 0) {
         // Signature started in previous chunk
         console.warn('CD signature spans chunks - this should be rare with JSZip');
         // The signature is in the tail, we need to handle this carefully
         // For now, we'll treat everything as CD since we detected it
         this.isCollectingCD = true;
         this.cdBuffer.push(data);
         this.cdBufferSize += data.length;
       } else {
         // Split data into before-CD and CD
         const beforeCD = data.slice(0, actualIndex);
         const cdData = data.slice(actualIndex);
         
         if (beforeCD.length > 0) {
           this.addToCurrentBuffer(beforeCD);
         }
         
         this.isCollectingCD = true;
         this.cdBuffer.push(cdData);
         this.cdBufferSize += cdData.length;
       }
    } else {
       // Just normal file data
       this.addToCurrentBuffer(data);
    }

    // Save last 3 bytes for next iteration (signature is 4 bytes, so 3 bytes overlap is enough)
    if (data.length >= 3) {
      this.lastChunkTail = data.slice(-3);
    }

    // if buffer is full and we are NOT collecting CD, flush
    if (!this.isCollectingCD && this.currentBufferSize >= this.partSize) {
      this.handleFlush();
    }
  }

  private addToCurrentBuffer(data: Uint8Array) {
      this.currentBuffer.push(data);
      this.currentBufferSize += data.length;
  }

  /**
   * Track local file header positions as they flow through the stream.
   * This allows us to know exactly where each file ends up in the split archive.
   */
  private trackLocalFileHeaders(data: Uint8Array) {
    // Combine last 3 bytes of previous chunk with current chunk to detect signatures across boundaries
    const searchData = this.lastLocalHeaderTail.length > 0
      ? this.concatBuffers([this.lastLocalHeaderTail, data])
      : data;
    const tailOffset = this.lastLocalHeaderTail.length;
    
    let searchOffset = 0;
    
    while (searchOffset <= searchData.length - 4) {
      const sig = new DataView(searchData.buffer, searchData.byteOffset + searchOffset, 4).getUint32(0, true);
      
      if (sig === this.SIG_LOCAL_FILE) {
        // Found a local file header!
        // Adjust for tail offset to get position in original data
        const actualSearchOffset = searchOffset - tailOffset;
        
        // Only track if the signature starts in the current data (not in tail)
        if (actualSearchOffset >= 0) {
          // Calculate its position in the split archive
          // Store RAW positions without the spanned signature offset adjustment.
          const positionInCurrentBuffer = actualSearchOffset;
          const absolutePosition = this.totalBytesOutput + this.currentBufferSize + positionInCurrentBuffer;
        
        // Track whether this position was captured BEFORE the first flush.
        // If totalBytesOutput is 0, the 4-byte signature hasn't been counted yet,
        // so we'll need to add +4 later for multi-part archives.
        // If totalBytesOutput > 0, it already includes the +4 from the signature.
        const needsSignatureAdjustment = (this.totalBytesOutput === 0);
        
        this.filePositions.set(this.fileIndex, { 
          diskNumber: 0,  // Will be recalculated in patchCentralDirectory
          offsetInDisk: absolutePosition,  // Store raw absolute position for now
          needsSignatureAdjustment: needsSignatureAdjustment
        });
        this.fileIndex++;
        }
        
        // Skip past this header to avoid re-detecting (minimum local file header size is 30 bytes)
        searchOffset += 30;
      } else {
        searchOffset++;
      }
    }
    
    // Save last 3 bytes for next iteration (signature is 4 bytes)
    if (data.length >= 3) {
      this.lastLocalHeaderTail = data.slice(-3);
    }
  }

  /**
   * Helper to find a 4-byte signature in a Uint8Array
   */
  private findSignature(data: Uint8Array, signature: number): number {
    if (data.length < 4) return -1;
    
    // Naive search
    // Signature is usually little-endian in docs (0x02014b50) but on wire it is 50 4b 01 02
    const b0 = signature & 0xFF;         // 0x50 (P)
    const b1 = (signature >> 8) & 0xFF;  // 0x4b (K)
    const b2 = (signature >> 16) & 0xFF; // 0x01
    const b3 = (signature >> 24) & 0xFF; // 0x02

    for (let i = 0; i <= data.length - 4; i++) {
        if (data[i] === b0 && data[i+1] === b1 && data[i+2] === b2 && data[i+3] === b3) {
            return i;
        }
    }
    return -1;
  }

  private async handleFlush() {
      if (this.isFlushing) return;
      this.isFlushing = true;
      if (this.streamHelper) this.streamHelper.pause();

      try {
          await this.flushPart(false);
      } finally {
          this.isFlushing = false;
          if (this.streamHelper) this.streamHelper.resume();
      }
  }

  /**
   * Flushes the current buffer as a zip part.
    * Use simple numbering: Part 1 (.z01) ... Part N (.zip)
   */
  private async flushPart(isLast: boolean) {
    if (this.currentBufferSize === 0 && !isLast) return;

    const blobs: any[] = [];

    // Prepend Spanned Zip Signature ONLY if this is a multi-part archive
    // The spanned signature (0x08074b50) is ONLY valid for split archives (.z01, .z02, ... .zip)
    // For single-file ZIPs, adding this signature corrupts the archive!
    // We know it's a multi-part archive if: partNumber === 1 AND isLast === false
    // (meaning we're flushing the first part but there's more data to come)
    if (this.partNumber === 1 && !isLast) {
        const sig = new Uint8Array([
            this.SIG_SPANNED & 0xFF,
            (this.SIG_SPANNED >> 8) & 0xFF,
            (this.SIG_SPANNED >> 16) & 0xFF,
            (this.SIG_SPANNED >> 24) & 0xFF
        ]);
        blobs.push(sig);
        this.totalBytesOutput += 4; // Shift offsets by 4
        this.isMultiPart = true; // Mark as multi-part archive
    }

    // Determine how many bytes to flush
    let bytesToFlush: number;
    let remainderBuffers: Uint8Array[] = [];
    let remainderSize = 0;
    
    if (isLast) {
        // Flush everything for the last part
        bytesToFlush = this.currentBufferSize;
        blobs.push(...(this.currentBuffer as any[]));
    } else {
        // Flush exactly partSize bytes, keep the rest
        bytesToFlush = this.partSize;
        
        // Concatenate all buffers to extract exactly partSize bytes
        const fullBuffer = this.concatBuffers(this.currentBuffer);
        
        if (fullBuffer.length > this.partSize) {
            // Split: take partSize for this part, keep remainder
            const toFlush = fullBuffer.slice(0, this.partSize);
            const remainder = fullBuffer.slice(this.partSize);
            
            blobs.push(toFlush);
            remainderBuffers = [remainder];
            remainderSize = remainder.length;
        } else {
            // Shouldn't happen if we're here, but handle it
            blobs.push(fullBuffer);
            bytesToFlush = fullBuffer.length;
        }
    }

    // Create Blob
    const blob = new Blob(blobs, { type: "application/octet-stream" });

    // Update total bytes output
    this.totalBytesOutput += bytesToFlush;

    // Update buffer with remainder (if any)
    this.currentBuffer = remainderBuffers;
    this.currentBufferSize = remainderSize;

    // Send part
    await this.partCallback(blob, this.partNumber, isLast, this.totalParts);

    if (!isLast) {
      this.partNumber++;
    } else {
      // Set total parts when we reach the last part
      this.totalParts = this.partNumber;
    }
  }

  /**
   * Called when stream ends. We patch the CD and flush it as the final part.
   */
  private async finish() {
      
      // CRITICAL: Calculate CD offset BEFORE adding CD to buffer
      const cdOffsetInDisk = this.currentBufferSize;
      
      // 1. Process CD Buffer
      // We need to concat it all to parse freely
      const fullCD = this.concatBuffers(this.cdBuffer);
      
      // 2. Patch CD Records
      // Pass the CD offset as a parameter since we calculated it before modification
      const patchedCD = this.patchCentralDirectory(fullCD, cdOffsetInDisk);
      
      // 3. Add to current buffer (which will be flushed as the final .zip part)
      this.addToCurrentBuffer(patchedCD);
      
      // 4. Flush final part
      await this.flushPart(true);
  }

  private concatBuffers(buffers: Uint8Array[]): Uint8Array {
      const totalLen = buffers.reduce((acc, b) => acc + b.length, 0);
      const result = new Uint8Array(totalLen);
      let offset = 0;
      for (const b of buffers) {
          result.set(b, offset);
          offset += b.length;
      }
      return result;
  }

  /**
   * Parses and patches the Central Directory and EOCD.
   * 
   * For multi-volume ZIP archives:
   * - Each file's "Disk Number Start" indicates which volume (0-based) contains its local header
   * - "Relative Offset" should point to the offset within that specific disk, NOT absolute
   * - EOCD records which disk it's on and where the CD starts
   * 
   * @param cdData The Central Directory data to patch
   * @param cdOffsetInDisk The offset where the CD starts in the final disk
   */
  private patchCentralDirectory(cdData: Uint8Array, cdOffsetInDisk: number): Uint8Array {
      const view = new DataView(cdData.buffer, cdData.byteOffset, cdData.byteLength);
      let offset = 0;
      let fileIndex = 0; // Track which file we're patching
      
      // Iterate through records until we find EOCD
      while (offset < cdData.length) {
          const signature = view.getUint32(offset, true);
          
          if (signature === this.SIG_CD_HEADER) {
              // --- Central Directory File Header ---
              // Structure: https://en.wikipedia.org/wiki/ZIP_(file_format)#Central_directory_file_header
              // Offset 28 (2 bytes): File name length (n)
              // Offset 30 (2 bytes): Extra field length (m)
              // Offset 32 (2 bytes): File comment length (k)
              // Offset 34 (2 bytes): Disk number where file starts (0-based)
              // Offset 42 (4 bytes): Relative offset of local file header
              
              // Look up the tracked position for this file
              const position = this.filePositions.get(fileIndex);
              
              if (position) {
                  // Calculate actual disk number and offset based on archive type
                  let diskNumber: number;
                  let offsetInDisk: number;
                  
                  // position.offsetInDisk contains the RAW absolute position
                  const rawPosition = position.offsetInDisk;
                  
                  if (this.isMultiPart) {
                      // Multi-part archive: account for 4-byte spanned signature
                      // The signature is ONLY in the first part (.z01), which is partSize + 4 bytes total
                      
                      // Only add +4 if this file was tracked BEFORE the first flush.
                      // Files tracked after the first flush already have the +4 included
                      // in totalBytesOutput, so their rawPosition already accounts for it.
                      const adjustedPosition = position.needsSignatureAdjustment 
                          ? rawPosition + 4 
                          : rawPosition;
                      
                      if (adjustedPosition < this.partSize + 4) {
                          // File is on disk 0 (the .z01 file, which has the 4-byte signature)
                          diskNumber = 0;
                          offsetInDisk = adjustedPosition;
                      } else {
                          // File is on disk 1 or later
                          const bytesAfterDisk0 = adjustedPosition - (this.partSize + 4);
                          diskNumber = 1 + Math.floor(bytesAfterDisk0 / this.partSize);
                          offsetInDisk = bytesAfterDisk0 % this.partSize;
                      }
                  } else {
                      // Single-part archive: no signature, all files on disk 0
                      diskNumber = 0;
                      offsetInDisk = rawPosition;
                  }
                  
                  view.setUint16(offset + 34, diskNumber, true);
                  view.setUint32(offset + 42, offsetInDisk, true);
                  
              } else {
                  console.error(`No tracked position for file ${fileIndex}! This should not happen.`);
                  // Fallback: leave the original values (will likely cause errors)
              }
              
              fileIndex++;

              // Advance to next record
              const nameLen = view.getUint16(offset + 28, true);
              const extraLen = view.getUint16(offset + 30, true);
              const commentLen = view.getUint16(offset + 32, true);
              
              offset += 46 + nameLen + extraLen + commentLen;
              
          } else if (signature === this.SIG_EOCD) {
              // --- End of Central Directory Record ---
              // Structure: https://en.wikipedia.org/wiki/ZIP_(file_format)#End_of_central_directory_record_(EOCD)
              // Offset 4 (2 bytes): Number of this disk (0-based)
              // Offset 6 (2 bytes): Disk where central directory starts (0-based)
              // Offset 8 (2 bytes): Number of central directory records on this disk
              // Offset 10 (2 bytes): Total number of central directory records
              // Offset 12 (4 bytes): Size of central directory
              // Offset 16 (4 bytes): Offset of start of central directory, relative to start of archive
              
              let currentDisk: number;
              
              if (this.isMultiPart) {
                  // Calculate which disk we're currently on based on total bytes output
                  // Account for the 4-byte signature in the first part
                  currentDisk = Math.floor((this.totalBytesOutput + 4) / this.partSize);
              } else {
                  // Single-part archive: always disk 0
                  currentDisk = 0;
              }
              
              // All CD records are on this disk (we buffered them all)
              const totalRecords = view.getUint16(offset + 10, true);
              
              // Use the passed cdOffsetInDisk parameter (calculated before CD was added to buffer)
              view.setUint16(offset + 4, currentDisk, true);        // Number of this disk
              view.setUint16(offset + 6, currentDisk, true);        // Disk where CD starts
              view.setUint16(offset + 8, totalRecords, true);       // Records on this disk
              view.setUint32(offset + 16, cdOffsetInDisk, true);    // Offset of CD start
              
              break; // Done
          } else {
              // Unknown signature - this shouldn't happen in a well-formed ZIP
              // Try to find the next signature
              console.warn(`Unknown signature 0x${signature.toString(16)} at offset ${offset}`);
              offset++;
          }
      }
      
      return cdData;
  }
}
