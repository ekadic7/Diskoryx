const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { performance } = require('node:perf_hooks');
const { formatFileSize, normalizeScanFilters } = require('./scanner');
const { finalizeScan } = require('./mft-scanner');

// Saved scan archive, version 1. One UTF-8 record per line:
//   {"type":"diskoryx-scan-archive","version":1,...header...}
//   {"type":"folder","parent":0,"name":"Windows"}
//   {"type":"file","parent":1,"name":"setup.log","size":123,"modified":1690000000000,"links":1,"owner":true}
//   {"type":"end","folders":2,"files":1}
// Only metadata is stored. Paths, sizes, aggregates and analyses are rebuilt on
// open from the recorded parent indices, so an archive cannot inject totals.
const ARCHIVE_TYPE = 'diskoryx-scan-archive';
const ARCHIVE_VERSION = 1;
const ARCHIVE_EXTENSION = '.diskoryxscan';
const MAX_FOLDERS = 2000000;
const MAX_FILES = 5000000;
const MAX_LINE_CHARS = 4096;
const MAX_NAME_CHARS = 255;
const MAX_PATH_CHARS = 32767;
const MAX_VERSION_CHARS = 32;
const MAX_FILTER_ITEMS = 256;
const YIELD_INTERVAL = 8192;
const OLD_FILE_AGE_MS = 30 * 86400000;
const MAX_DATE_MS = 8640000000000000;
const READ_CHUNK_BYTES = 1024 * 1024;
const ARCHIVE_RESOURCE_LIMITS = Object.freeze({
  maxDepth: 256,
  maxPathChars: 64 * 1024 * 1024,
  maxAggregateEntries: 500000,
  maxAggregateChars: 8 * 1024 * 1024,
  maxAggregateWork: 8000000
});

function resourceLimits(overrides = {}) {
  const limits = {};
  for (const [key, maximum] of Object.entries(ARCHIVE_RESOURCE_LIMITS)) {
    const value = overrides[key] ?? maximum;
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new Error(`Invalid saved scan resource limit: ${key}.`);
    }
    limits[key] = value;
  }
  return limits;
}

// Count exactly the extension entries finalizeScan would retain, without
// allocating its aggregate objects. Release child sets as they are folded.
async function checkAggregateBudget(folderNodes, fileNodes, limits, signal) {
  const sets = new Array(folderNodes.length);
  let entries = 0;
  let chars = 0;
  let work = 0;
  const add = (index, extension) => {
    if (++work > limits.maxAggregateWork) {
      throw new Error('The saved scan exceeds the extension aggregation work limit.');
    }
    const set = sets[index];
    if (set?.has(extension)) return;
    if (entries + 1 > limits.maxAggregateEntries || chars + extension.length > limits.maxAggregateChars) {
      throw new Error('The saved scan exceeds the extension aggregation memory limit.');
    }
    entries++;
    chars += extension.length;
    (set || (sets[index] = new Set())).add(extension);
  };
  const yieldIfNeeded = async () => {
    if (work % YIELD_INTERVAL !== 0) return;
    throwIfAborted(signal);
    await new Promise(resolve => setImmediate(resolve));
    throwIfAborted(signal);
  };
  throwIfAborted(signal);
  for (const file of fileNodes) {
    add(file.parentFolderId, file.extension);
    if (work % YIELD_INTERVAL === 0) await yieldIfNeeded();
  }
  for (let index = folderNodes.length - 1; index > 0; index--) {
    if (++work > limits.maxAggregateWork) {
      throw new Error('The saved scan exceeds the extension aggregation work limit.');
    }
    if (work % YIELD_INTERVAL === 0) await yieldIfNeeded();
    const set = sets[index];
    if (!set) continue;
    for (const extension of set) {
      add(folderNodes[index].parentFolderId, extension);
      if (work % YIELD_INTERVAL === 0) await yieldIfNeeded();
    }
    sets[index] = null;
  }
  throwIfAborted(signal);
}

