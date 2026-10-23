const { startBrokerMftSession } = require('./mft-broker');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { isUtf8 } = require('node:buffer');
const { formatFileSize, normalizeScanFilters } = require('./scanner');

const LARGEST_FILE_LIMIT = 100;
const REPARSE_POINT_ATTRIBUTE = 0x400;
// Wire format shared with mft-scanner/src/main.rs. Bump both sides together.
const MFT_MAGIC = 0x324d5844; // "DXM2"
const MFT_FORMAT_VERSION = 2;
const FOLDER_RECORD_FIXED_SIZE = 10;
const FILE_RECORD_FIXED_SIZE = 29;
const MAX_PENDING_BYTES = 2 * 1024 * 1024;
const MAX_SUMMARY_BYTES = 64 * 1024;
const IMPORT_YIELD_INTERVAL = 8192;
const FINALIZE_YIELD_INTERVAL = 4096;
const TWO_DIGITS = Array.from({ length: 60 }, (_, value) => String(value).padStart(2, '0'));
const THREE_DIGITS = Array.from({ length: 1000 }, (_, value) => String(value).padStart(3, '0'));

const yieldToEventLoop = async (signal) => {
  await new Promise((resolve) => setImmediate(resolve));
  signal?.throwIfAborted();
};

function getMftScannerPath(isPackaged) {
  const executableName = process.platform === 'win32'
    ? 'diskoryx-mft-scanner.exe'
    : 'diskoryx-mft-scanner';
  const candidates = isPackaged && process.resourcesPath
    ? [path.join(process.resourcesPath, executableName)]
    : [
      path.join(__dirname, '..', '..', 'native', 'mft-scanner', 'bin', executableName),
      path.join(__dirname, '..', '..', 'mft-scanner', 'target', 'release', executableName)
    ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function isDriveRoot(folderPath) {
  return process.platform === 'win32' && /^[a-z]:\\$/i.test(folderPath);
}

function addLargestFile(largestFiles, file) {
  if (largestFiles.length < LARGEST_FILE_LIMIT) {
    largestFiles.push(file);
    let index = largestFiles.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (largestFiles[parent].rawSize <= largestFiles[index].rawSize) break;
      [largestFiles[parent], largestFiles[index]] = [largestFiles[index], largestFiles[parent]];
      index = parent;
    }
    return;
  }

  if (file.rawSize <= largestFiles[0].rawSize) return;
  largestFiles[0] = file;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    let smallest = index;
    if (left < largestFiles.length && largestFiles[left].rawSize < largestFiles[smallest].rawSize) smallest = left;
    if (right < largestFiles.length && largestFiles[right].rawSize < largestFiles[smallest].rawSize) smallest = right;
    if (smallest === index) break;
    [largestFiles[index], largestFiles[smallest]] = [largestFiles[smallest], largestFiles[index]];
    index = smallest;
  }
}

// Same result as path.win32.extname(name).toLowerCase().slice(1), without a
// path parser call per file.
function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return 'unknown';
  return name.slice(dot + 1).toLowerCase() || 'unknown';
}

function joinPath(parentPath, name) {
  return parentPath.endsWith('\\') ? parentPath + name : parentPath + '\\' + name;
}

// Same output as new Date(ms).toISOString(), without allocating a Date and a
// second string for every one of hundreds of thousands of files.
function isoFromEpochMs(ms) {
  const days = Math.floor(ms / 86400000);
  let remainder = ms - days * 86400000;
  const shifted = days + 719468;
  const era = Math.floor(shifted / 146097);
  const dayOfEra = shifted - era * 146097;
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1460)
    + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365);
  const year = yearOfEra + era * 400;
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPart = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPart + 2) / 5) + 1;
  const month = monthPart + (monthPart < 10 ? 3 : -9);
  const fullYear = year + (month <= 2 ? 1 : 0);
  const hours = Math.floor(remainder / 3600000);
  remainder -= hours * 3600000;
  const minutes = Math.floor(remainder / 60000);
  remainder -= minutes * 60000;
  const seconds = Math.floor(remainder / 1000);
  const milliseconds = remainder - seconds * 1000;
  const yearText = fullYear >= 0 && fullYear <= 9999
    ? String(fullYear).padStart(4, '0')
    : (fullYear < 0 ? `-${String(-fullYear).padStart(6, '0')}` : `+${String(fullYear).padStart(6, '0')}`);
  return `${yearText}-${TWO_DIGITS[month]}-${TWO_DIGITS[day]}T${TWO_DIGITS[hours]}:${TWO_DIGITS[minutes]}:${TWO_DIGITS[seconds]}.${THREE_DIGITS[milliseconds]}Z`;
}

