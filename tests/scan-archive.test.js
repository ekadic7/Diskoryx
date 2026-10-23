const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { formatFileSize, scanFolder } = require('../src/main/scanner');
const { finalizeScan } = require('../src/main/mft-scanner');
const {
  ARCHIVE_EXTENSION, ARCHIVE_RESOURCE_LIMITS, archivePathFor, readScanArchive, saveScanArchive, validateEntryName
} = require('../src/main/scan-archive');

const TYPE = 'file';
const FOLDER = 'folder';

function fileProjection(file) {
  return {
    name: file.name,
    path: file.path,
    type: file.type,
    rawSize: file.rawSize,
    countedSize: file.aggregateSize ?? file.rawSize,
    size: file.size,
    date: file.date,
    humanDate: file.humanDate,
    isOld: file.isOld,
    extension: file.extension,
    hardLinkCount: file.hardLinkCount ?? 1,
    sizeOwner: file.sizeOwner !== false
  };
}

function treeShape(node, isRoot = false) {
  return {
    // A folder scan's root node carries only its id and children; the archive
    // root also stores the path it was saved with.
    type: isRoot ? null : node.type,
    name: isRoot ? null : node.name,
    path: isRoot ? null : node.path,
    rawSize: node.rawSize,
    size: node.size,
    fileCount: node.fileCount,
    folderCount: node.folderCount,
    extensionStats: node.extensionStats,
    file: node.type === TYPE ? fileProjection(node) : null,
    children: (node.children || []).map(child => treeShape(child))
  };
}

function assertCountedTree(scan) {
  // Folder ids must stay sequential with a parent that already exists, so a
  // reopened archive can be navigated exactly like a live scan.
  for (let index = 0; index < scan.folderNodes.length; index++) {
    const folder = scan.folderNodes[index];
    assert.equal(folder.folderId, index);
    if (index === 0) continue;
    assert.ok(folder.parentFolderId < index, `folder ${index} has a forward parent`);
    assert.equal(scan.folderNodes[folder.parentFolderId].children.includes(folder), true);
  }
  for (const file of scan.fileNodes) {
    assert.equal(file.type, TYPE);
    assert.equal(scan.folderNodes[file.parentFolderId].children.includes(file), true);
  }
}

