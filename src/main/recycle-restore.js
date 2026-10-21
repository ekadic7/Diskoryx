const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { getFileActionHelperPath } = require('./windows-rename');
const { inspectFileAction } = require('./file-action-guard');

function parseRecycleMetadata(data) {
  if (!Buffer.isBuffer(data) || data.length < 26) throw new Error('Truncated Recycle Bin metadata.');
  const version = data.readBigUInt64LE(0);
  let text;
  if (version === 1n) {
    if (data.length !== 544) throw new Error('Invalid version 1 Recycle Bin metadata.');
    const end = data.subarray(24).toString('utf16le').indexOf('\0');
    if (end < 0) throw new Error('Unterminated Recycle Bin path.');
    text = data.subarray(24).toString('utf16le').slice(0, end);
  } else if (version === 2n) {
    if (data.length < 30) throw new Error('Truncated version 2 Recycle Bin metadata.');
    const length = data.readUInt32LE(24);
    if (length < 2 || length > 32768 || data.length !== 28 + length * 2 ||
      data.readUInt16LE(data.length - 2) !== 0) throw new Error('Invalid Recycle Bin path length.');
    text = data.subarray(28, data.length - 2).toString('utf16le');
  } else throw new Error('Unsupported Recycle Bin metadata version.');
  if (!/^[A-Za-z]:\\/.test(text) || text.includes('\0')) throw new Error('Invalid original Recycle Bin path.');
  return { originalPath: path.win32.normalize(text), bytes: data.readBigUInt64LE(8).toString() };
}

let ownSid;
function getOwnBinPath(volume) {
  if (!ownSid) {
    ownSid = execFileSync(getFileActionHelperPath(), ['--user-sid'], {
      windowsHide: true, encoding: 'utf8', timeout: 10000
    }).trim();
    if (!/^S-1-\d+(?:-\d+)+$/.test(ownSid)) {
      ownSid = null;
      throw new Error('The current user Recycle Bin identity could not be verified.');
    }
  }
  return path.join(volume, '$Recycle.Bin', ownSid);
}

async function readMetadata(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65564) throw new Error('Unsupported Recycle Bin metadata file.');
  return parseRecycleMetadata(await fs.readFile(file));
}

async function findRecycledEntry(entry, binPath = getOwnBinPath(path.parse(entry.source).root)) {
  const volume = path.parse(entry.source).root;
  await inspectFileAction(volume, binPath);
  const directory = await fs.opendir(binPath);
  let candidate;
  let count = 0;
  for await (const item of directory) {
    if (++count > 100000) throw new Error('Recycle Bin lookup exceeded its bounded limit. Restore the item using Windows.');
    if (!item.name.startsWith('$I') || !item.isFile()) continue;
    const metadata = path.join(binPath, item.name);
    let info;
    try { info = await readMetadata(metadata); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      console.warn('Skipping unreadable Recycle Bin metadata:', metadata, error.message);
      continue;
    }
    if (info.originalPath.toLowerCase() !== entry.source.toLowerCase()) continue;
    const target = path.join(binPath, '$R' + item.name.slice(2));
    const original = entry.chain.at(-1);
    let chain;
    try { chain = await inspectFileAction(volume, target); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const leaf = chain.at(-1);
    if (leaf.identity !== original.identity || leaf.isDirectory !== original.isDirectory) continue;
    if (candidate) throw new Error('More than one matching bin item exists. Restore manually; no guess was made.');
    candidate = {
      target, entries: chain, metadata, metadataEntries: await inspectFileAction(volume, metadata),
      destination: entry.source, info
    };
  }
  if (!candidate) throw new Error('The exact app-deleted item is no longer in your Recycle Bin. It may already be restored or permanently removed.');
  return candidate;
}

module.exports = { parseRecycleMetadata, readMetadata, findRecycledEntry, getOwnBinPath };