function createTreeBuilder(folderPath, scanFilters) {
  const rootPath = path.win32.resolve(folderPath);
  const rootKey = rootPath.toLowerCase();
  const rootPrefix = rootPath.endsWith('\\') ? rootPath : `${rootPath}\\`;
  const rootPrefixKey = rootPrefix.toLowerCase();
  const scanTimestamp = Date.now();
  const excludedNames = new Set(normalizeScanFilters(scanFilters).excludeFolderNames);
  const root = { folderId: 0, path: rootPath, children: [] };
  const folderNodes = [root];
  const fileNodes = [];
  const folderByPath = new Map([[rootKey, root]]);
  const excludedFolders = new Set();
  let skippedCount = 0;
  let reparsePointCount = 0;

  function ensureFolders(components) {
    if (!components.length) return root;
    const missing = [];
    let currentPath = rootPrefix + components.join('\\');
    let parent;
    while (!(parent = folderByPath.get(currentPath.toLowerCase()))) {
      missing.push(currentPath);
      currentPath = path.win32.dirname(currentPath);
    }
    while (missing.length) {
      currentPath = missing.pop();
      const folder = {
        name: path.win32.basename(currentPath),
        path: currentPath,
        folderId: folderNodes.length,
        parentFolderId: parent.folderId,
        type: 'folder',
        children: [],
        rawSize: 0,
        size: '0 B',
        isPlaceholder: true
      };
      parent.children.push(folder);
      folderNodes.push(folder);
      folderByPath.set(currentPath.toLowerCase(), folder);
      parent = folder;
    }
    return parent;
  }

  function addRecord(record) {
    if (typeof record.path !== 'string' || !record.path) {
      skippedCount++;
      return;
    }

    let inputPath = record.path;
    const devicePrefix = '\\\\.\\';
    if (inputPath.startsWith(devicePrefix)) inputPath = inputPath.slice(devicePrefix.length);
    const fullPath = inputPath.includes('/') || inputPath.includes('\\\\') ||
      /(?:^|\\)\.{1,2}(?:\\|$)/.test(inputPath) ? path.win32.normalize(inputPath) : inputPath;
    const isRootPath = fullPath.length === rootPath.length && fullPath.toLowerCase() === rootKey;
    const isUnderRoot = fullPath.length > rootPath.length
      && fullPath.slice(0, rootPrefix.length).toLowerCase() === rootPrefixKey;
    if (!isRootPath && !isUnderRoot) {
      skippedCount++;
      return;
    }

    const relativePath = isRootPath ? '' : fullPath.slice(rootPrefix.length);
    if (!relativePath) return;
    const components = record.isDirectory || excludedNames.size
      ? relativePath.split('\\').filter(Boolean) : null;

    const directoryComponents = components && (record.isDirectory ? components : components.slice(0, -1));
    const excludedIndex = directoryComponents ? directoryComponents.findIndex((name) => excludedNames.has(name.toLowerCase())) : -1;
    if (excludedIndex !== -1) {
      excludedFolders.add(path.win32.join(rootPath, ...directoryComponents.slice(0, excludedIndex + 1)).toLowerCase());
      return;
    }

    if ((record.fileAttributes & REPARSE_POINT_ATTRIBUTE) !== 0) reparsePointCount++;

    if (record.isDirectory) {
      const folder = folderByPath.get(fullPath.toLowerCase()) || ensureFolders(components);
      folder.isPlaceholder = false;
      return;
    }

    const lastSeparator = fullPath.lastIndexOf('\\');
    const parentPath = fullPath.endsWith('\\') ? path.win32.dirname(fullPath) :
      fullPath.slice(0, Math.max(lastSeparator, 3));
    const parent = folderByPath.get(parentPath.toLowerCase()) ||
      ensureFolders(directoryComponents || relativePath.split('\\').filter(Boolean).slice(0, -1));
    const name = path.win32.basename(fullPath);
    const modifiedMs = Number.isFinite(record.modifiedMs) ? record.modifiedMs : null;
    const date = modifiedMs === null ? null : new Date(modifiedMs).toISOString();
    const extension = path.win32.extname(name).toLowerCase().slice(1) || 'unknown';
    const rawSize = Number(record.size) || 0;
    const file = {
      name,
      path: fullPath,
      parentFolderId: parent.folderId,
      type: 'file',
      rawSize,
      aggregateSize: record.sizeOwner === false ? 0 : rawSize,
      size: formatFileSize(rawSize),
      date,
      isOld: modifiedMs !== null && scanTimestamp - modifiedMs >= 30 * 86400000,
      extension,
      hardLinkCount: Number(record.hardLinkCount) || 1,
      sizeOwner: record.sizeOwner !== false
    };
    parent.children.push(file);
    fileNodes.push(file);
  }

  async function finish(summary, scanDurationMs, signal) {
    const result = await finalizeScan({
      root, folderNodes, fileNodes, folderPath: rootPath, scanFilters, scanTimestamp,
      skippedCount, reparsePointCount, excludedFolderCount: excludedFolders.size, summary, signal
    });
    result.scanDurationMs = scanDurationMs;
    result.entriesPerSecond = (result.fileCount + result.folderCount + result.skippedCount)
      / Math.max(scanDurationMs / 1000, 0.001);
    return result;
  }

  return { addRecord, finish };
}

