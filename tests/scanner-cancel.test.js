const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { scanFolder } = require('../src/main/scanner');
const { createTreeBuilder } = require('../src/main/mft-scanner');

const root = path.join(__dirname, '..', 'src', 'main');
const rootRequire = createRequire(path.join(root, 'scanner.js'));
const tick = () => new Promise(resolve => setImmediate(resolve));

test('standard scanner cancels real traversal, suppresses further progress and can scan again', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'diskoryx-scan-cancel-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  await Promise.all(Array.from({ length: 300 }, (_, i) => fs.writeFile(path.join(folder, `${i}.txt`), 'test')));
  const controller = new AbortController();
  let updates = 0;
  await assert.rejects(scanFolder(folder, () => {
    updates++;
    controller.abort();
  }, {}, controller.signal), { name: 'AbortError' });
  assert.equal(updates, 1);
  const result = await scanFolder(folder);
  assert.equal(result.success, true);
  assert.equal(result.fileCount, 300);
  assert.equal(result.totalSizeBytes, 1200);
  assert.equal(result.folderNodes[0].fileCount, 300);
  assert.equal(result.largestFiles.length, 100);
  await assert.rejects(scanFolder(folder, undefined, {}, controller.signal), { name: 'AbortError' });
});

test('standard cancellation waits for issued filesystem calls and stops scheduling new ones', async () => {
  const controller = new AbortController();
  const releases = [];
  let fileStatsStarted = 0;
  let fileStatsFinished = 0;
  const mockFs = {
    stat(target) {
      if (target === path.resolve('C:\\test')) return Promise.resolve({ isDirectory: () => true });
      fileStatsStarted++;
      return new Promise(resolve => releases.push(() => {
        fileStatsFinished++;
        resolve({ size: 1, mtime: new Date() });
      }));
    },
    async readdir() {
      return Array.from({ length: 100 }, (_, index) => ({
        name: `${index}.txt`, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false
      }));
    }
  };
  const context = {
    module: { exports: {} }, console, setImmediate,
    require: name => name === 'node:fs/promises' ? mockFs : rootRequire(name)
  };
  vm.runInNewContext(fsSync.readFileSync(path.join(root, 'scanner.js'), 'utf8'), context);
  let settled = false;
  const running = context.module.exports.scanFolder('C:\\test', undefined, {}, controller.signal);
  const checked = assert.rejects(running, { name: 'AbortError' }).then(() => { settled = true; });
  await tick();
  assert.equal(fileStatsStarted, 32);
  controller.abort();
  await tick();
  assert.equal(settled, false, 'lock must remain held while filesystem calls are pending');
  for (const release of releases) release();
  await checked;
  assert.equal(fileStatsStarted, 32);
  assert.equal(fileStatsFinished, 32);
});

test('MFT tree finalization preserves totals and is cancellable at event-loop yields', async () => {
  const tree = createTreeBuilder('C:\\', {});
  for (let i = 0; i < 5000; i++) tree.addRecord({
    path: `C:\\folder\\${i}.txt`, size: 2, isDirectory: false
  });
  const controller = new AbortController();
  const finishing = tree.finish({}, 10, controller.signal);
  controller.abort();
  await assert.rejects(finishing, { name: 'AbortError' });
  const result = await tree.finish({}, 10);
  assert.equal(result.fileCount, 5000);
  assert.equal(result.folderCount, 1);
  assert.equal(result.totalSizeBytes, 10000);
  assert.equal(result.folderNodes[0].fileCount, 5000);
  assert.equal(result.largestFiles.length, 100);
});

