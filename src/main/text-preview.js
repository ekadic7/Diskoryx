const fs = require('node:fs/promises');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const PAGE_BYTES = 64 * 1024;
const TEXT_EXTENSIONS = new Set([
  '.txt', '.log', '.json', '.jsonl', '.yaml', '.yml', '.ini', '.conf', '.config',
  '.cfg', '.toml', '.xml', '.csv', '.md', '.markdown', '.env', '.gitignore',
  '.properties', '.editorconfig', '.html', '.htm', '.xhtml', '.css', '.scss',
  '.sass', '.less', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue',
  '.svelte', '.sql', '.sh', '.bash', '.ps1', '.psm1', '.psd1', '.bat', '.cmd',
  '.py', '.rb', '.php', '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.rs',
  '.go', '.swift', '.kt', '.kts', '.lua'
]);
const TEXT_NAMES = new Set(['.env', '.gitignore', '.editorconfig', 'dockerfile', 'makefile', 'license', 'readme']);

function supportsTextPreview(filePath) {
  const name = path.basename(filePath).toLowerCase();
  return TEXT_EXTENSIONS.has(path.extname(name)) || TEXT_NAMES.has(name) ||
    name.startsWith('.env.') || /(?:^|\.)log(?:\d+|\.\d+)?$/.test(name);
}

function isWithinRoot(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function revisionOf(stats) {
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
}

function hasBinaryControls(text) {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text);
}

async function readTextPage(filePath, rootPath, page = 0, expectedRevision = null) {
  if (!Number.isSafeInteger(page) || page < 0) throw new Error('Enter a valid page number.');
  if (expectedRevision !== null && typeof expectedRevision !== 'string') throw new Error('Invalid preview revision.');
  if (!supportsTextPreview(filePath)) throw new Error('Preview supports text, log and configuration files only.');
  const target = path.resolve(filePath);
  const root = path.resolve(rootPath);
  if (!isWithinRoot(root, target)) throw new Error('This file is outside the scanned folder.');
  const entry = await fs.lstat(target);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Preview supports regular files only, not links or folders.');
  const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(target)]);
  if (!isWithinRoot(realRoot, realTarget)) throw new Error('This file resolves outside the scanned folder.');
  const handle = await fs.open(realTarget, 'r');
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.dev !== entry.dev || stats.ino !== entry.ino) {
      throw new Error('The file changed while opening it. Select it again.');
    }
    if (!Number.isSafeInteger(stats.size)) throw new Error('This file is too large for precise page navigation.');
    const revision = revisionOf(stats);
    if (expectedRevision !== null && revision !== expectedRevision) {
      throw new Error('The file changed since this preview opened. Reload it to read the current version.');
    }

    const sample = Buffer.alloc(Math.min(4096, stats.size));
    const { bytesRead: sampleRead } = await handle.read(sample, 0, sample.length, 0);
    let encoding = 'utf-8';
    let bomBytes = 0;
    if (sampleRead >= 2 && sample[0] === 0xff && sample[1] === 0xfe) {
      encoding = 'utf-16le';
      bomBytes = 2;
    } else if (sampleRead >= 2 && sample[0] === 0xfe && sample[1] === 0xff) {
      encoding = 'utf-16be';
      bomBytes = 2;
    } else if (sampleRead >= 3 && sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) {
      bomBytes = 3;
    }
    const payloadBytes = stats.size - bomBytes;
    const pageCount = Math.max(1, Math.ceil(payloadBytes / PAGE_BYTES));
    if (page >= pageCount) throw new Error(`Page is out of range. This file has ${pageCount} pages.`);
    const start = bomBytes + page * PAGE_BYTES;
    const nominalEnd = Math.min(bomBytes + (page + 1) * PAGE_BYTES, stats.size);
    const buffer = Buffer.alloc(Math.min(nominalEnd - start + 4, stats.size - start));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    let from = 0;
    let to = nominalEnd - start;
    if (encoding === 'utf-8') {
      if (page > 0) while (from < bytesRead && (buffer[from] & 0xc0) === 0x80) from++;
      while (to < bytesRead && (buffer[to] & 0xc0) === 0x80) to++;
    } else {
      const readUnit = offset => encoding === 'utf-16le' ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
      if (page > 0 && bytesRead >= 2 && readUnit(0) >= 0xdc00 && readUnit(0) <= 0xdfff) from = 2;
      if (to + 1 < bytesRead && readUnit(to) >= 0xdc00 && readUnit(to) <= 0xdfff) to += 2;
    }
    let text;
    try {
      text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(buffer.subarray(from, to));
      const decoder = new TextDecoder(encoding, { fatal: true, ignoreBOM: true });
      const sampleText = decoder.decode(sample.subarray(bomBytes, sampleRead), { stream: sampleRead < stats.size });
      if (hasBinaryControls(sampleText) || hasBinaryControls(text)) throw new Error('Binary control characters');
    } catch {
      throw new Error('This file contains binary data or an unsupported text encoding. Supported: UTF-8 and UTF-16 with a BOM.');
    }
    if (revisionOf(await handle.stat()) !== revision) throw new Error('The file changed while reading. Reload the preview.');
    return {
      success: true, text, page, pageCount, pageBytes: PAGE_BYTES,
      fileSize: stats.size, startByte: start + from, endByte: start + to,
      encoding, revision, name: path.basename(target)
    };
  } finally {
    await handle.close();
  }
}

module.exports = { PAGE_BYTES, readTextPage, supportsTextPreview };
