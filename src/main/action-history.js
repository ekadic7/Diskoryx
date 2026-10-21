const { randomUUID } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');
const MAX_HISTORY_BYTES = 16 * 1024 * 1024;
const validChain = chain => Array.isArray(chain) && chain.length <= 1024 &&
  chain.every(node => node && typeof node.path === 'string' && typeof node.identity === 'string' &&
    typeof node.inode === 'string' && /^\d+$/.test(node.inode) &&
    typeof node.volume === 'string' && /^\d+$/.test(node.volume) && typeof node.isDirectory === 'boolean');

class ActionHistory {
  constructor(filePath = null) {
    this.entries = [];
    this.filePath = filePath;
    this.readiness = null;
  }

  async load() {
    if (!this.readiness) this.readiness = this.read();
    await this.readiness;
  }

  async read() {
    if (!this.filePath) return;
    let contents;
    try {
      const info = await fs.stat(this.filePath);
      if (info.size > MAX_HISTORY_BYTES) throw new Error('Action history exceeds the 16 MiB limit. Preserve it before repairing it.');
      contents = await fs.readFile(this.filePath, 'utf8');
    }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const data = JSON.parse(contents);
    if (data.version !== 1 || !Array.isArray(data.entries) || data.entries.length > 500) {
      throw new Error('Unsupported or damaged action history. Preserve the history file before repairing it.');
    }
    const ids = new Set();
    for (const item of data.entries) {
      if (!item || typeof item.id !== 'string' || ids.has(item.id) ||
        typeof item.time !== 'string' || !Number.isFinite(Date.parse(item.time)) ||
        !['rename', 'recycle', 'copy', 'move'].includes(item.kind) || !['done', 'undone', 'restored'].includes(item.state) ||
        typeof item.root !== 'string' || typeof item.source !== 'string' ||
        (item.kind !== 'recycle' ? typeof item.destination !== 'string' : item.destination !== null) ||
        (['copy', 'move'].includes(item.kind) && (!Array.isArray(item.receipt) || item.receipt.length > 4096 ||
          !Array.isArray(item.destinationChain))) ||
        (item.kind === 'move' && (!validChain(item.originalParents) || !validChain(item.destinationParents) ||
          !validChain(item.destinationChain) || !item.receipt.length)) ||
        !Array.isArray(item.chain) || !item.chain.length || item.chain.length > 1024 ||
        item.chain.some(node => !node || typeof node.path !== 'string' ||
          typeof node.identity !== 'string' || typeof node.inode !== 'string' || !/^\d+$/.test(node.inode) ||
          typeof node.volume !== 'string' || !/^\d+$/.test(node.volume) || typeof node.isDirectory !== 'boolean')) {
        throw new Error('Damaged action history. No file action has been performed.');
      }
      ids.add(item.id);
    }
    this.entries = data.entries;
  }

  async save() {
    if (!this.filePath) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      let contents = JSON.stringify({ version: 1, entries: this.entries });
      while (Buffer.byteLength(contents) > MAX_HISTORY_BYTES && this.entries.length > 1) {
        this.entries.pop();
        contents = JSON.stringify({ version: 1, entries: this.entries });
      }
      if (Buffer.byteLength(contents) > MAX_HISTORY_BYTES) throw new Error('This action history record exceeds the 16 MiB storage limit.');
      await fs.writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, this.filePath);
    } catch (error) {
      try { await fs.unlink(temporary); } catch (cleanup) {
        if (cleanup.code !== 'ENOENT') error.message += ` History temp cleanup failed: ${cleanup.message}`;
      }
      throw error;
    }
  }

  record(root, source, destination, chain) {
    const entry = {
      id: randomUUID(), time: new Date().toISOString(), root, source, destination: destination || null,
      kind: destination ? 'rename' : 'recycle', state: 'done',
      chain: chain.map((node, index) => ({
        ...node, path: destination && index === chain.length - 1 ? destination : node.path
      }))
    };
    this.entries.unshift(entry);
    this.entries.length = Math.min(this.entries.length, 500);
    return entry;
  }

  recordCopy(root, source, destination, chain, destinationChain, receipt) {
    const entry = this.record(root, source, null, chain);
    Object.assign(entry, { kind: 'copy', destination, chain, destinationChain, receipt });
    return entry;
  }

  recordMove(root, source, destination, chain, destinationChain, receipt) {
    const entry = this.recordCopy(root, source, destination, chain, destinationChain, receipt);
    Object.assign(entry, {
      kind: 'move', destinationParents: destinationChain.slice(0, -1),
      originalParents: chain.slice(0, -1)
    });
    return entry;
  }

  list(root) {
    return this.entries.map(({ id, time, source, destination, kind, state, root: entryRoot }) => ({
      id, time, source, destination, kind, state,
      canRestore: kind === 'rename' && root === entryRoot,
      canUndoCopy: kind === 'copy' && state === 'done'
    }));
  }

  getCopy(id) {
    const entry = this.entries.find(item => item.id === id && item.kind === 'copy');
    if (!entry) throw new Error('This copy history entry is unavailable.');
    return entry;
  }

  getRecycle(id) {
    const entry = this.entries.find(item => item.id === id && item.kind === 'recycle' && item.state === 'done');
    if (!entry) throw new Error('This recycle entry is unavailable or was already restored.');
    return entry;
  }

  get(id, root) {
    const entry = this.entries.find(item => item.id === id);
    if (!entry || entry.kind !== 'rename') throw new Error('This history entry cannot restore a name.');
    if (entry.root !== root) throw new Error('Scan the original location before restoring this name.');
    return entry;
  }

  target(entry) {
    return entry.state === 'done'
      ? { source: entry.destination, name: path.basename(entry.source) }
      : { source: entry.source, name: path.basename(entry.destination) };
  }

  restored(entry, destination) {
    entry.chain = entry.chain.map((node, index) => ({
      ...node, path: index === entry.chain.length - 1 ? destination : node.path
    }));
    entry.state = entry.state === 'done' ? 'undone' : 'done';
  }
}

module.exports = { ActionHistory };