// Builds the tree straight from the scanner's compact records: every folder was
// already sent with its parent id, so no path map or path splitting is needed.
function createBinaryTree(folderPath, scanTimestamp, scanFilters) {
  const folderNodes = [{ folderId: 0, path: folderPath, children: [] }];
  const fileNodes = [];
  const excludedNames = new Set(normalizeScanFilters(scanFilters).excludeFolderNames);
  // Stream order includes excluded folders; null marks one whose subtree is skipped.
  const streamFolders = [folderNodes[0]];
  let reparsePointCount = 0;
  let excludedFolderCount = 0;

  function addFolder(parentFolderId, name, fileAttributes) {
    const parent = streamFolders[parentFolderId];
    if (parent === undefined) throw new Error('MFT scanner returned a folder whose parent is missing.');
    if (parent === null) {
      streamFolders.push(null);
      return;
    }
    if (excludedNames.has(name.toLowerCase())) {
      streamFolders.push(null);
      excludedFolderCount++;
      return;
    }
    const folder = {
      name,
      path: joinPath(parent.path, name),
      folderId: folderNodes.length,
      parentFolderId: parent.folderId,
      type: 'folder',
      children: [],
      rawSize: 0,
      size: '0 B',
      isPlaceholder: false
    };
    parent.children.push(folder);
    folderNodes.push(folder);
    streamFolders.push(folder);
    if ((fileAttributes & REPARSE_POINT_ATTRIBUTE) !== 0) reparsePointCount++;
  }

  function addFile(parentFolderId, name, size, modifiedMs, fileAttributes, hardLinkCount, sizeOwner) {
    const parent = streamFolders[parentFolderId];
    if (parent === undefined) throw new Error('MFT scanner returned a file whose folder is missing.');
    if (parent === null) return;
    const file = {
      name,
      path: joinPath(parent.path, name),
      parentFolderId: parent.folderId,
      type: 'file',
      rawSize: size,
      aggregateSize: sizeOwner ? size : 0,
      size: formatFileSize(size),
      date: modifiedMs === null ? null : isoFromEpochMs(modifiedMs),
      isOld: modifiedMs !== null && scanTimestamp - modifiedMs >= 30 * 86400000,
      extension: extensionOf(name),
      hardLinkCount,
      sizeOwner
    };
    parent.children.push(file);
    fileNodes.push(file);
    if ((fileAttributes & REPARSE_POINT_ATTRIBUTE) !== 0) reparsePointCount++;
  }

  return {
    folderNodes, fileNodes, addFolder, addFile,
    get reparsePointCount() { return reparsePointCount; },
    get excludedFolderCount() { return excludedFolderCount; }
  };
}

