const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

async function inspectCopyTree(target, signal, hashContents = true) {
  const pending = [target];
  const result = [];
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  while (pending.length) {
    signal?.throwIfAborted();
    if (result.length >= 4096) throw new Error('Copied folder exceeds the 4096-entry verification limit.');
    const current = pending.pop();
    const stat = await fs.lstat(current, { bigint: true });
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      throw new Error('A copied item is now a link or unsupported type.');
    }
    const entry = {
      relative: path.relative(target, current), identity: `${stat.dev}:${stat.ino}`,
      birth: stat.birthtimeNs.toString(), directory: stat.isDirectory(), size: stat.size.toString()
    };
    if (stat.isDirectory()) {
      const children = await fs.readdir(current);
      children.sort();
      for (const name of children.reverse()) pending.push(path.join(current, name));
    } else if (hashContents) {
      const handle = await fs.open(current, 'r');
      try {
        const before = await handle.stat({ bigint: true });
        if (before.dev !== stat.dev || before.ino !== stat.ino) throw new Error('A copied item was replaced.');
        const hash = createHash('sha256');
        let read;
        while ((read = (await handle.read(buffer)).bytesRead)) {
          signal?.throwIfAborted();
          hash.update(buffer.subarray(0, read));
        }
        const after = await handle.stat({ bigint: true });
        if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
          throw new Error('A copied item changed while verifying it.');
        }
        entry.hash = hash.digest('hex');
        entry.modified = after.mtimeNs.toString();
      } finally { await handle.close(); }
    }
    result.push(entry);
  }
  return result;
}

async function verifyCopyTree(target, receipt, signal) {
  const current = await inspectCopyTree(target, signal);
  if (JSON.stringify(current) !== JSON.stringify(receipt)) {
    throw new Error('The copied item has changed, gained/lost children or been replaced. Undo is refused to protect your changes.');
  }
}

module.exports = { inspectCopyTree, verifyCopyTree };
