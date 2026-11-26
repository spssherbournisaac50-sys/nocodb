import fs from 'node:fs/promises';
import path from 'node:path';

const ID_RE = /^[A-Za-z0-9_-]{22}$/;

// Stores encrypted chunks on local disk: <dir>/<transferId>/<index>.
// The server only ever sees ciphertext.
export class ChunkStore {
  constructor(dir) {
    this.dir = dir;
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
  }

  #folder(id) {
    if (!ID_RE.test(id)) throw new Error('Invalid transfer id');
    return path.join(this.dir, id);
  }

  #file(id, index) {
    return path.join(this.#folder(id), String(index));
  }

  async write(id, index, data) {
    const folder = this.#folder(id);
    await fs.mkdir(folder, { recursive: true });
    const target = this.#file(id, index);
    const existed = await this.has(id, index);
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, data);
    await fs.rename(temp, target);
    return !existed;
  }

  async read(id, index) {
    try {
      return await fs.readFile(this.#file(id, index));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async has(id, index) {
    try {
      await fs.access(this.#file(id, index));
      return true;
    } catch {
      return false;
    }
  }

  async remove(id) {
    await fs.rm(this.#folder(id), { recursive: true, force: true });
  }

  async listIds() {
    try {
      const entries = await fs.readdir(this.dir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory() && ID_RE.test(e.name)).map((e) => e.name);
    } catch {
      return [];
    }
  }
}
