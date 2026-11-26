// Minimal store-only ZIP writer (no compression; media files rarely compress).
// Builds an array of Blob parts so huge files are never copied into memory.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes, previous = 0) {
  let c = (previous ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export async function crc32Blob(blob, sliceSize = 8 * 1024 * 1024) {
  let crc = 0;
  for (let offset = 0; offset < blob.size; offset += sliceSize) {
    const part = new Uint8Array(await blob.slice(offset, offset + sliceSize).arrayBuffer());
    crc = crc32(part, crc);
  }
  return crc;
}

const ZIP_LIMIT = 0xffffffff;

export function canZip(entries) {
  const total = entries.reduce((sum, e) => sum + e.size + 128 + e.name.length * 2, 0);
  return entries.length > 0 && entries.length < 0xffff && total < ZIP_LIMIT;
}

export function safeName(name) {
  const cleaned = String(name)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return cleaned || 'file';
}

function uniqueNames(names) {
  const seen = new Set();
  return names.map((original) => {
    let name = safeName(original);
    if (seen.has(name.toLowerCase())) {
      const dot = name.lastIndexOf('.');
      const base = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let n = 1;
      while (seen.has(`${base} (${n})${ext}`.toLowerCase())) n++;
      name = `${base} (${n})${ext}`;
    }
    seen.add(name.toLowerCase());
    return name;
  });
}

function dosDateTime(ms) {
  const d = new Date(ms || Date.now());
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// entries: [{ name, size, crc, lastModified, blob }]
export function buildZip(entries) {
  const encoder = new TextEncoder();
  const names = uniqueNames(entries.map((e) => e.name)).map((n) => encoder.encode(n));
  const parts = [];
  const central = [];
  let offset = 0;

  entries.forEach((entry, i) => {
    const name = names[i];
    const { time, date } = dosDateTime(entry.lastModified);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, entry.crc, true);
    local.setUint32(18, entry.size, true);
    local.setUint32(22, entry.size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, entry.blob);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, entry.crc, true);
    cd.setUint32(20, entry.size, true);
    cd.setUint32(24, entry.size, true);
    cd.setUint16(28, name.length, true);
    cd.setUint16(30, 0, true);
    cd.setUint16(32, 0, true);
    cd.setUint16(34, 0, true);
    cd.setUint16(36, 0, true);
    cd.setUint32(38, 0, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);

    offset += 30 + name.length + entry.size;
  });

  const cdSize = central.reduce((sum, p) => sum + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);

  return [...parts, ...central, new Uint8Array(end.buffer)];
}