function archivePathFor(targetPath) {
  return path.extname(targetPath).toLowerCase() === ARCHIVE_EXTENSION
    ? targetPath
    : `${targetPath}${ARCHIVE_EXTENSION}`;
}

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return 'unknown';
  return name.slice(dot + 1).toLowerCase() || 'unknown';
}

// Shared with the reader so the writer can never emit a record it would refuse.
function validateEntryName(name) {
  if (typeof name !== 'string' || !name) throw new Error('an entry has an empty name');
  if (name.length > MAX_NAME_CHARS) throw new Error('an entry name is too long');
  if (name === '.' || name === '..') throw new Error('an entry name is not a real file name');
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(name)) throw new Error('an entry name contains an unsupported character');
  return name;
}

function validateRoot(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_PATH_CHARS) {
    throw new Error('The saved scan has an invalid root path.');
  }
  if (!/^[A-Za-z]:\\/.test(value) || /^\\\\/.test(value)) {
    throw new Error('Saved scans can only be opened for a local drive path.');
  }
  if (value.includes('/') || /[\u0000-\u001f]/.test(value)) {
    throw new Error('The saved scan root path contains unsupported characters.');
  }
  const segments = value.split('\\');
  if (segments.some(segment => segment === '.' || segment === '..')) {
    throw new Error('The saved scan root path contains a relative segment.');
  }
  if (value.length > 3 && value.endsWith('\\')) {
    throw new Error('The saved scan root path has an unexpected trailing separator.');
  }
  return value;
}

function joinPath(parentPath, name) {
  return parentPath.endsWith('\\') ? parentPath + name : `${parentPath}\\${name}`;
}

function countFolder(folder) {
  if (!folder || typeof folder !== 'object' || !Array.isArray(folder.children)) {
    throw new Error('The scan tree is incomplete and cannot be saved.');
  }
}

// The scanned tree is the source of truth, not the folderNodes index, so items
// that were removed by file actions or live updates are never resurrected. The
// walk is parent-before-child depth first, which preserves every child's order
// (folders and files may be interleaved in an MFT scan) and keeps folder ids
// lower than their children's ids in the reopened result.
function collectArchiveTree(scan) {
  const root = scan.folderNodes?.[0];
  countFolder(root);
  const pending = [root];
  let folders = 0;
  let files = 0;
  while (pending.length) {
    const folder = pending.pop();
    countFolder(folder);
    for (const item of folder.children) {
      if (item?.type === 'folder') {
        if (++folders > MAX_FOLDERS) throw new Error('This scan has too many folders to save.');
        pending.push(item);
      } else if (item?.type === 'file') {
        if (++files > MAX_FILES) throw new Error('This scan has too many files to save.');
      }
    }
  }
  return { folders, files };
}

function fileRecord(parent, file) {
  if (!Number.isSafeInteger(file.rawSize) || file.rawSize < 0) {
    throw new Error(`the saved size of "${file.path}" is not a valid byte count`);
  }
  let modified = null;
  if (file.date !== null && file.date !== undefined) {
    modified = Date.parse(file.date);
    if (!Number.isFinite(modified) || Math.abs(modified) > MAX_DATE_MS) {
      throw new Error(`the modification date of "${file.path}" is invalid`);
    }
  }
  const links = file.hardLinkCount || 1;
  if (!Number.isInteger(links) || links < 1 || links > 65535) {
    throw new Error(`the hard-link count of "${file.path}" is invalid`);
  }
  return {
    type: 'file',
    parent,
    name: validateEntryName(file.name),
    size: file.rawSize,
    modified,
    links,
    owner: file.sizeOwner !== false
  };
}

