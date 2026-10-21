const CSV_HEADERS = [
  'Type',
  'Name',
  'FullPath',
  'ParentPath',
  'Depth',
  'SizeBytes',
  'CountedSizeBytes',
  'Extension',
  'Modified',
  'IsOld',
  'HardLinkCount',
  'IsSizeOwner'
];

function escapeCsvCell(value) {
  let text = String(value ?? '');
  if (/^[\t\r ]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function serializeCsvHeader() {
  return `${CSV_HEADERS.map(escapeCsvCell).join(',')}\r\n`;
}

function serializeCsvRow(file) {
  const isFolder = file.type === 'folder';
  const sizeOwner = file.sizeOwner !== false;
  const countedSize = isFolder ? '' : Number.isFinite(file.aggregateSize)
    ? file.aggregateSize
    : (sizeOwner ? file.rawSize : 0);
  const values = [
    file.type,
    file.name,
    file.path,
    file.parentPath,
    file.depth,
    file.rawSize,
    countedSize,
    isFolder || !file.extension ? '' : `.${file.extension}`,
    isFolder ? '' : (file.date || ''),
    isFolder ? '' : (file.isOld ? 'true' : 'false'),
    isFolder ? '' : (file.hardLinkCount || 1),
    isFolder ? '' : (sizeOwner ? 'true' : 'false')
  ];
  return `${values.map(escapeCsvCell).join(',')}\r\n`;
}

function* iterateScanTree(scan) {
  const rootPath = scan.folderPath;
  const trimmedRootPath = rootPath.replace(/[\\/]+$/, '');
  const rootName = trimmedRootPath.split(/[\\/]/).pop() || rootPath;
  yield {
    type: 'folder',
    name: rootName,
    path: rootPath,
    parentPath: '',
    depth: 0,
    rawSize: scan.totalSizeBytes || 0
  };

  const pending = [];
  const rootChildren = scan.folderNodes[0]?.children || [];
  for (let index = rootChildren.length - 1; index >= 0; index--) {
    pending.push({ item: rootChildren[index], parentPath: rootPath, depth: 1 });
  }

  while (pending.length) {
    const { item, parentPath, depth } = pending.pop();
    yield { ...item, parentPath, depth };
    if (item.type !== 'folder') continue;
    for (let index = item.children.length - 1; index >= 0; index--) {
      pending.push({ item: item.children[index], parentPath: item.path, depth: depth + 1 });
    }
  }
}

module.exports = { escapeCsvCell, iterateScanTree, serializeCsvHeader, serializeCsvRow };