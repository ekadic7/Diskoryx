const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { performance } = require('node:perf_hooks');
const { formatFileSize, normalizeScanFilters } = require('./scanner');

const LARGEST_FILE_LIMIT = 100;
const REPARSE_POINT_ATTRIBUTE = 0x400;
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

function getMftScannerPath(isPackaged) {
  const executableName = process.platform === 'win32'
    ? 'diskoryx-mft-scanner.exe'
    : 'diskoryx-mft-scanner';
  const candidates = isPackaged && process.resourcesPath
    ? [path.join(process.resourcesPath, executableName)]
    : [path.join(__dirname, 'mft-scanner', 'target', 'release', executableName)];
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
    let parent = root;
    let currentPath = rootPath;
    for (const component of components) {
      currentPath = path.win32.join(currentPath, component);
      const key = currentPath.toLowerCase();
      let folder = folderByPath.get(key);
      if (!folder) {
        folder = {
          name: component,
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
        folderByPath.set(key, folder);
      }
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
    const fullPath = path.win32.normalize(inputPath);
    const isRootPath = fullPath.length === rootPath.length && fullPath.toLowerCase() === rootKey;
    const isUnderRoot = fullPath.length > rootPath.length
      && fullPath.slice(0, rootPrefix.length).toLowerCase() === rootPrefixKey;
    if (!isRootPath && !isUnderRoot) {
      skippedCount++;
      return;
    }

    const relativePath = isRootPath ? '' : fullPath.slice(rootPrefix.length);
    const components = relativePath.split('\\').filter(Boolean);
    if (!components.length) return;

    const directoryComponents = record.isDirectory ? components : components.slice(0, -1);
    const excludedIndex = directoryComponents.findIndex((name) => excludedNames.has(name.toLowerCase()));
    if (excludedIndex !== -1) {
      excludedFolders.add(path.win32.join(rootPath, ...directoryComponents.slice(0, excludedIndex + 1)).toLowerCase());
      return;
    }

    if ((record.fileAttributes & REPARSE_POINT_ATTRIBUTE) !== 0) reparsePointCount++;

    if (record.isDirectory) {
      const folder = ensureFolders(components);
      folder.isPlaceholder = false;
      return;
    }

    const parentPath = path.win32.dirname(fullPath);
    const parent = folderByPath.get(parentPath.toLowerCase()) || ensureFolders(directoryComponents);
    const name = components[components.length - 1];
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

  async function finish(summary, scanDurationMs) {
    const pending = [{ node: root, visited: false }];
    let workSinceYield = 0;
    while (pending.length) {
      const { node, visited } = pending.pop();
      if (!visited) {
        pending.push({ node, visited: true });
        for (const child of node.children) {
          if (child.type === 'folder') pending.push({ node: child, visited: false });
          if (++workSinceYield % 4096 === 0) await yieldToEventLoop();
        }
        continue;
      }

      node.rawSize = 0;
      if (node !== root) {
        node.size = '0 B';
      }
      node.fileCount = 0;
      node.folderCount = 0;
      node.extensionStats = Object.create(null);
      for (const child of node.children) {
        node.rawSize += child.type === 'file'
          ? (child.aggregateSize ?? child.rawSize)
          : child.rawSize;
        if (child.type === 'folder') {
          node.fileCount += child.fileCount;
          node.folderCount += child.folderCount + 1;
        } else {
          node.fileCount++;
        }

        const childStats = child.type === 'folder'
          ? child.extensionStats
          : { [child.extension]: { fileCount: 1, totalSizeBytes: child.aggregateSize ?? child.rawSize, oldFilesCount: child.isOld ? 1 : 0 } };
        for (const [extension, value] of Object.entries(childStats)) {
          const current = node.extensionStats[extension] || { fileCount: 0, totalSizeBytes: 0, oldFilesCount: 0 };
          current.fileCount += value.fileCount;
          current.totalSizeBytes += value.totalSizeBytes;
          current.oldFilesCount += value.oldFilesCount;
          node.extensionStats[extension] = current;
          if (++workSinceYield % 4096 === 0) await yieldToEventLoop();
        }
        if (++workSinceYield % 4096 === 0) await yieldToEventLoop();
      }
      if (node !== root) node.size = formatFileSize(node.rawSize);
    }

    root.size = formatFileSize(root.rawSize);
    const largestFiles = [];
    for (const file of fileNodes) {
      addLargestFile(largestFiles, file);
      if (++workSinceYield % 4096 === 0) await yieldToEventLoop();
    }
    largestFiles.sort((left, right) => right.rawSize - left.rawSize);
    const totalSkippedCount = skippedCount
      + (summary?.corruptRecords || 0)
      + (summary?.unresolvedPaths || 0);
    const entriesScanned = fileNodes.length + folderNodes.length - 1 + totalSkippedCount;

    return {
      success: true,
      folderPath: rootPath,
      scanFilters: normalizeScanFilters(scanFilters),
      folderNodes,
      fileNodes,
      largestFiles,
      scanDurationMs,
      entriesPerSecond: entriesScanned / Math.max(scanDurationMs / 1000, 0.001),
      totalSizeBytes: root.rawSize,
      fileCount: fileNodes.length,
      folderCount: folderNodes.length - 1,
      reparsePointCount,
      oldFilesCount: Object.values(root.extensionStats).reduce((total, value) => total + value.oldFilesCount, 0),
      skippedCount: totalSkippedCount,
      filteredCount: 0,
      excludedFolderCount: excludedFolders.size,
      filesByType: Object.fromEntries(Object.entries(root.extensionStats).map(([extension, value]) => [extension, value.fileCount])),
      totalSizeFormatted: formatFileSize(root.rawSize)
    };
  }

  return { addRecord, finish };
}

function isProgressLine(line) {
  return /^Progress:\s+\d+\/\d+ MFT records,/.test(line);
}

function scanMftVolume(folderPath, onProgress, scanFilters = {}, isPackaged = false) {
  if (!isDriveRoot(folderPath)) return Promise.resolve(null);
  const executable = getMftScannerPath(isPackaged);
  if (!executable) return Promise.resolve(null);

  const resolvedRoot = path.win32.resolve(folderPath);
  const driveLetter = resolvedRoot[0];
  const devicePath = `\\\\.\\${driveLetter}:`;
  const started = performance.now();
  const tree = createTreeBuilder(resolvedRoot, scanFilters);

  return new Promise((resolve, reject) => {
    const child = spawn(executable, [devicePath], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    const childClosed = new Promise((resolveClose) => {
      child.once('close', (code, signal) => resolveClose({ code, signal }));
    });
    let summary = null;
    let stderrBuffer = '';
    let stderrTail = '';
    let recordImportMs = 0;
    let recordsImported = 0;

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

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
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

    child.once('error', reject);
    void (async () => {
      try {
        let linesProcessed = 0;
        for await (const line of lines) {
          if (line) {
            const importStarted = performance.now();
            const record = JSON.parse(line);
            if (record.type === 'entry') tree.addRecord(record);
            else if (record.type === 'summary') summary = record;
            recordImportMs += performance.now() - importStarted;
            recordsImported++;
          }
          if (++linesProcessed % 256 === 0) await yieldToEventLoop();
        }

        const { code, signal } = await childClosed;
        if (code !== 0) {
          throw new Error(stderrTail.trim() || `MFT scanner exited with code ${code ?? signal}`);
        }
        if (!summary) throw new Error('MFT scanner finished without a summary record.');
        const totalElapsedMs = performance.now() - started;
        const finalizeStarted = performance.now();
        const result = await tree.finish(summary, totalElapsedMs);
        console.info('[Diskoryx MFT timing]', JSON.stringify({
          helperMs: summary.elapsedMs,
          importAndIndexCpuMs: recordImportMs,
          finalizeMs: performance.now() - finalizeStarted,
          totalMs: performance.now() - started,
          recordsImported
        }));
        resolve(result);
      } catch (error) {
        child.kill();
        reject(error);
      }
    })();
  });
}

module.exports = { createTreeBuilder, getMftScannerPath, isDriveRoot, scanMftVolume };