// Folder ids follow parent-before-child order, so one reverse pass folds every
// folder into its parent without a stack or visited set.
async function finalizeScan(options) {
  const {
    root, folderNodes, fileNodes, folderPath, scanFilters, scanTimestamp,
    skippedCount, reparsePointCount, excludedFolderCount, summary, signal
  } = options;
  let work = 0;
  signal?.throwIfAborted();

  for (const node of folderNodes) {
    node.rawSize = 0;
    node.fileCount = 0;
    node.folderCount = 0;
    node.extensionStats = Object.create(null);
    if ((++work % FINALIZE_YIELD_INTERVAL) === 0) await yieldToEventLoop(signal);
  }

  const largestFiles = [];
  for (const file of fileNodes) {
    const parent = folderNodes[file.parentFolderId];
    const counted = file.aggregateSize ?? file.rawSize;
    parent.rawSize += counted;
    parent.fileCount++;
    const stats = parent.extensionStats[file.extension]
      || (parent.extensionStats[file.extension] = { fileCount: 0, totalSizeBytes: 0, oldFilesCount: 0 });
    stats.fileCount++;
    stats.totalSizeBytes += counted;
    if (file.isOld) stats.oldFilesCount++;
    addLargestFile(largestFiles, file);
    if ((++work % FINALIZE_YIELD_INTERVAL) === 0) await yieldToEventLoop(signal);
  }

  for (let index = folderNodes.length - 1; index > 0; index--) {
    const node = folderNodes[index];
    const parent = folderNodes[node.parentFolderId];
    node.size = formatFileSize(node.rawSize);
    parent.rawSize += node.rawSize;
    parent.fileCount += node.fileCount;
    parent.folderCount += node.folderCount + 1;
    const parentStats = parent.extensionStats;
    for (const extension in node.extensionStats) {
      const value = node.extensionStats[extension];
      const current = parentStats[extension]
        || (parentStats[extension] = { fileCount: 0, totalSizeBytes: 0, oldFilesCount: 0 });
      current.fileCount += value.fileCount;
      current.totalSizeBytes += value.totalSizeBytes;
      current.oldFilesCount += value.oldFilesCount;
      if ((++work % FINALIZE_YIELD_INTERVAL) === 0) await yieldToEventLoop(signal);
    }
    if ((++work % FINALIZE_YIELD_INTERVAL) === 0) await yieldToEventLoop(signal);
  }
  root.size = formatFileSize(root.rawSize);

  largestFiles.sort((left, right) => right.rawSize - left.rawSize);
  const totalSkippedCount = skippedCount
    + (summary?.corruptRecords || 0)
    + (summary?.unresolvedPaths || 0);

  return {
    success: true,
    folderPath,
    scanStartedAt: scanTimestamp,
    scanFilters: normalizeScanFilters(scanFilters),
    folderNodes,
    fileNodes,
    largestFiles,
    scanDurationMs: 0,
    entriesPerSecond: 0,
    totalSizeBytes: root.rawSize,
    fileCount: fileNodes.length,
    folderCount: folderNodes.length - 1,
    reparsePointCount,
    oldFilesCount: Object.values(root.extensionStats).reduce((total, value) => total + value.oldFilesCount, 0),
    skippedCount: totalSkippedCount,
    filteredCount: 0,
    excludedFolderCount,
    filesByType: Object.fromEntries(Object.entries(root.extensionStats).map(([extension, value]) => [extension, value.fileCount])),
    totalSizeFormatted: formatFileSize(root.rawSize)
  };
}

function readUInt64AsNumber(buffer, offset) {
  const low = buffer.readUInt32LE(offset);
  const high = buffer.readUInt32LE(offset + 4);
  return low + high * 4294967296;
}

function readInt64AsNumber(buffer, offset) {
  const low = buffer.readUInt32LE(offset);
  const high = buffer.readInt32LE(offset + 4);
  return low + high * 4294967296;
}

function readName(buffer, start, end) {
  if (!isUtf8(buffer.subarray(start, end))) throw new Error('Invalid MFT name encoding.');
  const name = buffer.toString('utf8', start, end);
  if (!name || name === '.' || name === '..' || /[\\/\0:]/.test(name)) {
    throw new Error('Invalid MFT name component.');
  }
  return name;
}

function validateSummary(summary, folderCount, fileCount) {
  const counts = ['recordSlots', 'files', 'directories', 'unresolvedPaths', 'corruptRecords', 'memoryBytes'];
  if (!summary || summary.type !== 'summary'
    || counts.some(key => !Number.isSafeInteger(summary[key]) || summary[key] < 0)
    || !Number.isFinite(summary.elapsedMs) || summary.elapsedMs < 0
    || !Number.isInteger(summary.logicalBytes) || summary.logicalBytes < 0
    || summary.files !== fileCount || summary.directories !== folderCount) {
    throw new Error('Invalid MFT summary record or record counts.');
  }
  return summary;
}

