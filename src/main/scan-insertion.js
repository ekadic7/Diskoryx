const fs = require('node:fs/promises');
const path = require('node:path');
const { scanFolder, formatFileSize } = require('./scanner');

async function insertCopiedItem(scan, destination) {
  const parent = scan.folderNodes.find(folder => folder &&
    (folder.path || scan.folderPath).toLowerCase() === path.dirname(destination).toLowerCase());
  if (!parent) return false;
  if (parent.children.some(node => node.path.toLowerCase() === destination.toLowerCase())) {
    throw new Error('The copied destination is already in this snapshot.');
  }
  const stat = await fs.lstat(destination);
  if (stat.isSymbolicLink()) throw new Error('The copied destination was replaced by a link.');
  let item;
  let folders = [];
  let files;
  if (stat.isDirectory()) {
    if (scan.scanFilters?.excludeFolderNames?.includes(path.basename(destination).toLowerCase())) return false;
    const fresh = await scanFolder(destination, undefined, scan.scanFilters);
    if (!fresh.success || fresh.skippedCount) throw new Error(fresh.error || 'Not all copied items could be read.');
    folders = fresh.folderNodes;
    files = fresh.fileNodes;
    const idBase = scan.folderNodes.length;
    for (const folder of folders) {
      folder.folderId += idBase;
      folder.parentFolderId = folder === folders[0] ? parent.folderId : folder.parentFolderId + idBase;
    }
    for (const file of files) file.parentFolderId += idBase;
    item = Object.assign(folders[0], {
      type: 'folder', name: path.basename(destination), path: destination,
      size: formatFileSize(fresh.totalSizeBytes), rawSize: fresh.totalSizeBytes
    });
  } else if (stat.isFile()) {
    item = {
      type: 'file', name: path.basename(destination), path: destination,
      parentFolderId: parent.folderId, rawSize: stat.size, size: formatFileSize(stat.size),
      extension: path.extname(destination).toLowerCase().slice(1) || 'unknown',
      date: stat.mtime.toISOString(), isOld: Date.now() - stat.mtimeMs >= 30 * 86400000
    };
    files = [item];
  } else throw new Error('The copied destination is not a regular file or folder.');
  const stats = item.type === 'folder' ? item.extensionStats : {
    [item.extension]: { fileCount: 1, totalSizeBytes: item.rawSize, oldFilesCount: item.isOld ? 1 : 0 }
  };
  parent.children.push(item);
  scan.folderNodes.push(...folders);
  scan.fileNodes.push(...files);
  for (let ancestor = parent; ancestor; ancestor = scan.folderNodes[ancestor.parentFolderId]) {
    ancestor.rawSize += item.rawSize;
    ancestor.size = formatFileSize(ancestor.rawSize);
    ancestor.fileCount += item.type === 'file' ? 1 : item.fileCount;
    ancestor.folderCount += item.type === 'folder' ? item.folderCount + 1 : 0;
    for (const [extension, value] of Object.entries(stats)) {
      const current = ancestor.extensionStats[extension] ||= { fileCount: 0, totalSizeBytes: 0, oldFilesCount: 0 };
      current.fileCount += value.fileCount;
      current.totalSizeBytes += value.totalSizeBytes;
      current.oldFilesCount += value.oldFilesCount;
    }
  }
  const root = scan.folderNodes[0];
  Object.assign(scan, {
    fileCount: root.fileCount, folderCount: root.folderCount, totalSizeBytes: root.rawSize,
    totalSizeFormatted: formatFileSize(root.rawSize),
    oldFilesCount: Object.values(root.extensionStats).reduce((sum, value) => sum + value.oldFilesCount, 0),
    filesByType: Object.fromEntries(Object.entries(root.extensionStats).map(([key, value]) => [key, value.fileCount]))
  });
  // Legacy Top 100 remains in sync, although the separate view indexes all files.
  scan.largestFiles = [...scan.largestFiles, ...files].sort((a, b) => b.rawSize - a.rawSize).slice(0, 100);
  return item;
}

module.exports = { insertCopiedItem };
