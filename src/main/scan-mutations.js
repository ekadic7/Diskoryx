const path = require('node:path');
const { formatFileSize } = require('./scanner');

// Prepare without changing the snapshot; apply only after the filesystem action succeeds.
async function prepareScanMutation(scan, item, destination) {
  const removedFiles = new Set();
  const removedFolders = [];
  const renamed = [];
  const pending = [item];
  let work = 0;
  while (pending.length) {
    const node = pending.pop();
    if (destination) {
      renamed.push([node, destination + node.path.slice(item.path.length)]);
    } else if (node.type === 'file') {
      removedFiles.add(node);
    } else {
      removedFolders.push(node);
    }
    if (node.type === 'folder') {
      for (const child of node.children) {
        pending.push(child);
        if (++work % 4096 === 0) await new Promise(resolve => setImmediate(resolve));
      }
    }
    if (++work % 4096 === 0) await new Promise(resolve => setImmediate(resolve));
  }

  let remainingFiles;
  if (!destination) {
    remainingFiles = [];
    for (const file of scan.fileNodes) {
      if (!removedFiles.has(file)) remainingFiles.push(file);
      if (++work % 4096 === 0) await new Promise(resolve => setImmediate(resolve));
    }
  }
  const parent = scan.folderNodes[item.parentFolderId];
  const extensionStats = item.type === 'folder' ? item.extensionStats : {
    [item.extension]: {
      fileCount: 1, totalSizeBytes: item.aggregateSize ?? item.rawSize,
      oldFilesCount: item.isOld ? 1 : 0
    }
  };
  const nextExtension = destination && item.type === 'file'
    ? path.extname(destination).toLowerCase().slice(1) || 'unknown'
    : null;

  return () => {
    if (destination) {
      for (const [node, newPath] of renamed) node.path = newPath;
      item.name = path.basename(destination);
      if (nextExtension) item.extension = nextExtension;
    } else {
      parent.children = parent.children.filter(child => child !== item);
      for (const folder of removedFolders) scan.folderNodes[folder.folderId] = null;
      scan.fileNodes = remainingFiles;
      scan.largestFiles = scan.largestFiles.filter(file => !removedFiles.has(file));
    }

    for (let ancestor = parent; ancestor; ancestor = scan.folderNodes[ancestor.parentFolderId]) {
      if (!destination) {
        ancestor.rawSize -= item.type === 'file' ? item.aggregateSize ?? item.rawSize : item.rawSize;
        ancestor.fileCount -= item.type === 'file' ? 1 : item.fileCount;
        ancestor.folderCount -= item.type === 'folder' ? item.folderCount + 1 : 0;
        ancestor.size = formatFileSize(ancestor.rawSize);
      }
      if (!destination || (nextExtension && nextExtension !== Object.keys(extensionStats)[0])) {
        for (const [extension, stats] of Object.entries(extensionStats)) {
          const current = ancestor.extensionStats[extension];
          current.fileCount -= stats.fileCount;
          current.totalSizeBytes -= stats.totalSizeBytes;
          current.oldFilesCount -= stats.oldFilesCount;
          if (!current.fileCount) delete ancestor.extensionStats[extension];
          if (destination) {
            const next = ancestor.extensionStats[nextExtension] ||= { fileCount: 0, totalSizeBytes: 0, oldFilesCount: 0 };
            next.fileCount += stats.fileCount;
            next.totalSizeBytes += stats.totalSizeBytes;
            next.oldFilesCount += stats.oldFilesCount;
          }
        }
      }
    }
    const root = scan.folderNodes[0];
    scan.fileCount = root.fileCount;
    scan.folderCount = root.folderCount;
    scan.totalSizeBytes = root.rawSize;
    scan.totalSizeFormatted = formatFileSize(root.rawSize);
    scan.oldFilesCount = Object.values(root.extensionStats).reduce((sum, stats) => sum + stats.oldFilesCount, 0);
    scan.filesByType = Object.fromEntries(Object.entries(root.extensionStats).map(([extension, stats]) => [extension, stats.fileCount]));
    if (scan.structure) scan.structure = root.children;
  };
}

module.exports = { prepareScanMutation };