async function* archiveLines(scan, tree, header, options) {
  yield `${JSON.stringify(header)}\n`;
  const total = tree.folders + tree.files;
  let written = 0;
  let nextIndex = 1;
  const pending = [];
  const pushChildren = (folder, folderIndex) => {
    for (let child = folder.children.length - 1; child >= 0; child--) {
      const item = folder.children[child];
      if (item?.type === 'folder' || item?.type === 'file') pending.push({ folder, folderIndex, item });
    }
  };
  pushChildren(scan.folderNodes[0], 0);
  while (pending.length) {
    const { folder, folderIndex, item } = pending.pop();
    if (item.type === 'folder') {
      const index = nextIndex++;
      yield `${JSON.stringify({ type: 'folder', parent: folderIndex, name: validateEntryName(item.name) })}\n`;
      pushChildren(item, index);
    } else {
      yield `${JSON.stringify(fileRecord(folderIndex, item))}\n`;
    }
    if ((++written % YIELD_INTERVAL) === 0) {
      options.signal?.throwIfAborted();
      await new Promise(resolve => setImmediate(resolve));
      options.onProgress?.({ written, total });
    }
  }
  yield `${JSON.stringify({ type: 'end', folders: tree.folders, files: tree.files })}\n`;
}

async function saveScanArchive(scan, targetPath, options = {}) {
  if (typeof targetPath !== 'string' || !targetPath.trim()) {
    throw new Error('Choose where to save the scan file.');
  }
  options.signal?.throwIfAborted();
  const tree = collectArchiveTree(scan);
  const outputPath = archivePathFor(targetPath);
  const scanFilters = normalizeScanFilters(scan.scanFilters);
  const scanStartedAt = Number.isFinite(scan.scanStartedAt) ? scan.scanStartedAt : Date.now();
  const header = {
    type: ARCHIVE_TYPE,
    version: ARCHIVE_VERSION,
    appVersion: typeof options.appVersion === 'string'
      ? options.appVersion.slice(0, MAX_VERSION_CHARS) : '',
    savedAt: new Date().toISOString(),
    volumeId: Number.isSafeInteger(options.volumeId) ? options.volumeId : null,
    root: validateRoot(scan.folderPath),
    scanStartedAt,
    scanDurationMs: Number.isFinite(scan.scanDurationMs) && scan.scanDurationMs >= 0 ? scan.scanDurationMs : 0,
    entriesPerSecond: Number.isFinite(scan.entriesPerSecond) && scan.entriesPerSecond >= 0
      ? scan.entriesPerSecond : 0,
    scanMode: scan.scanMode === 'mft' ? 'mft' : 'standard',
    scanModeReason: typeof scan.scanModeReason === 'string' ? scan.scanModeReason.slice(0, 500) : '',
    scanFilters,
    capacity: normalizeCapacitySnapshot(scan.capacity),
    counts: { folders: tree.folders, files: tree.files },
    counters: {
      skippedCount: safeCounter(scan.skippedCount),
      filteredCount: safeCounter(scan.filteredCount),
      reparsePointCount: safeCounter(scan.reparsePointCount),
      excludedFolderCount: safeCounter(scan.excludedFolderCount)
    }
  };

  const temporary = path.join(path.dirname(outputPath),
    `.${path.basename(outputPath)}.${randomBytes(8).toString('hex')}.partial`);
  try {
    await pipeline(
      Readable.from(archiveLines(scan, tree, header, options)),
      fs.createWriteStream(temporary, { encoding: 'utf8' })
    );
    options.signal?.throwIfAborted();
    await fsp.rename(temporary, outputPath);
  } catch (error) {
    await fsp.rm(temporary, { force: true, maxRetries: 3 }).catch(() => {});
    throw error;
  }
  options.onProgress?.({ written: tree.folders + tree.files, total: tree.folders + tree.files });
  return { filePath: outputPath, folderCount: tree.folders, fileCount: tree.files, savedAt: header.savedAt };
}

function safeCounter(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

// Historical capacity recorded during a live scan. Missing or invalid values
// become null ("Not available"), never zero.
function normalizeCapacitySnapshot(value) {
  if (!value || typeof value !== 'object') return null;
  const { totalBytes, availableBytes, capturedAt, volumePath } = value;
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) return null;
  if (!Number.isSafeInteger(availableBytes) || availableBytes < 0 || availableBytes > totalBytes) return null;
  if (!Number.isFinite(capturedAt) || Math.abs(capturedAt) > MAX_DATE_MS) return null;
  return {
    totalBytes,
    availableBytes,
    capturedAt,
    volumePath: typeof volumePath === 'string' ? volumePath.slice(0, 260) : ''
  };
}

