const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { scanFolder } = require('../src/main/scanner');
const { saveScanArchive } = require('../src/main/scan-archive');

const mainRoot = path.join(__dirname, '..', 'src', 'main');
const rootRequire = createRequire(path.join(mainRoot, 'main.js'));

function loadMain(root, open) {
  const handlers = new Map();
  vm.runInNewContext(fs.readFileSync(path.join(mainRoot, 'main.js'), 'utf8'), {
    __dirname: mainRoot, process, setImmediate, setTimeout, clearTimeout, AbortController,
    console: { ...console, warn() {}, error() {} },
    require(name) {
      if (name === 'electron') {
        return {
          app: {
            isPackaged: false, getPath: () => root, getVersion: () => '1.0.2',
            setPath() {}, setAppUserModelId() {}, whenReady: () => ({ then() {} }), on() {}
          },
          BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
          ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
          Menu: { setApplicationMenu() {} },
          dialog: { showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => open.result },
          shell: { trashItem: async () => {}, showItemInFolder() {}, openPath: async () => '' },
          clipboard: { writeText() {} }
        };
      }
      if (name === './mft-scanner') {
        return { ...rootRequire(name), getMftScannerPath: () => null };
      }
      if (name === './live-updates') {
        return { createLiveMonitor: () => ({ start: () => false, stop() {} }) };
      }
      return rootRequire(name);
    }
  });
  const sender = new EventEmitter();
  sender.isDestroyed = () => false;
  sender.send = () => {};
  return { handlers, event: { sender } };
}

async function fixture(t, volumeId) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'diskoryx-compare-ipc-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 10 }));
  const scanned = path.join(root, 'scan');
  await fsp.mkdir(scanned, { recursive: true });
  await fsp.writeFile(path.join(scanned, 'kept.txt'), '1234');
  const scan = await scanFolder(scanned, undefined, {}, new AbortController().signal);
  scan.scanMode = 'standard';
  const archive = path.join(root, 'saved.diskoryxscan');
  await saveScanArchive(scan, archive, { appVersion: '1.0.2', volumeId: volumeId ?? (await fsp.stat(scanned)).dev });
  return { root, scanned, archive };
}

test('compare reports Added after a file is added, keeping the archive as Before', async t => {
  const f = await fixture(t);
  const open = { result: { canceled: false, filePaths: [f.archive] } };
  const main = loadMain(f.root, open);
  const opened = await main.handlers.get('open-scan-archive')(main.event, 1);
  assert.equal(opened.success, true, opened.error);

  await fsp.writeFile(path.join(f.scanned, 'new.txt'), 'abc');
  const result = await main.handlers.get('compare-with-current')(main.event);
  assert.equal(result.success, true, result.error);
  assert.equal(result.summary.counts.added, 1);
  assert.equal(result.summary.counts.removed, 0);
  assert.equal(result.summary.before.fileCount, 1);
  assert.equal(result.summary.after.fileCount, 2);

  const page = await main.handlers.get('compare-page')(main.event, 'added', { offset: 0, limit: 10 });
  assert.equal(page.success, true);
  assert.equal(page.totalCount, 1);
  assert.match(page.rows[0].path, /new\.txt$/);

  assert.equal(opened.readOnly, true, 'Before must remain the read-only saved scan');
});

test('compare is refused when the current location is on a different volume', async t => {
  const f = await fixture(t, 42);
  const open = { result: { canceled: false, filePaths: [f.archive] } };
  const main = loadMain(f.root, open);
  await main.handlers.get('open-scan-archive')(main.event, 1);
  // Archived identity 42 is not the real volume identity of this folder.
  const result = await main.handlers.get('compare-with-current')(main.event);
  assert.match(result.error, /different volume/);
  assert.equal(result.success, undefined);
});

test('compare without an open saved scan is refused', async t => {
  const f = await fixture(t);
  const main = loadMain(f.root, { result: { canceled: true } });
  const result = await main.handlers.get('compare-with-current')(main.event);
  assert.match(result.error, /Open a saved scan first/);
});
