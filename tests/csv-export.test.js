const assert = require('node:assert/strict');
const test = require('node:test');
const { escapeCsvCell, iterateScanTree, serializeCsvHeader, serializeCsvRow } = require('../src/main/csv-export');

test('CSV cells preserve commas, quotes, newlines, and Unicode', () => {
  assert.equal(
    escapeCsvCell('Résumé, "final"\nreport'),
    '"Résumé, ""final""\nreport"'
  );
});

test('CSV cells neutralize spreadsheet formulas', () => {
  assert.equal(escapeCsvCell('=1+1'), '"\'=1+1"');
  assert.equal(escapeCsvCell('  @SUM(A1)'), '"\'  @SUM(A1)"');
});

test('CSV header uses CRLF and includes accounting columns', () => {
  const header = serializeCsvHeader();
  assert.ok(header.endsWith('\r\n'));
  assert.match(header, /"SizeBytes","CountedSizeBytes"/);
  assert.match(header, /"HardLinkCount","IsSizeOwner"/);
});

test('hard-link aliases remain exportable but do not add counted bytes', () => {
  const row = serializeCsvRow({
    name: 'alias.txt',
    path: 'C:\\data\\alias.txt',
    extension: 'txt',
    rawSize: 4096,
    aggregateSize: 0,
    sizeOwner: false,
    hardLinkCount: 2,
    date: '2026-10-16T12:00:00.000Z',
    isOld: false
  });

  assert.ok(row.includes('"4096","0"'));
  assert.ok(row.endsWith('"2","false"\r\n'));
});

test('filesystem records without MFT accounting fields count their file size', () => {
  const row = serializeCsvRow({
    name: 'ordinary.txt',
    path: 'C:\\data\\ordinary.txt',
    extension: 'txt',
    rawSize: 123,
    isOld: true
  });

  assert.ok(row.includes('"123","123"'));
  assert.ok(row.endsWith('"1","true"\r\n'));
});

test('tree export includes root, nested folders, empty folders, and file leaves', () => {
  const rows = [...iterateScanTree({
    folderPath: 'C:\\Root',
    totalSizeBytes: 50,
    folderNodes: [{
      children: [
        {
          type: 'folder',
          name: 'Sub',
          path: 'C:\\Root\\Sub',
          rawSize: 50,
          children: [
            {
              type: 'folder',
              name: 'Empty',
              path: 'C:\\Root\\Sub\\Empty',
              rawSize: 0,
              children: []
            },
            {
              type: 'file',
              name: 'leaf.txt',
              path: 'C:\\Root\\Sub\\leaf.txt',
              extension: 'txt',
              rawSize: 50,
              aggregateSize: 50,
              sizeOwner: true
            }
          ]
        },
        {
          type: 'file',
          name: 'top.txt',
          path: 'C:\\Root\\top.txt',
          extension: 'txt',
          rawSize: 0
        }
      ]
    }]
  })];

  assert.deepEqual(rows.map(({ type, name, parentPath, depth }) => ({ type, name, parentPath, depth })), [
    { type: 'folder', name: 'Root', parentPath: '', depth: 0 },
    { type: 'folder', name: 'Sub', parentPath: 'C:\\Root', depth: 1 },
    { type: 'folder', name: 'Empty', parentPath: 'C:\\Root\\Sub', depth: 2 },
    { type: 'file', name: 'leaf.txt', parentPath: 'C:\\Root\\Sub', depth: 2 },
    { type: 'file', name: 'top.txt', parentPath: 'C:\\Root', depth: 1 }
  ]);
  assert.ok(serializeCsvRow(rows[0]).includes('"50",""'));
});

test('a selected subfolder becomes the exported tree root', () => {
  const rows = [...iterateScanTree({
    folderPath: 'C:\\Root\\Chosen',
    totalSizeBytes: 7,
    folderNodes: [{
      children: [{
        type: 'file',
        name: 'only.txt',
        path: 'C:\\Root\\Chosen\\only.txt',
        extension: 'txt',
        rawSize: 7
      }]
    }]
  })];

  assert.equal(rows[0].name, 'Chosen');
  assert.equal(rows[0].depth, 0);
  assert.equal(rows[1].parentPath, 'C:\\Root\\Chosen');
  assert.equal(rows[1].depth, 1);
});