// Bounded line reader: the archive is untrusted input, so a single huge line
// must fail instead of being buffered whole.
async function* readLines(stream, signal) {
  let pending = '';
  let first = true;
  for await (const chunk of stream) {
    signal?.throwIfAborted();
    pending += chunk;
    let start = 0;
    let newline = pending.indexOf('\n', start);
    while (newline !== -1) {
      let line = pending.slice(start, newline);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (first) { line = line.replace(/^\uFEFF/, ''); first = false; }
      if (line.length > MAX_LINE_CHARS) throw new Error('The saved scan contains an oversized line.');
      yield line;
      start = newline + 1;
      newline = pending.indexOf('\n', start);
    }
    pending = pending.slice(start);
    if (pending.length > MAX_LINE_CHARS) throw new Error('The saved scan contains an oversized line.');
  }
  signal?.throwIfAborted();
  let tail = pending;
  if (first) tail = tail.replace(/^\uFEFF/, '');
  else if (tail.endsWith('\r')) tail = tail.slice(0, -1);
  if (tail.length) yield tail;
}

function parseRecord(line, lineNumber) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    throw new Error(`The saved scan line ${lineNumber} is not valid JSON.`);
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`The saved scan line ${lineNumber} is not a valid record.`);
  }
  return record;
}

function readScanHeader(line, lineNumber) {
  const header = parseRecord(line, lineNumber);
  if (header.type !== ARCHIVE_TYPE) {
    throw new Error('This file is not a Diskoryx saved scan.');
  }
  if (!Number.isInteger(header.version) || header.version < 1) {
    throw new Error('The saved scan has an unsupported format version.');
  }
  if (header.version > ARCHIVE_VERSION) {
    throw new Error('This saved scan was written by a newer Diskoryx version. Update Diskoryx to open it.');
  }
  if (header.version !== ARCHIVE_VERSION) {
    throw new Error('The saved scan has an unsupported format version.');
  }
  const root = validateRoot(header.root);
  const counts = header.counts;
  if (!counts || !Number.isSafeInteger(counts.folders) || !Number.isSafeInteger(counts.files)
    || counts.folders < 0 || counts.files < 0) {
    throw new Error('The saved scan does not declare valid item counts.');
  }
  if (counts.folders > MAX_FOLDERS || counts.files > MAX_FILES) {
    throw new Error('This saved scan is larger than the supported size limit.');
  }
  const savedAtMs = Date.parse(header.savedAt);
  if (!Number.isFinite(savedAtMs)) throw new Error('The saved scan has an invalid capture date.');
  if (header.scanStartedAt !== null && header.scanStartedAt !== undefined
    && (!Number.isFinite(header.scanStartedAt) || Math.abs(header.scanStartedAt) > MAX_DATE_MS)) {
    throw new Error('The saved scan has an invalid scan start time.');
  }
  for (const value of [header.scanDurationMs, header.entriesPerSecond]) {
    if (!Number.isFinite(value) || value < 0) throw new Error('The saved scan has invalid timing metadata.');
  }
  if (!header.counters || typeof header.counters !== 'object') {
    throw new Error('The saved scan has invalid coverage counters.');
  }
  const counters = {};
  for (const key of ['skippedCount', 'filteredCount', 'reparsePointCount', 'excludedFolderCount']) {
    const value = header.counters[key];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('The saved scan has invalid coverage counters.');
    }
    counters[key] = value;
  }
  const filters = normalizeScanFilters(header.scanFilters);
  for (const list of Object.values(filters)) {
    if (list.length > MAX_FILTER_ITEMS) throw new Error('The saved scan has too many filters.');
  }
  const scanMode = header.scanMode === 'mft' ? 'mft' : 'standard';
  const appVersion = typeof header.appVersion === 'string' ? header.appVersion.slice(0, MAX_VERSION_CHARS) : '';
  return {
    root, counts, counters, filters, scanMode, appVersion,
    volumeId: Number.isSafeInteger(header.volumeId) ? header.volumeId : null,
    scanModeReason: typeof header.scanModeReason === 'string' ? header.scanModeReason.slice(0, 500) : '',
    savedAt: new Date(savedAtMs).toISOString(),
    scanStartedAt: Number.isFinite(header.scanStartedAt) ? header.scanStartedAt : savedAtMs,
    scanDurationMs: header.scanDurationMs,
    entriesPerSecond: header.entriesPerSecond,
    capacity: normalizeCapacitySnapshot(header.capacity)
  };
}

