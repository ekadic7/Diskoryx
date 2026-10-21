const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const DIRECTORY_CONCURRENCY = 8;
const ENTRY_CONCURRENCY = 32;
const PROGRESS_INTERVAL = 250;
const LARGEST_FILE_LIMIT = 100;
const EXPECTED_SCAN_ERRORS = new Set(['EACCES', 'EBUSY', 'EINVAL', 'ENOENT', 'ENOTSUP', 'EPERM']);

function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** unitIndex)).toFixed(1)} ${units[unitIndex]}`;
}

function getAgeInDays(date) {
  return Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 86400000));
}

function normalizeScanFilters(filters = {}) {
  const normalizeList = (value) => [...new Set((Array.isArray(value) ? value : [value])
    .flatMap((entry) => String(entry || '').split(','))
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean))];
  const normalizeExtensions = (value) => normalizeList(value)
    .map((extension) => extension.startsWith('.') ? extension : `.${extension}`);

  return {
    includeExtensions: normalizeExtensions(filters.includeExtensions),
    excludeExtensions: normalizeExtensions(filters.excludeExtensions),
    excludeFolderNames: normalizeList(filters.excludeFolderNames)
  };
}

function logUnexpectedError(action, targetPath, error) {
  if (!EXPECTED_SCAN_ERRORS.has(error.code)) {
    console.warn(`Unable to ${action} ${targetPath}:`, error.message);
  }
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

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, runWorker));
  return results.filter(Boolean);
}

function sortItems(items, sortType) {
  const pending = [items];
  while (pending.length) {
    const currentItems = pending.pop();
    currentItems.sort((left, right) => {
      if (left.type !== right.type) return left.type === 'folder' ? -1 : 1;
      if (sortType === 'size') return right.rawSize - left.rawSize;
      if (sortType === 'date') return (right.date || '').localeCompare(left.date || '');
      if (sortType === 'age') return (left.date || '').localeCompare(right.date || '');
      return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
    });

    for (const item of currentItems) {
      if (item.type === 'folder') pending.push(item.children);
    }
  }
}

function filterItems(items, extensionList) {
  const extensions = new Set((Array.isArray(extensionList) ? extensionList : [extensionList])
    .flatMap((value) => String(value || '').split(','))
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean)
    .map((extension) => extension.startsWith('.') ? extension : `.${extension}`));

  if (!extensions.size) return items;

  const results = new Map();
  const pending = items.slice().reverse().map((item) => ({ item, visited: false }));

  while (pending.length) {
    const { item, visited } = pending.pop();
    if (item.type === 'folder' && !visited) {
      pending.push({ item, visited: true });
      for (let index = item.children.length - 1; index >= 0; index--) {
        pending.push({ item: item.children[index], visited: false });
      }
    } else if (item.type === 'folder') {
      const children = item.children.map((child) => results.get(child)).filter(Boolean);
      if (children.length) {
        const rawSize = children.reduce((total, child) => total + child.rawSize, 0);
        results.set(item, { ...item, children, rawSize, size: formatFileSize(rawSize) });
      } else {
        results.set(item, null);
      }
    } else {
      results.set(item, extensions.has(path.extname(item.name).toLowerCase()) ? item : null);
    }
  }

  return items.map((item) => results.get(item)).filter(Boolean);
}

async function scanFolder(folderPath, onProgress = () => {}, scanFilters = {}) {
  if (typeof folderPath !== 'string' || !folderPath.trim()) {
    return { error: 'A folder path is required.' };
  }

  const resolvedPath = path.resolve(folderPath);
  try {
    if (!(await fs.stat(resolvedPath)).isDirectory()) {
      return { error: 'The selected path is not a folder.' };
    }
  } catch (error) {
    return { error: `Unable to access folder: ${error.message}` };
  }

  const root = { folderId: 0, children: [] };
  const filters = normalizeScanFilters(scanFilters);
  const scanStartedAt = performance.now();
  const folderNodes = [root];
  const fileNodes = [];
  const pendingDirectories = [{ path: resolvedPath, node: root }];
  const stats = { totalSizeBytes: 0, fileCount: 0, folderCount: 0, oldFilesCount: 0, skippedCount: 0, filteredCount: 0, excludedFolderCount: 0, filesByType: {} };
  const largestFiles = [];
  let scannedEntries = 0;
  let lastReportedCount = 0;
  let lastReportedAt = Date.now();

  function reportProgress(force = false) {
    const now = Date.now();
    if (!force && scannedEntries - lastReportedCount < PROGRESS_INTERVAL && now - lastReportedAt < 500) return;
    lastReportedCount = scannedEntries;
    lastReportedAt = now;
    const elapsedMs = performance.now() - scanStartedAt;
    const entriesScanned = scannedEntries + stats.skippedCount;
    try {
      onProgress({
        scannedEntries: entriesScanned,
        fileCount: stats.fileCount,
        folderCount: stats.folderCount,
        skippedCount: stats.skippedCount,
        filteredCount: stats.filteredCount,
        excludedFolderCount: stats.excludedFolderCount,
        elapsedMs,
        entriesPerSecond: entriesScanned / Math.max(elapsedMs / 1000, 0.001)
      });
    } catch {}
  }

  async function scanDirectory(directory) {
    let entries;
    try {
      entries = await fs.readdir(directory.path, { withFileTypes: true });
    } catch (error) {
      stats.skippedCount++;
      logUnexpectedError('read', directory.path, error);
      return;
    }

    entries.sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
      return left.name.localeCompare(right.name);
    });

    directory.node.children = await mapLimit(entries, ENTRY_CONCURRENCY, async (entry) => {
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        stats.skippedCount++;
        return null;
      }
      const fullPath = path.join(directory.path, entry.name);

      if (entry.isDirectory()) {
        if (filters.excludeFolderNames.includes(entry.name.toLowerCase())) {
          stats.excludedFolderCount++;
          scannedEntries++;
          reportProgress();
          return null;
        }
        stats.folderCount++;
        scannedEntries++;
        reportProgress();
        const folder = {
          name: entry.name,
          path: fullPath,
          folderId: folderNodes.length,
          parentFolderId: directory.node.folderId,
          type: 'folder',
          children: [],
          rawSize: 0,
          size: '0 B'
        };
        folderNodes.push(folder);
        return folder;
      }

      const extension = path.extname(entry.name).toLowerCase() || '.unknown';

      try {
        const fileStats = await fs.stat(fullPath);
        const date = fileStats.mtime.toISOString();
        const extensionName = extension.slice(1);
        const file = {
          name: entry.name,
          path: fullPath,
          parentFolderId: directory.node.folderId,
          type: 'file',
          rawSize: fileStats.size,
          size: formatFileSize(fileStats.size),
          date,
          humanDate: fileStats.mtime.toLocaleString(),
          isOld: getAgeInDays(date) >= 30,
          extension: extensionName
        };

        stats.fileCount++;
        stats.totalSizeBytes += fileStats.size;
        if (file.isOld) stats.oldFilesCount++;
        stats.filesByType[extensionName] = (stats.filesByType[extensionName] || 0) + 1;
        addLargestFile(largestFiles, file);
        fileNodes.push(file);
        scannedEntries++;
        reportProgress();
        return file;
      } catch (error) {
        stats.skippedCount++;
        scannedEntries++;
        reportProgress();
        logUnexpectedError('scan', fullPath, error);
        return null;
      }
    });
  }

  while (pendingDirectories.length) {
    const batch = pendingDirectories.splice(0, DIRECTORY_CONCURRENCY);
    await Promise.all(batch.map((directory) => scanDirectory(directory)));
    for (const directory of batch) {
      for (const child of directory.node.children) {
        if (child.type === 'folder') pendingDirectories.push({ path: child.path, node: child });
      }
    }
  }

  const aggregationStack = [{ node: root, visited: false }];
  while (aggregationStack.length) {
    const { node, visited } = aggregationStack.pop();
    if (!visited) {
      aggregationStack.push({ node, visited: true });
      for (const child of node.children) {
        if (child.type === 'folder') aggregationStack.push({ node: child, visited: false });
      }
      continue;
    } else if (node !== root) {
      node.rawSize = node.children.reduce((total, child) => total + child.rawSize, 0);
      node.size = formatFileSize(node.rawSize);
    }

    node.fileCount = 0;
    node.folderCount = 0;
    node.extensionStats = Object.create(null);
    for (const child of node.children) {
      if (child.type === 'folder') {
        node.fileCount += child.fileCount;
        node.folderCount += child.folderCount + 1;
      } else {
        node.fileCount++;
      }

      const childStats = child.type === 'folder'
        ? child.extensionStats
        : { [child.extension]: { fileCount: 1, totalSizeBytes: child.rawSize, oldFilesCount: child.isOld ? 1 : 0 } };
      for (const [extension, value] of Object.entries(childStats)) {
        const current = node.extensionStats[extension] || { fileCount: 0, totalSizeBytes: 0, oldFilesCount: 0 };
        current.fileCount += value.fileCount;
        current.totalSizeBytes += value.totalSizeBytes;
        current.oldFilesCount += value.oldFilesCount;
        node.extensionStats[extension] = current;
      }
    }
  }

  root.rawSize = stats.totalSizeBytes;
  root.size = formatFileSize(root.rawSize);

  reportProgress(true);
  const scanDurationMs = performance.now() - scanStartedAt;
  const entriesScanned = scannedEntries + stats.skippedCount;
  largestFiles.sort((left, right) => right.rawSize - left.rawSize);
  return {
    success: true,
    folderPath: resolvedPath,
    structure: root.children,
    scanFilters: filters,
    folderNodes,
    fileNodes,
    largestFiles,
    scanDurationMs,
    entriesPerSecond: entriesScanned / Math.max(scanDurationMs / 1000, 0.001),
    ...stats,
    totalSizeFormatted: formatFileSize(stats.totalSizeBytes)
  };
}

module.exports = { filterItems, formatFileSize, normalizeScanFilters, scanFolder, sortItems };