function largestProjection(scan) {
  return scan.largestFiles
    .map(file => [file.path, file.rawSize, file.aggregateSize ?? file.rawSize])
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

function assertScanParity(original, reopened) {
  for (const key of ['folderPath', 'scanFilters', 'fileCount', 'folderCount', 'totalSizeBytes',
    'totalSizeFormatted', 'oldFilesCount', 'skippedCount', 'filteredCount',
    'excludedFolderCount', 'filesByType', 'scanMode', 'scanStartedAt']) {
    assert.deepEqual(reopened[key], original[key], `Mismatched ${key}`);
  }
  // Standard folder scans do not track reparse points; both sides normalise to 0.
  assert.equal(reopened.reparsePointCount ?? 0, original.reparsePointCount ?? 0);
  assert.deepEqual(reopened.folderNodes[0].extensionStats, original.folderNodes[0].extensionStats);
  assert.deepEqual(treeShape(reopened.folderNodes[0], true), treeShape(original.folderNodes[0], true));
  assert.deepEqual(largestProjection(reopened), largestProjection(original));
  assertCountedTree(reopened);
}

async function fixtureRoot(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'diskoryx-archive-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true, maxRetries: 10 }));
  return folder;
}

// A scan object exactly as either scanner produces it, so saved scans are
// compared against real scanner accounting rather than a hand-made shape.
async function syntheticScan() {
  const oldDate = new Date(Date.now() - 40 * 86400000);
  const recent = new Date(Date.now() - 3 * 86400000);
  const root = { folderId: 0, path: 'C:\\Scan', children: [] };
  const folderNodes = [root];
  const fileNodes = [];

  const addFolder = (name, parentFolderId) => {
    const parent = folderNodes[parentFolderId];
    const folder = {
      name,
      path: `${parent.path.endsWith('\\') ? parent.path : `${parent.path}\\`}${name}`,
      folderId: folderNodes.length,
      parentFolderId,
      type: FOLDER,
      children: [],
      rawSize: 0,
      size: '0 B',
      isPlaceholder: false
    };
    parent.children.push(folder);
    folderNodes.push(folder);
    return folder.folderId;
  };
  const addFile = (name, parentFolderId, options = {}) => {
    const parent = folderNodes[parentFolderId];
    const size = options.size ?? 0;
    const modified = options.modified === undefined ? recent.getTime() : options.modified;
    const owner = options.owner !== false;
    const file = {
      name,
      path: `${parent.path.endsWith('\\') ? parent.path : `${parent.path}\\`}${name}`,
      parentFolderId,
      type: TYPE,
      rawSize: size,
      aggregateSize: owner ? size : 0,
      size: formatFileSize(size),
      date: modified === null ? null : new Date(modified).toISOString(),
      humanDate: modified === null ? undefined : new Date(modified).toLocaleString(),
      isOld: modified !== null && Date.now() - modified >= 40 * 86400000,
      extension: (name.lastIndexOf('.') > 0 ? name.slice(name.lastIndexOf('.') + 1) : 'unknown').toLowerCase(),
      hardLinkCount: options.links ?? 1,
      sizeOwner: owner
    };
    parent.children.push(file);
    fileNodes.push(file);
    return file;
  };

  const programs = addFolder('Programs', 0);
  const app = addFolder('App', programs);
  addFolder('Empty', programs);
  const docs = addFolder('Документи 2026', 0);
  addFile('boot.ini', 0, { size: 500, modified: recent.getTime() });
  addFile('readme.TXT', programs, { size: 100, modified: oldDate.getTime() });
  addFile('data.unknown', programs, { size: 0 });
  addFile('app.exe', app, { size: 4000, links: 2 });
  addFile('alias.exe', app, { size: 4000, links: 2, owner: false });
  addFile('résumé 😀.log', docs, { size: 7, modified: null });

  const result = await finalizeScan({
    root,
    folderNodes,
    fileNodes,
    folderPath: 'C:\\Scan',
    scanFilters: { excludeFolderNames: ['node_modules'], includeExtensions: [], excludeExtensions: ['.tmp'] },
    scanTimestamp: Date.now(),
    skippedCount: 3,
    reparsePointCount: 2,
    excludedFolderCount: 1,
    summary: null
  });
  result.scanDurationMs = 4321;
  result.entriesPerSecond = 1234.5;
  result.scanMode = 'mft';
  result.scanModeReason = '';
  return result;
}

test('a saved scan reopens with identical tree, totals, filters and analysis data', async t => {
  const folder = await fixtureRoot(t);
  await fs.mkdir(path.join(folder, 'nested', 'deep'), { recursive: true });
  await fs.mkdir(path.join(folder, 'empty'));
  await fs.writeFile(path.join(folder, 'one.txt'), '1234');
  await fs.writeFile(path.join(folder, 'nested', 'two.json'), '{}');
  await fs.writeFile(path.join(folder, 'nested', 'deep', 'three.tar.gz'), 'x'.repeat(64));
  await fs.writeFile(path.join(folder, 'Ünïcode 😀.LOG'), 'line');
  const old = new Date(Date.now() - 45 * 86400000);
  await fs.utimes(path.join(folder, 'one.txt'), old, old);

  const scan = await scanFolder(folder, undefined, { excludeFolderNames: ['skipped'] }, new AbortController().signal);
  scan.scanMode = 'standard';
  scan.scanModeReason = 'Folder scans use filesystem traversal.';
  const target = path.join(folder, 'saved-scan');
  const saved = await saveScanArchive(scan, target, { appVersion: '1.0.2' });
  assert.equal(saved.filePath, `${target}${ARCHIVE_EXTENSION}`);
  assert.equal(saved.fileCount, scan.fileCount);
  assert.equal(saved.folderCount, scan.folderCount);

  const reopened = await readScanArchive(saved.filePath);
  assert.equal(reopened.readOnly, true);
  assert.equal(reopened.archive.version, 1);
  assert.equal(reopened.archive.appVersion, '1.0.2');
  assert.equal(reopened.archive.savedAt, saved.savedAt);
  assert.match(reopened.archive.savedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(reopened.scanDurationMs, scan.scanDurationMs);
  assert.equal(reopened.entriesPerSecond, scan.entriesPerSecond);
  assert.equal(reopened.scanModeReason, scan.scanModeReason);
  assertScanParity(scan, reopened);
});

test('hard-link ownership, empty folders, Unicode names and missing dates survive a round trip', async t => {
  const folder = await fixtureRoot(t);
  const scan = await syntheticScan();
  const saved = await saveScanArchive(scan, path.join(folder, 'synthetic.diskoryxscan'));
  const reopened = await readScanArchive(saved.filePath);

  assertScanParity(scan, reopened);
  const aliases = reopened.fileNodes.filter(file => file.hardLinkCount === 2);
  assert.equal(aliases.length, 2);
  assert.deepEqual(aliases.map(file => file.sizeOwner).sort(), [false, true]);
  assert.equal(aliases.find(file => file.sizeOwner).aggregateSize, 4000);
  assert.equal(aliases.find(file => !file.sizeOwner).aggregateSize, 0);
  assert.equal(reopened.totalSizeBytes, 500 + 100 + 0 + 4000 + 0 + 7);
  assert.equal(reopened.fileNodes.find(file => file.name === 'résumé 😀.log').date, null);
  assert.equal(reopened.folderNodes.some(node => node.name === 'Empty' && node.children.length === 0), true);
  assert.equal(reopened.scanFilters.excludeFolderNames.join(), 'node_modules');
  assert.equal(reopened.folderCount, 4);
  assert.equal(reopened.skippedCount, 3);
  assert.equal(reopened.reparsePointCount, 2);
  assert.equal(reopened.excludedFolderCount, 1);
});

function headerLine(overrides = {}) {
  return JSON.stringify({
    type: 'diskoryx-scan-archive',
    version: 1,
    appVersion: '1.0.2',
    savedAt: '2026-10-21T12:00:00.000Z',
    root: 'C:\\Scan',
    scanStartedAt: 1700000000000,
    scanDurationMs: 120,
    entriesPerSecond: 10,
    scanMode: 'standard',
    scanModeReason: '',
    scanFilters: { includeExtensions: [], excludeExtensions: [], excludeFolderNames: [] },
    counts: { folders: 2, files: 1 },
    counters: { skippedCount: 0, filteredCount: 0, reparsePointCount: 0, excludedFolderCount: 0 },
    ...overrides
  });
}

const folderRecord = (parent, name) => JSON.stringify({ type: 'folder', parent, name });
const fileRecord = (parent, name, overrides = {}) => JSON.stringify({
  type: 'file', parent, name, size: 10, modified: 1700000000000, links: 1, owner: true, ...overrides
});
const endRecord = (folders = 2, files = 1) => JSON.stringify({ type: 'end', folders, files });

function validLines() {
  return [
    headerLine(),
    folderRecord(0, 'Sub'),
    folderRecord(1, 'Deep'),
    fileRecord(2, 'a.txt'),
    endRecord()
  ];
}

async function writeArchive(t, lines, name = 'archive.diskoryxscan') {
  const folder = await fixtureRoot(t);
  const target = path.join(folder, name);
  await fs.writeFile(target, lines.join('\n') + (lines.length ? '\n' : ''));
  return target;
}

async function instrumentedReader(onFinalize, onYield = () => {}) {
  const filename = path.join(__dirname, '..', 'src', 'main', 'scan-archive.js');
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(await fs.readFile(filename, 'utf8'), {
    module,
    require: name => name === './mft-scanner'
      ? { finalizeScan: options => { onFinalize(); return finalizeScan(options); } }
      : localRequire(name),
    setImmediate: callback => setImmediate(() => { onYield(); callback(); })
  }, { filename });
  return module.exports.readScanArchive;
}

function nestedExtensionLines(depth, extensions) {
  return [
    headerLine({ counts: { folders: depth, files: extensions.length } }),
    ...Array.from({ length: depth }, (_, parent) => folderRecord(parent, 'd')),
    ...extensions.map((extension, index) => fileRecord(depth, `f${index}.${extension}`)),
    endRecord(depth, extensions.length)
  ];
}

test('archive resource ceilings refuse small amplification fixtures before finalization', async t => {
  let finalizations = 0;
  const read = await instrumentedReader(() => { finalizations++; });
  const target = await writeArchive(t, nestedExtensionLines(3, ['e000', 'e001', 'e002']));
  const cases = [
    [{ maxDepth: 3 }, /tree depth limit/],
    [{ maxPathChars: 20 }, /total expanded path character limit/],
    [{ maxAggregateEntries: 11 }, /extension aggregation memory limit/],
    [{ maxAggregateChars: 47 }, /extension aggregation memory limit/],
    [{ maxAggregateWork: 14 }, /extension aggregation work limit/]
  ];
  for (const [resourceLimits, expected] of cases) {
    await assert.rejects(read(target, { resourceLimits }), expected);
  }
  assert.equal(finalizations, 0, 'over-budget archives must never enter finalizeScan');

  const accepted = await read(target, { resourceLimits: {
    maxDepth: 4, maxAggregateEntries: 12, maxAggregateChars: 48, maxAggregateWork: 15
  } });
  assert.equal(finalizations, 1);
  assert.equal(accepted.fileCount, 3);
  assert.equal(accepted.totalSizeBytes, 30);
  assert.equal(accepted.folderNodes.reduce((sum, folder) =>
    sum + Object.keys(folder.extensionStats).length, 0), 12);

  // Repeated extensions cost work but do not consume extra aggregate entries.
  const repeated = await writeArchive(t, nestedExtensionLines(3, ['txt', 'txt', 'txt']));
  await read(repeated, { resourceLimits: {
    maxAggregateEntries: 4, maxAggregateChars: 12, maxAggregateWork: 9
  } });
  await assert.rejects(read(repeated, { resourceLimits: { maxAggregateWork: 8 } }),
    /extension aggregation work limit/);
});

test('production archive depth limit rejects a compact deep-tree fixture', async t => {
  const depth = ARCHIVE_RESOURCE_LIMITS.maxDepth;
  const target = await writeArchive(t, nestedExtensionLines(depth, ['txt']));
  await assert.rejects(readScanArchive(target), /tree depth limit/);
  const foldersOnly = await writeArchive(t, nestedExtensionLines(depth, []));
  assert.equal((await readScanArchive(foldersOnly)).folderCount, depth);
});

test('internal archive limit overrides cannot raise production ceilings', async t => {
  const target = await writeArchive(t, validLines());
  for (const [key, value] of Object.entries(ARCHIVE_RESOURCE_LIMITS)) {
    await assert.rejects(readScanArchive(target, { resourceLimits: { [key]: value + 1 } }),
      /Invalid saved scan resource limit/);
  }
});

test('archive aggregation preflight yields and cancels before finalization', async t => {
  const controller = new AbortController();
  let finalizations = 0;
  let yields = 0;
  const read = await instrumentedReader(() => { finalizations++; }, () => {
    yields++;
    controller.abort();
  });
  // Fewer than 8192 input records: the first cooperative yield is in preflight.
  const target = await writeArchive(t,
    nestedExtensionLines(2, Array.from({ length: 5000 }, (_, index) => `e${index}`)));
  await assert.rejects(read(target, { signal: controller.signal }), error => error.name === 'AbortError');
  assert.equal(yields, 1);
  assert.equal(finalizations, 0);
});

test('finalization yields inside a wide extension merge and observes cancellation', async () => {
  const filename = path.join(__dirname, '..', 'src', 'main', 'mft-scanner.js');
  const module = { exports: {} };
  const controller = new AbortController();
  let yields = 0;
  vm.runInNewContext(await fs.readFile(filename, 'utf8'), {
    module, Buffer, process, __dirname: path.dirname(filename),
    require: createRequire(filename),
    setImmediate: callback => setImmediate(() => {
      if (++yields === 2) controller.abort();
      callback();
    })
  }, { filename });
  const root = { folderId: 0, children: [] };
  const child = { folderId: 1, parentFolderId: 0, children: [] };
  const fileNodes = Array.from({ length: 5000 }, (_, index) => ({
    parentFolderId: 1, extension: `e${index}`, rawSize: 1
  }));
  await assert.rejects(module.exports.finalizeScan({
    root, folderNodes: [root, child], fileNodes, folderPath: 'C:\\Scan',
    scanTimestamp: 1700000000000, skippedCount: 0, signal: controller.signal
  }), error => error.name === 'AbortError');
  assert.equal(yields, 2, 'second yield must occur inside the child-extension loop');
  assert.ok(Object.keys(root.extensionStats).length > 0);
  assert.ok(Object.keys(root.extensionStats).length < 5000);
});

test('malformed, truncated and hostile archives are refused with a clear error', async t => {
  const cases = [
    ['a zero-byte file', [], /empty/i],
    ['a non-archive JSON document', ['{"type":"other"}'], /not a Diskoryx saved scan/],
    ['a JSON scalar record', ['123'], /not a valid record/],
    ['a newer format version', [headerLine({ version: 2 })], /newer Diskoryx version/],
    ['a non-numeric version', [headerLine({ version: '1' })], /unsupported format version/],
    ['a missing end record', validLines().slice(0, 4), /incomplete or was cut off/],
    ['a truncated JSON line', [...validLines().slice(0, 3), '{"type":"file","parent":2,"na'], /not valid JSON/],
    ['records after the end record', [...validLines(), fileRecord(2, 'late.txt')], /continues after its end record/],
    ['an unknown record type', [headerLine(), JSON.stringify({ type: 'link' })], /unknown record type/],
    ['an empty line', [headerLine(), '', endRecord(0, 0)], /is empty/],
    ['a self-referencing folder', [headerLine(), folderRecord(1, 'Loop'), endRecord(1, 0)], /invalid folder parent/],
    ['a forward folder reference', [headerLine(), folderRecord(3, 'Ahead'), endRecord(1, 0)], /invalid folder parent/],
    ['a negative folder parent', [headerLine(), folderRecord(-1, 'Below'), endRecord(1, 0)], /invalid folder parent/],
    ['a missing file parent', [headerLine(), fileRecord(4, 'orphan.txt'), endRecord(0, 1)], /invalid file parent/],
    ['more folders than declared', [headerLine(), folderRecord(0, 'A'), folderRecord(0, 'B'), folderRecord(0, 'C'), endRecord(2, 0)], /more folders than it declares/],
    ['more files than declared', [headerLine(), fileRecord(0, 'a.txt'), fileRecord(0, 'b.txt'), endRecord(0, 1)], /more files than it declares/],
    ['a mismatched end record', [...validLines().slice(0, 4), endRecord(1, 1)], /end record does not match/],
    ['fewer records than declared', [...validLines().slice(0, 4), endRecord(2, 2)], /end record does not match|does not contain the number of items/],
    ['a traversal name', [headerLine({ counts: { folders: 0, files: 1 } }), fileRecord(0, '..'), endRecord(0, 1)], /not a real file name/],
    ['a name with a separator', [headerLine({ counts: { folders: 0, files: 1 } }), fileRecord(0, 'a/b.txt'), endRecord(0, 1)], /unsupported character/],
    ['a name with a colon', [headerLine({ counts: { folders: 0, files: 1 } }), fileRecord(0, 'a:b.txt'), endRecord(0, 1)], /unsupported character/],
    ['an overlong name', [headerLine({ counts: { folders: 0, files: 1 } }), fileRecord(0, 'x'.repeat(256)), endRecord(0, 1)], /name is too long/],
    ['a negative size', [headerLine({ counts: { folders: 0, files: 1 } }), fileRecord(0, 'a.txt', { size: -1 }), endRecord(0, 1)], /invalid file size/],
    ['a fractional size', [headerLine({ counts: { folders: 0, files: 1 } }), fileRecord(0, 'a.txt', { size: 1.5 }), endRecord(0, 1)], /invalid file size/],
    ['an unsafe size', [headerLine({ counts: { folders: 0, files: 1 } }), fileRecord(0, 'a.txt', { size: 2 ** 53 }), endRecord(0, 1)], /invalid file size/],
    ['an invalid date', [headerLine({ counts: { folders: 0, files: 1 } }), fileRecord(0, 'a.txt', { modified: 'yesterday' }), endRecord(0, 1)], /invalid modification date/],
    ['a zero hard-link count', [headerLine({ counts: { folders: 0, files: 1 } }), fileRecord(0, 'a.txt', { links: 0 }), endRecord(0, 1)], /invalid hard-link count/],
    ['a non-boolean owner flag', [headerLine({ counts: { folders: 0, files: 1 } }), fileRecord(0, 'a.txt', { owner: 'yes' }), endRecord(0, 1)], /invalid size-owner flag/],
    ['a relative root', [headerLine({ root: 'Scan' })], /local drive path/],
    ['a network root', [headerLine({ root: '\\\\server\\share' })], /local drive path/],
    ['a device root', [headerLine({ root: '\\\\?\\C:\\Scan' })], /local drive path/],
    ['a relative root segment', [headerLine({ root: 'C:\\Scan\\..\\Windows' })], /relative segment/],
    ['an invalid capture date', [headerLine({ savedAt: 'not a date' })], /invalid capture date/],
    ['negative timing metadata', [headerLine({ scanDurationMs: -5 })], /invalid timing metadata/],
    ['invalid coverage counters', [headerLine({ counters: { skippedCount: -1, filteredCount: 0, reparsePointCount: 0, excludedFolderCount: 0 } })], /invalid coverage counters/],
    ['too many filters', [headerLine({ scanFilters: { excludeFolderNames: Array.from({ length: 300 }, (_, index) => `f${index}`) } })], /too many filters/],
    ['an oversized line', [headerLine(), `{"type":"folder","parent":0,"name":"${'x'.repeat(5000)}"}`, endRecord(0, 0)], /oversized line/]
  ];
  for (const [label, lines, expected] of cases) {
    const target = await writeArchive(t, lines);
    await assert.rejects(readScanArchive(target), expected, label);
  }
});

// More than the cooperative yield/progress interval, so cancellation and write
// failures can be exercised deterministically.
async function largeScan(count = 12000) {
  const root = { folderId: 0, path: 'C:\\Many', children: [] };
  const folderNodes = [root];
  const fileNodes = [];
  for (let index = 0; index < count; index++) {
    const file = {
      name: `file-${index}.txt`, path: `C:\\Many\\file-${index}.txt`, parentFolderId: 0, type: TYPE,
      rawSize: index, aggregateSize: index, size: formatFileSize(index), date: null,
      isOld: false, extension: 'txt', hardLinkCount: 1, sizeOwner: true
    };
    root.children.push(file);
    fileNodes.push(file);
  }
  const scan = await finalizeScan({
    root, folderNodes, fileNodes, folderPath: 'C:\\Many', scanFilters: {},
    scanTimestamp: Date.now(), skippedCount: 0, reparsePointCount: 0, excludedFolderCount: 0,
    summary: null
  });
  scan.scanDurationMs = 10;
  scan.entriesPerSecond = 1;
  return scan;
}

test('a failed or cancelled import never publishes a partial scan', async t => {
  const folder = await fixtureRoot(t);
  const target = path.join(folder, 'cancel.diskoryxscan');
  const large = await largeScan();
  await saveScanArchive(large, target);

  const midpoint = new AbortController();
  let progressEvents = 0;
  await assert.rejects(readScanArchive(target, {
    signal: midpoint.signal,
    onProgress() {
      if (++progressEvents === 1) midpoint.abort();
    }
  }), error => error.name === 'AbortError' || /cancelled/i.test(error.message));
  assert.equal(progressEvents, 1);

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(readScanArchive(target, { signal: alreadyAborted.signal }));
});

test('saving keeps an existing file intact until the complete archive is written', async t => {
  const folder = await fixtureRoot(t);
  const target = path.join(folder, 'existing.diskoryxscan');
  await fs.writeFile(target, 'previous archive content');
  const scan = await largeScan();

  await assert.rejects(saveScanArchive(scan, target, {
    onProgress() { throw new Error('simulated disk failure'); }
  }), /simulated disk failure/);
  const entries = await fs.readdir(folder);
  assert.deepEqual(entries, ['existing.diskoryxscan']);
  assert.equal(await fs.readFile(target, 'utf8'), 'previous archive content');

  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(saveScanArchive(scan, target, { signal: cancelled.signal }));
  assert.equal(await fs.readFile(target, 'utf8'), 'previous archive content');
  assert.deepEqual(await fs.readdir(folder), ['existing.diskoryxscan']);
});

test('the archive extension and entry names are enforced consistently', async t => {
  assert.equal(archivePathFor('C:\\scan'), 'C:\\scan.diskoryxscan');
  assert.equal(archivePathFor('C:\\scan.DISKORYXSCAN'), 'C:\\scan.DISKORYXSCAN');
  for (const name of ['a.txt', 'résumé 😀.log', 'trailing space ', '.hidden', 'name.with.dots.']) {
    assert.equal(validateEntryName(name), name);
  }
  for (const [name, expected] of [
    ['', /empty name/], [null, /empty name/], [7, /empty name/],
    ['.', /not a real file name/], ['..', /not a real file name/],
    ['a/b', /unsupported character/], ['a\\b', /unsupported character/], ['a:b', /unsupported character/],
    ['a\u0000b', /unsupported character/], ['x'.repeat(256), /too long/]
  ]) {
    assert.throws(() => validateEntryName(name), expected, String(name));
  }

  const folder = await fixtureRoot(t);
  const scan = await syntheticScan();
  const saved = await saveScanArchive(scan, path.join(folder, 'no-extension'));
  assert.equal(path.basename(saved.filePath), 'no-extension.diskoryxscan');
  assert.equal((await readScanArchive(saved.filePath)).fileCount, scan.fileCount);

  scan.fileNodes[0].rawSize = -1;
  await assert.rejects(saveScanArchive(scan, path.join(folder, 'bad.diskoryxscan')), /valid byte count/);
});