async function readScanArchive(sourcePath, options = {}) {
  const limits = resourceLimits(options.resourceLimits);
  const started = performance.now();
  const stream = fs.createReadStream(sourcePath, { encoding: 'utf8', highWaterMark: READ_CHUNK_BYTES });
  const folderNodes = [];
  const fileNodes = [];
  let header = null;
  let root = null;
  let end = null;
  let lineNumber = 0;
  let processed = 0;
  const folderDepths = [0];
  let pathChars = 0;

  const checkPathBudget = (entryPath, depth) => {
    if (depth > limits.maxDepth) {
      throw new Error('The saved scan exceeds the supported tree depth limit.');
    }
    if (entryPath.length > limits.maxPathChars - pathChars) {
      throw new Error('The saved scan exceeds the total expanded path character limit.');
    }
    pathChars += entryPath.length;
  };

  const report = () => {
    if (!header) return;
    options.onProgress?.({
      processed,
      folders: header.counts.folders,
      files: header.counts.files,
      elapsedMs: performance.now() - started
    });
  };

  try {
    for await (const line of readLines(stream, options.signal)) {
      lineNumber++;
      if (!line.trim()) throw new Error(`The saved scan line ${lineNumber} is empty.`);
      if (lineNumber === 1) {
        header = readScanHeader(line, lineNumber);
        checkPathBudget(header.root, 0);
        root = { folderId: 0, path: header.root, children: [] };
        folderNodes.push(root);
        continue;
      }
      if (end) throw new Error('The saved scan continues after its end record.');
      const record = parseRecord(line, lineNumber);
      if (record.type === 'folder') {
        if (folderNodes.length - 1 >= header.counts.folders) {
          throw new Error('The saved scan contains more folders than it declares.');
        }
        const parent = record.parent;
        if (!Number.isInteger(parent) || parent < 0 || parent >= folderNodes.length) {
          throw new Error(`The saved scan line ${lineNumber} has an invalid folder parent reference.`);
        }
        const name = validateEntryName(record.name);
        const parentFolder = folderNodes[parent];
        const depth = folderDepths[parent] + 1;
        const folderPath = joinPath(parentFolder.path, name);
        if (folderPath.length > MAX_PATH_CHARS) {
          throw new Error(`The saved scan line ${lineNumber} produces an overlong path.`);
        }
        checkPathBudget(folderPath, depth);
        const folder = {
          name,
          path: folderPath,
          folderId: folderNodes.length,
          parentFolderId: parentFolder.folderId,
          type: 'folder',
          children: [],
          rawSize: 0,
          size: '0 B',
          isPlaceholder: false
        };
        parentFolder.children.push(folder);
        folderNodes.push(folder);
        folderDepths.push(depth);
      } else if (record.type === 'file') {
        if (fileNodes.length >= header.counts.files) {
          throw new Error('The saved scan contains more files than it declares.');
        }
        const parent = record.parent;
        if (!Number.isInteger(parent) || parent < 0 || parent >= folderNodes.length) {
          throw new Error(`The saved scan line ${lineNumber} has an invalid file parent reference.`);
        }
        const name = validateEntryName(record.name);
        const size = record.size;
        if (!Number.isSafeInteger(size) || size < 0) {
          throw new Error(`The saved scan line ${lineNumber} has an invalid file size.`);
        }
        const modified = record.modified;
        if (modified !== null && (!Number.isInteger(modified) || Math.abs(modified) > MAX_DATE_MS)) {
          throw new Error(`The saved scan line ${lineNumber} has an invalid modification date.`);
        }
        const links = record.links;
        if (!Number.isInteger(links) || links < 1 || links > 65535) {
          throw new Error(`The saved scan line ${lineNumber} has an invalid hard-link count.`);
        }
        if (typeof record.owner !== 'boolean') {
          throw new Error(`The saved scan line ${lineNumber} has an invalid size-owner flag.`);
        }
        const parentFolder = folderNodes[parent];
        const filePath = joinPath(parentFolder.path, name);
        if (filePath.length > MAX_PATH_CHARS) {
          throw new Error(`The saved scan line ${lineNumber} produces an overlong path.`);
        }
        checkPathBudget(filePath, folderDepths[parent] + 1);
        parentFolder.children.push({
          name,
          path: filePath,
          parentFolderId: parentFolder.folderId,
          type: 'file',
          rawSize: size,
          aggregateSize: record.owner ? size : 0,
          size: formatFileSize(size),
          date: modified === null ? null : new Date(modified).toISOString(),
          humanDate: modified === null ? undefined : new Date(modified).toLocaleString(),
          isOld: modified !== null && header.scanStartedAt - modified >= OLD_FILE_AGE_MS,
          extension: extensionOf(name),
          hardLinkCount: links,
          sizeOwner: record.owner
        });
        fileNodes.push(parentFolder.children.at(-1));
      } else if (record.type === 'end') {
        if (!Number.isSafeInteger(record.folders) || !Number.isSafeInteger(record.files)) {
          throw new Error('The saved scan has an invalid end record.');
        }
        end = record;
      } else {
        throw new Error(`The saved scan line ${lineNumber} has an unknown record type.`);
      }
      if ((++processed % YIELD_INTERVAL) === 0) {
        options.signal?.throwIfAborted();
        await new Promise(resolve => setImmediate(resolve));
        report();
      }
    }
  } catch (error) {
    stream.destroy();
    throwIfAborted(options.signal);
    throw error;
  } finally {
    stream.destroy();
  }

  if (!header) throw new Error('The saved scan is empty.');
  if (!end) throw new Error('The saved scan is incomplete or was cut off.');
  if (end.folders !== header.counts.folders || end.files !== header.counts.files) {
    throw new Error('The saved scan end record does not match its declared counts.');
  }
  if (folderNodes.length - 1 !== header.counts.folders || fileNodes.length !== header.counts.files) {
    throw new Error('The saved scan does not contain the number of items it declares.');
  }

  await checkAggregateBudget(folderNodes, fileNodes, limits, options.signal);
  const result = await finalizeScan({
    root,
    folderNodes,
    fileNodes,
    folderPath: root.path,
    scanFilters: header.filters,
    scanTimestamp: header.scanStartedAt,
    skippedCount: header.counters.skippedCount,
    reparsePointCount: header.counters.reparsePointCount,
    excludedFolderCount: header.counters.excludedFolderCount,
    summary: null,
    signal: options.signal
  });
  throwIfAborted(options.signal);
  result.scanDurationMs = header.scanDurationMs;
  result.entriesPerSecond = header.entriesPerSecond;
  result.scanStartedAt = header.scanStartedAt;
  result.scanMode = header.scanMode;
  result.scanModeReason = header.scanModeReason;
  result.filteredCount = header.counters.filteredCount;
  result.capacity = header.capacity;
  result.readOnly = true;
  result.archive = {
    version: ARCHIVE_VERSION,
    savedAt: header.savedAt,
    appVersion: header.appVersion,
    volumeId: Number.isSafeInteger(header.volumeId) ? header.volumeId : null
  };
  options.onProgress?.({
    processed: folderNodes.length - 1 + fileNodes.length,
    folders: folderNodes.length - 1,
    files: fileNodes.length,
    elapsedMs: performance.now() - started
  });
  return result;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  const aborted = new Error('Opening the saved scan was cancelled.');
  aborted.name = 'AbortError';
  throw aborted;
}

module.exports = {
  ARCHIVE_EXTENSION,
  ARCHIVE_VERSION,
  ARCHIVE_RESOURCE_LIMITS,
  archivePathFor,
  readScanArchive,
  saveScanArchive,
  validateEntryName,
  validateRoot
};