test('completed standard and MFT scans retain original accounting, filters and tree results', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'diskoryx-scan-parity-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  await fs.mkdir(path.join(folder, 'nested'));
  await fs.mkdir(path.join(folder, 'skip'));
  await fs.mkdir(path.join(folder, 'empty'));
  await fs.writeFile(path.join(folder, 'one.txt'), '1234');
  await fs.writeFile(path.join(folder, 'nested', 'two.json'), '{}');
  await fs.writeFile(path.join(folder, 'skip', 'ignored.txt'), 'ignored');
  const filters = { excludeFolderNames: ['skip'] };
  const originalStandard = require('./fixtures/baseline/scanner');
  const originalMft = require('./fixtures/baseline/mft-scanner');
  const current = await scanFolder(folder, undefined, filters, new AbortController().signal);
  const original = await originalStandard.scanFolder(folder, undefined, filters);
  for (const result of [current, original]) {
    delete result.scanDurationMs;
    delete result.entriesPerSecond;
  }
  assert.deepEqual(current, original);

  const builders = [createTreeBuilder('C:\\', filters), originalMft.createTreeBuilder('C:\\', filters)];
  const records = [
    { path: 'C:\\one.txt', size: 10, hardLinkCount: 2, sizeOwner: true },
    { path: 'C:\\nested\\alias.txt', size: 10, hardLinkCount: 2, sizeOwner: false },
    { path: 'C:\\nested\\two.json', size: 4 },
    { path: 'C:\\empty', isDirectory: true },
    { path: 'C:\\skip\\ignored.txt', size: 50 }
  ];
  for (const builder of builders) for (const record of records) builder.addRecord(record);
  const summary = { corruptRecords: 2, unresolvedPaths: 1 };
  const actualMft = await builders[0].finish(summary, 50, new AbortController().signal);
  const originalResult = await builders[1].finish(summary, 50);
  assert.deepEqual(actualMft, originalResult);
  assert.equal(actualMft.totalSizeBytes, 14);
});

test('MFT directory records reuse placeholders without changing IDs, casing, filters or hard-link accounting', async () => {
  const baseline = require('./fixtures/baseline/mft-scanner');
  const filters = { excludeFolderNames: ['skip'] };
  const records = [
    { path: 'C:\\Folder\\nested\\one.txt', size: 8 },
    { path: 'C:\\folder\\NESTED', isDirectory: true, fileAttributes: 0x400 },
    { path: 'C:\\FOLDER', isDirectory: true },
    { path: 'C:\\Folder\\nested\\alias.txt', size: 8, sizeOwner: false, hardLinkCount: 2 },
    { path: 'C:\\Folder\\nested', isDirectory: true },
    { path: 'C:\\Folder\\nested\\empty', isDirectory: true },
    { path: 'C:\\Folder\\skip', isDirectory: true },
    { path: 'C:\\Folder\\skip\\ignored.txt', size: 99 },
    { path: 'C:\\Folder\\other\\..\\nested', isDirectory: true }
  ];
  const current = createTreeBuilder('C:\\', filters);
  const original = baseline.createTreeBuilder('C:\\', filters);
  for (const record of records) { current.addRecord(record); original.addRecord(record); }
  assert.deepEqual(await current.finish({}, 1), await original.finish({}, 1));
});

test('MFT canonical-path fast import matches baseline for normalized, device, mixed-case and excluded paths', async () => {
  const baseline = require('./fixtures/baseline/mft-scanner');
  const records = [
    { path: 'C:\\file.txt', size: 1 },
    { path: 'C:\\folder\\deep\\one.txt', size: 2 },
    { path: 'C:/folder/deep/../two.txt', size: 3 },
    { path: 'C:\\folder\\\\deep\\.\\three.txt', size: 4 },
    { path: '\\\\.\\C:\\folder\\deep\\four.txt', size: 5 },
    { path: 'c:\\FOLDER\\deep', isDirectory: true },
    { path: 'C:\\folder\\', isDirectory: true },
    { path: 'C:\\folder\\skip\\one.txt', size: 99 },
    { path: 'C:\\folder\\skip', isDirectory: true },
    { path: 'D:\\outside.txt', size: 99 },
    { path: 'C:\\', isDirectory: true }
  ];
  for (let index = 0; index < 4000; index++) records.push({
    path: `C:\\folder\\deep\\group-${index % 131}\\file-${index}.txt`,
    size: index, sizeOwner: index % 11 !== 0, modifiedMs: 1600000000000
  });
  for (const root of ['C:\\', 'C:\\folder']) {
    for (const filters of [{}, { excludeFolderNames: ['skip'] }]) {
      const current = createTreeBuilder(root, filters);
      const original = baseline.createTreeBuilder(root, filters);
      for (const record of records) { current.addRecord(record); original.addRecord(record); }
      assert.deepEqual(await current.finish({}, 1), await original.finish({}, 1));
    }
  }
});
