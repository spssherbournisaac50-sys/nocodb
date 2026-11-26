// Splits a set of files into encrypted chunks. Chunks never span two files, so a
// global chunk index maps to exactly one (file, byte range) pair.

// Upload mode: 1 MiB chunks keep HTTP overhead low while allowing streaming.
export const UPLOAD_CHUNK_SIZE = 1024 * 1024;
// Live mode: frames must fit in a WebRTC data channel message on every browser
// (64 KiB is the safe cross-browser maximum). 4 bytes header + 16 bytes GCM tag.
export const DIRECT_CHUNK_SIZE = 60 * 1024;

export const MAX_FILES = 1000;

export function planChunks(files, chunkSize) {
  let next = 0;
  let totalSize = 0;
  const entries = files.map((file) => {
    const count = Math.ceil(file.size / chunkSize);
    const entry = {
      name: String(file.name || 'file'),
      size: file.size,
      type: file.type || '',
      lastModified: file.lastModified || Date.now(),
      firstChunk: next,
      chunkCount: count,
    };
    next += count;
    totalSize += file.size;
    return entry;
  });
  return { chunkSize, chunkCount: next, totalSize, files: entries };
}

// Returns { fileIndex, start, end } for a global chunk index.
export function locateChunk(manifest, index) {
  const { files, chunkSize } = manifest;
  let lo = 0;
  let hi = files.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const f = files[mid];
    if (index < f.firstChunk) hi = mid - 1;
    else if (index >= f.firstChunk + f.chunkCount) lo = mid + 1;
    else {
      const local = index - f.firstChunk;
      const start = local * chunkSize;
      return { fileIndex: mid, start, end: Math.min(start + chunkSize, f.size) };
    }
  }
  throw new RangeError(`Chunk ${index} is out of range`);
}