async function importBinaryScan(session, tree, signal) {
  let pending = null;
  let phase = 0;
  let foldersLeft = 0;
  let filesLeft = 0;
  let processed = 0;
  let folderCount = 0;
  let fileCount = 0;
  let summaryBytes = 0;
  const summaryChunks = [];

  for await (const chunk of session.stdout.iterator({ destroyOnReturn: false })) {
    signal?.throwIfAborted();
    let buffer = pending ? Buffer.concat([pending, chunk]) : chunk;
    let offset = 0;

    while (true) {
      if (phase === 0) {
        if (buffer.length - offset < 12) break;
        if (buffer.readUInt32LE(offset) !== MFT_MAGIC) {
          throw new Error('Unsupported MFT scanner output; rebuild the bundled scanner.');
        }
        if (buffer.readUInt32LE(offset + 4) !== MFT_FORMAT_VERSION) {
          throw new Error('Unsupported MFT scanner format version; rebuild the bundled scanner.');
        }
        foldersLeft = buffer.readUInt32LE(offset + 8);
        folderCount = foldersLeft;
        offset += 12;
        phase = 1;
      } else if (phase === 1) {
        if (foldersLeft === 0) {
          phase = 2;
          continue;
        }
        if (buffer.length - offset < FOLDER_RECORD_FIXED_SIZE) break;
        const nameLength = buffer.readUInt16LE(offset + 8);
        const recordSize = FOLDER_RECORD_FIXED_SIZE + nameLength;
        if (buffer.length - offset < recordSize) break;
        tree.addFolder(
          buffer.readUInt32LE(offset),
          readName(buffer, offset + FOLDER_RECORD_FIXED_SIZE, offset + recordSize),
          buffer.readUInt32LE(offset + 4)
        );
        offset += recordSize;
        foldersLeft--;
      } else if (phase === 2) {
        if (buffer.length - offset < 4) break;
        filesLeft = buffer.readUInt32LE(offset);
        fileCount = filesLeft;
        offset += 4;
        phase = 3;
      } else if (phase === 3) {
        if (filesLeft === 0) {
          phase = 4;
          break;
        }
        if (buffer.length - offset < FILE_RECORD_FIXED_SIZE) break;
        const nameLength = buffer.readUInt16LE(offset + 27);
        const recordSize = FILE_RECORD_FIXED_SIZE + nameLength;
        if (buffer.length - offset < recordSize) break;
        const flags = buffer[offset + 26];
        const hardLinkCount = buffer.readUInt16LE(offset + 24);
        const modifiedMs = flags & 2 ? readInt64AsNumber(buffer, offset + 12) : null;
        if ((flags & ~3) !== 0 || hardLinkCount === 0
          || (modifiedMs !== null && Math.abs(modifiedMs) > 8640000000000000)) {
          throw new Error('Invalid MFT file metadata.');
        }
        tree.addFile(
          buffer.readUInt32LE(offset),
          readName(buffer, offset + FILE_RECORD_FIXED_SIZE, offset + recordSize),
          readUInt64AsNumber(buffer, offset + 4),
          modifiedMs,
          buffer.readUInt32LE(offset + 20),
          hardLinkCount,
          (flags & 1) !== 0
        );
        offset += recordSize;
        filesLeft--;
      } else {
        break;
      }
      if ((++processed % IMPORT_YIELD_INTERVAL) === 0) await yieldToEventLoop(signal);
    }

    pending = buffer.subarray(offset);
    if (phase === 4) {
      summaryBytes += pending.length;
      if (summaryBytes > MAX_SUMMARY_BYTES) throw new Error('MFT summary exceeds the supported size limit.');
      if (pending.length) summaryChunks.push(pending);
      pending = null;
    } else if (pending.length > MAX_PENDING_BYTES) {
      throw new Error('MFT record exceeds the supported size limit.');
    }
    await yieldToEventLoop(signal);
  }

  // A truncated stream is reported after the caller has inspected the helper's
  // exit status, so a spawn failure is not masked by a parsing error.
  if (phase !== 4) return null;
  const text = Buffer.concat(summaryChunks).toString('utf8').trim();
  if (!text) throw new Error('MFT scanner finished without a summary record.');
  let summary;
  try {
    summary = JSON.parse(text);
  } catch (error) {
    throw new Error('Invalid MFT summary JSON.', { cause: error });
  }
  return validateSummary(summary, folderCount, fileCount);
}

function isProgressLine(line) {
  return /^Progress:\s+\d+\/\d+ MFT records,/.test(line);
}

async function scanMftVolume(folderPath, onProgress, scanFilters = {}, isPackaged = false, signal) {
  signal?.throwIfAborted();
  if (!isDriveRoot(folderPath)) return Promise.resolve(null);
  const executable = getMftScannerPath(isPackaged);
  if (!executable) return Promise.resolve(null);

  const resolvedRoot = path.win32.resolve(folderPath);
  const driveLetter = resolvedRoot[0];
  const devicePath = `\\\\.\\${driveLetter}:`;
  const scanTimestamp = Date.now();
  const tree = createBinaryTree(resolvedRoot, scanTimestamp, scanFilters);

  const session = await startBrokerMftSession(executable, devicePath, signal);
  // Time the scan, not how long the user spends at the UAC prompt.
  const started = performance.now();
  return new Promise((resolve, reject) => {
    session.stderr.setEncoding('utf8');
    let summary = null;
    let stderrBuffer = '';
    let stderrTail = '';
    let importMs = 0;

    session.stderr.on('data', (chunk) => {
      if (signal?.aborted) return;
      stderrTail = `${stderrTail}${chunk}`.slice(-8192);
      stderrBuffer += chunk;
      const messages = stderrBuffer.split(/\r?\n/);
      stderrBuffer = messages.pop() || '';
      for (const message of messages) {
        if (!isProgressLine(message)) continue;
        const numbers = [...message.matchAll(/\d+/g)].map((match) => Number(match[0]));
        const elapsedMs = performance.now() - started;
        const scannedEntries = (numbers[2] || 0) + (numbers[3] || 0);
        onProgress({
          scannedEntries,
          fileCount: numbers[2] || 0,
          folderCount: numbers[3] || 0,
          skippedCount: 0,
          filteredCount: 0,
          excludedFolderCount: 0,
          elapsedMs,
          entriesPerSecond: scannedEntries / Math.max(elapsedMs / 1000, 0.001)
        });
      }
    });

    void (async () => {
      try {
        onProgress({
          scannedEntries: 0,
          fileCount: 0,
          folderCount: 0,
          skippedCount: 0,
          filteredCount: 0,
          excludedFolderCount: 0,
          elapsedMs: 0,
          entriesPerSecond: 0
        });
        const importStarted = performance.now();
        summary = await importBinaryScan(session, tree, signal);
        importMs = performance.now() - importStarted;

        const { code, signal: exitSignal, error: spawnError } = await session.completion;
        signal?.throwIfAborted();
        if (spawnError) throw spawnError;
        if (code !== 0) {
          throw new Error(stderrTail.trim() || `MFT scanner exited with code ${code ?? exitSignal}`);
        }
        if (!summary) throw new Error('The MFT scanner ended before all records were received.');
        const totalElapsedMs = performance.now() - started;
        const finalizeStarted = performance.now();
        const result = await finalizeScan({
          root: tree.folderNodes[0],
          folderNodes: tree.folderNodes,
          fileNodes: tree.fileNodes,
          folderPath: resolvedRoot,
          scanFilters,
          scanTimestamp,
          skippedCount: 0,
          reparsePointCount: tree.reparsePointCount,
          excludedFolderCount: tree.excludedFolderCount,
          summary,
          signal
        });
        signal?.throwIfAborted();
        result.scanDurationMs = performance.now() - started;
        result.entriesPerSecond = (result.fileCount + result.folderCount + result.skippedCount)
          / Math.max(result.scanDurationMs / 1000, 0.001);
        console.info('[Diskoryx MFT timing]', JSON.stringify({
          helperMs: summary.elapsedMs,
          importMs,
          finalizeMs: performance.now() - finalizeStarted,
          totalMs: result.scanDurationMs,
          recordsImported: result.fileCount + result.folderCount,
          transferMs: Math.round(totalElapsedMs - summary.elapsedMs)
        }));
        resolve(result);
      } catch (error) {
        await session.dispose();
        reject(error);
      }
    })();
  });
}

module.exports = { createTreeBuilder, finalizeScan, getMftScannerPath, isDriveRoot, scanMftVolume };
