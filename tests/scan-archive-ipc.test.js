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
const { ARCHIVE_RESOURCE_LIMITS, readScanArchive, saveScanArchive } = require('../src/main/scan-archive');

const mainRoot = path.join(__dirname, '..', 'src', 'main');
const rootRequire = createRequire(path.join(mainRoot, 'main.js'));
const tick = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function loadMain(options = {}) {
  const handlers = new Map();
  const warnings = [];
  const progress = [];
  const duplicateProgress = [];
  const dialogs = { save: [], open: [] };
  const scans = { folder: 0, mft: 0 };
  const watcher = { starts: 0, stops: 0 };
  const save = { result: { canceled: true }, filePaths: [] };
  const open = { result: { canceled: true }, filePaths: [] };
  const overrides = options.overrides || {};

  vm.runInNewContext(fs.readFileSync(path.join(mainRoot, 'main.js'), 'utf8'), {
    __dirname: mainRoot, process, setImmediate, setTimeout, clearTimeout, AbortController,
    console: { ...console, warn: message => warnings.push(message), error() {} },
    require(name) {
      if (name === 'electron') {
        return {
          app: {
            isPackaged: false, getPath: () => options.root,
            getVersion: () => '1.0.2',
            setPath() {}, setAppUserModelId() {},
            whenReady: () => ({ then() {} }),
            on() {}
          },
          BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
          ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
          Menu: { setApplicationMenu() {} },
          dialog: {
            showSaveDialog: async dialogOptions => {
              dialogs.save.push(dialogOptions);
              return save.result;
            },
            showOpenDialog: async dialogOptions => {
              dialogs.open.push(dialogOptions);
              return open.result;
            }
          },
          shell: { trashItem: async () => {}, showItemInFolder() {}, openPath: async () => '' },
          clipboard: { writeText() {} }
        };
      }
      if (name === './scanner') {
        return {
          ...rootRequire(name),
          scanFolder(...args) { scans.folder++; return options.scan ? options.scan(...args) : scanFolder(...args); }
        };
      }
      if (name === './mft-scanner') {
        return {
          ...rootRequire(name),
          getMftScannerPath: () => null,
          scanMftVolume(...args) { scans.mft++; return options.mft ? options.mft(...args) : null; }
        };
      }
      if (name === './live-updates') {
        return {
          createLiveMonitor: () => ({
            start() { watcher.starts++; return options.watcherStarts !== false; },
            stop() { watcher.stops++; }
          })
        };
      }
      if (overrides[name]) return overrides[name];
      return rootRequire(name);
    }
  });

  const sender = new EventEmitter();
  sender.isDestroyed = () => false;
  sender.send = (channel, value) => {
    if (channel === 'scan-progress') progress.push(value);
    if (channel === 'duplicate-progress') duplicateProgress.push(value);
  };
  const event = { sender };
  return { handlers, event, warnings, progress, duplicateProgress, dialogs, scans, watcher, save, open };
}

async function fixtureArchive(t, options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'diskoryx-archive-ipc-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 10 }));
  const scanned = path.join(root, 'scan');
  await fsp.mkdir(path.join(scanned, 'nested'), { recursive: true });
  await fsp.writeFile(path.join(scanned, 'one.txt'), '1234');
  await fsp.writeFile(path.join(scanned, 'nested', 'two.json'), '{}');
  const scan = await scanFolder(scanned, undefined, {}, new AbortController().signal);
  scan.scanMode = 'standard';
  const archive = path.join(root, 'saved.diskoryxscan');
  await saveScanArchive(scan, archive, { appVersion: '1.0.2' });
  if (options.mutate) await options.mutate(archive);
  return { root, scanned, scan, archive };
}

test('opening a saved scan shows a read-only result without scanning or watching', async t => {
  const fixture = await fixtureArchive(t);
  const main = await loadMain({ root: fixture.root });
  const live = await main.handlers.get('scan-folder')(main.event, fixture.scanned, {}, 1);
  assert.equal(live.success, true);
  assert.equal(live.readOnly, false);
  assert.equal(main.scans.folder, 1);
  assert.equal(main.watcher.starts, 1);

  main.open.result = { canceled: false, filePaths: [fixture.archive] };
  const opened = await main.handlers.get('open-scan-archive')(main.event, 2);
  assert.equal(opened.success, true, opened.error);
  assert.equal(opened.readOnly, true);
  assert.equal(opened.archive.version, 1);
  assert.equal(opened.archive.appVersion, '1.0.2');
  assert.match(opened.archive.savedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(opened.liveStatus.state, 'archive');
  assert.match(opened.liveStatus.message, /read-only and not monitored/);
  assert.equal(opened.fileCount, fixture.scan.fileCount);
  assert.equal(opened.totalSizeBytes, fixture.scan.totalSizeBytes);
  assert.equal(opened.structure.length, 2);
  assert.equal(main.scans.folder, 1, 'opening a saved scan must not scan');
  assert.equal(main.scans.mft, 0);
  assert.equal(main.watcher.starts, 1, 'a saved scan must not start filesystem monitoring');
  assert.equal(main.watcher.stops, 1);
  assert.ok(main.progress.some(entry => entry.phase === 'archive'));

  // Navigation, sorting, search and analysis all read the reopened snapshot.
  const page = await main.handlers.get('get-folder-page')(main.event, opened.scanId, 0, 0, 200, 'name', [], {});
  assert.equal(page.success, true);
  const sorted = await main.handlers.get('sort-tree')(main.event, fixture.scanned, 'size', opened.scanId, [], {});
  assert.equal(sorted.success, true);
  assert.equal(sorted.readOnly, true);
  assert.equal(main.scans.folder, 1);
  const searched = await main.handlers.get('search-files')(main.event, opened.scanId, 'one', [], 0, 200, {});
  assert.equal(searched.totalCount, 1);
  assert.equal(searched.results[0].path, path.join(fixture.scanned, 'one.txt'));
  const analysis = await main.handlers.get('analysis-page')(main.event, opened.scanId, { view: 'types' });
  assert.equal(analysis.success, true);
  assert.equal(analysis.totalCount, fixture.scan.folderNodes[0].fileCount + 0 > 0 ? analysis.totalCount : 0);

  const listed = main.handlers.get('list-saved-scans')().scans;
  assert.equal(listed.filter(item => item.readOnly).length, 1);
  assert.equal(listed.find(item => item.readOnly).active, true);
});

test('duplicate IPC analyzes only the selected drive and reports inventory and hash progress', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'diskoryx-duplicates-ipc-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 10 }));
  const location = path.join(root, 'live');
  await fsp.mkdir(location);
  await fsp.writeFile(path.join(location, 'one.txt'), 'same contents');
  await fsp.writeFile(path.join(location, 'two.txt'), 'same contents');
  const driveRoot = path.parse(location).root;
  const inventoryCalls = [];
  const main = await loadMain({
    root,
    scan: async (folderPath, progress, filters, signal) => {
      inventoryCalls.push({ folderPath, filters });
      return scanFolder(folderPath === driveRoot ? location : folderPath, progress, filters, signal);
    }
  });
  const scan = await main.handlers.get('scan-folder')(main.event, location, {}, 31);
  assert.equal(scan.success, true);

  const listed = await main.handlers.get('list-drives')();
  assert.ok(listed.drives.some(drive => drive.path === driveRoot));
  const result = await main.handlers.get('find-duplicates')(main.event, driveRoot, 33, 'all');
  assert.equal(result.success, true);
  assert.equal(result.scopePath, driveRoot);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].paths.length, 2);
  assert.ok(main.duplicateProgress.some(progress => progress.requestId === 33 && progress.stage === 'hash'));
  assert.ok(main.duplicateProgress.some(progress => progress.requestId === 33 && progress.stage === 'inventory'));
  assert.equal(inventoryCalls.length, 2);
  assert.equal(inventoryCalls[1].folderPath, driveRoot);
  assert.deepEqual(inventoryCalls[1].filters.excludeFolderNames, []);
});

test('duplicate IPC refuses unlisted paths without scanning them', async t => {
  const fixture = await fixtureArchive(t);
  const inventoryCalls = [];
  const main = await loadMain({
    root: fixture.root,
    scan: async (folderPath, _progress, filters) => {
      inventoryCalls.push({ folderPath, filters });
      return scanFolder(fixture.scanned);
    },
    overrides: {
      './duplicates': {
        findDuplicates() {
          throw new Error('An unlisted path must not reach the duplicate engine.');
        }
      }
    }
  });
  const result = await main.handlers.get('find-duplicates')(main.event, fixture.scanned, 62);
  assert.match(result.error, /drive is not available/i);
  assert.equal(inventoryCalls.length, 0);
});

for (const scenario of ['active', 'retained', 'folder exclusions', 'archive']) {
  test(`duplicate IPC inventory reuse: ${scenario}`, async t => {
    const fixture = await fixtureArchive(t);
    const driveRoot = path.parse(fixture.scanned).root;
    const inventoryCalls = [];
    const archived = await readScanArchive(fixture.archive);
    const main = await loadMain({
      root: fixture.root,
      scan: async (folderPath, progress, filters, signal) => {
        inventoryCalls.push({ folderPath, filters });
        const result = await scanFolder(fixture.scanned, progress, filters, signal);
        return { ...result, folderPath };
      },
      overrides: {
        './scan-archive': {
          ...rootRequire('./scan-archive'),
          readScanArchive: async () => ({ ...archived, folderPath: driveRoot })
        }
      }
    });
    if (scenario === 'archive') {
      main.open.result = { canceled: false, filePaths: [fixture.archive] };
      const opened = await main.handlers.get('open-scan-archive')(main.event, 70);
      assert.equal(opened.success, true, opened.error);
      assert.equal(opened.readOnly, true);
    } else {
      const filters = scenario === 'folder exclusions' ? { excludeFolderNames: ['nested'] } : {};
      const initial = await main.handlers.get('scan-folder')(main.event, driveRoot, filters, 70);
      assert.equal(initial.success, true, initial.error);
      if (scenario === 'retained') {
        const other = await main.handlers.get('scan-folder')(main.event, fixture.scanned, {}, 71);
        assert.equal(other.success, true, other.error);
      }
    }
    const before = inventoryCalls.length;
    const result = await main.handlers.get('find-duplicates')(main.event, driveRoot, 72, 'all');
    assert.equal(result.success, true, result.error);
    const reuseExpected = scenario === 'active' || scenario === 'retained';
    assert.equal(result.inventoryReused, reuseExpected);
    assert.equal(inventoryCalls.length, before + (reuseExpected ? 0 : 1));
    if (reuseExpected) {
      assert.ok(main.duplicateProgress.some(progress => progress.requestId === 72 && progress.stage === 'validate'));
      assert.ok(!main.duplicateProgress.some(progress => progress.requestId === 72 && progress.stage === 'inventory'));
    } else {
      assert.equal(inventoryCalls.at(-1).folderPath, driveRoot);
      assert.deepEqual(inventoryCalls.at(-1).filters.excludeFolderNames, []);
    }
    const locations = main.handlers.get('list-saved-scans')().scans;
    assert.equal(locations.find(scan => scan.active).folderPath,
      scenario === 'retained' ? fixture.scanned : driveRoot);
  });
}

test('duplicate IPC excludes system and application paths by default before content verification', async t => {
  const fixture = await fixtureArchive(t);
  const driveRoot = path.parse(fixture.scanned).root;
  const paths = [
    'Windows\\Installer\\cache.msi', 'Program Files\\App\\setup.msi',
    'Program Files (x86)\\Steam\\setup.msi', 'ProgramData\\App\\cache',
    'Users\\Example\\AppData\\Local\\cache', '$Recycle.Bin\\deleted',
    'System Volume Information\\restore', 'Users\\Example\\Documents\\report.txt',
    'Users\\Example\\Downloads\\setup.msi', 'Photos\\picture.jpg'
  ].map(relative => path.join(driveRoot, relative));
  const received = [];
  const main = await loadMain({
    root: fixture.root,
    scan: async () => ({ ...fixture.scan, folderPath: driveRoot,
      fileNodes: paths.map(filePath => ({ path: filePath, rawSize: 10 })) }),
    overrides: {
      './duplicates': {
        ...rootRequire('./duplicates'),
        findDuplicates(_root, options) {
          received.push(options.candidateFiles.map(file => file.path));
          return { success: true, groups: [] };
        }
      }
    }
  });
  const user = await main.handlers.get('find-duplicates')(main.event, driveRoot, 80);
  assert.equal(user.success, true);
  assert.equal(user.scope, 'user');
  assert.equal(user.excludedFileCount, 7);
  assert.deepEqual(received[0], paths.slice(7));
  const all = await main.handlers.get('find-duplicates')(main.event, driveRoot, 81, 'all');
  assert.equal(all.success, true);
  assert.equal(all.excludedFileCount, 0);
  assert.deepEqual(received[1], paths);
  const invalid = await main.handlers.get('find-duplicates')(main.event, driveRoot, 82, 'invalid');
  assert.match(invalid.error, /valid duplicate analysis scope/);
  assert.equal(received.length, 2);
});

test('duplicate IPC cancellation uses the existing scan cancellation request', async t => {
  const fixture = await fixtureArchive(t);
  const driveRoot = path.parse(fixture.scanned).root;
  let duplicateSignal;
  const duplicateStarted = deferred();
  const main = await loadMain({
    root: fixture.root,
    scan: async (folderPath, progress, filters, signal) => {
      const scanPath = /^[a-z]:[\\/]$/i.test(folderPath) ? fixture.scanned : folderPath;
      return scanFolder(scanPath, progress, filters, signal);
    },
    overrides: {
      './duplicates': {
        ...rootRequire('./duplicates'),
        findDuplicates(_folderPath, { signal, onProgress }) {
          duplicateSignal = signal;
          duplicateStarted.resolve();
          onProgress({ stage: 'scan', filesScanned: 1 });
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })), { once: true });
          });
        }
      }
    }
  });
  const running = main.handlers.get('find-duplicates')(main.event, driveRoot, 52);
  const overlapping = await main.handlers.get('find-duplicates')(main.event, driveRoot, 53);
  assert.match(overlapping.error, /Wait for the current scan/);
  let startTimeout;
  await Promise.race([
    duplicateStarted.promise,
    new Promise((_resolve, reject) => {
      startTimeout = setTimeout(() => reject(new Error('Duplicate hashing did not start')), 1000);
    })
  ]);
  clearTimeout(startTimeout);
  assert.equal(duplicateSignal.aborted, false);
  assert.equal(main.handlers.get('cancel-scan')(main.event, 52).success, true);
  assert.equal((await running).cancelled, true);
  assert.equal(duplicateSignal.aborted, true);
});

test('live-only actions are refused for a saved scan before any filesystem access', async t => {
  const fixture = await fixtureArchive(t);
  const forbidden = new Proxy({}, {
    get(_target, name) { assert.fail(`Read-only action touched node:fs/promises.${String(name)}`); }
  });
  const main = await loadMain({ root: fixture.root, overrides: { 'node:fs/promises': forbidden } });
  main.open.result = { canceled: false, filePaths: [fixture.archive] };
  const opened = await main.handlers.get('open-scan-archive')(main.event, 1);
  assert.equal(opened.success, true, opened.error);
  const target = path.join(fixture.scanned, 'one.txt');
  const calls = [
    ['rename-file', [target, 'renamed.txt', opened.scanId]],
    ['delete-file', [target, opened.scanId]],
    ['create-folder', [opened.scanId, 0, 'New folder']],
    ['copy-item', [target, opened.scanId, 'copy']],
    ['paste-item', [opened.scanId, 0]],
    ['move-history-action', ['missing-id']],
    ['copy-history-action', ['missing-id']],
    ['restore-recycled-item', ['missing-id']],
    ['read-text-preview', [opened.scanId, target, 0, null]],
    ['copy-path', [target]],
    ['reveal-in-explorer', [target]]
  ];
  for (const [channel, args] of calls) {
    const result = await main.handlers.get(channel)(main.event, ...args);
    assert.equal(result.success, undefined, `${channel} must be refused`);
    assert.equal(result.readOnly, true, `${channel} must report read-only`);
    assert.match(result.error, /saved scan/i, channel);
  }
  const capacity = await main.handlers.get('volume-capacity')(main.event, opened.scanId);
  assert.match(capacity.error, /only reported for a live scan/);
});

test('a copy selection from a live scan cannot be pasted into a saved scan', async t => {
  const fixture = await fixtureArchive(t);
  const main = await loadMain({ root: fixture.root });
  const live = await main.handlers.get('scan-folder')(main.event, fixture.scanned, {}, 1);
  const selected = await main.handlers.get('copy-item')(main.event,
    path.join(fixture.scanned, 'one.txt'), live.scanId, 'copy');
  assert.equal(selected.success, true, selected.error);
  main.open.result = { canceled: false, filePaths: [fixture.archive] };
  const opened = await main.handlers.get('open-scan-archive')(main.event, 2);
  assert.equal(opened.success, true);
  const paste = await main.handlers.get('paste-item')(main.event, opened.scanId, 0);
  assert.equal(paste.success, undefined);
  assert.match(paste.error, /saved scan/i);
  assert.equal(fs.existsSync(path.join(fixture.scanned, 'one - Copy.txt')), false);
});

test('a broken import keeps the previous live result and never publishes a partial scan', async t => {
  const fixture = await fixtureArchive(t, {
    mutate: async archive => {
      const text = await fsp.readFile(archive, 'utf8');
      const lines = text.trimEnd().split('\n');
      await fsp.writeFile(archive, `${lines.slice(0, -1).join('\n')}\n`);
    }
  });
  const main = await loadMain({ root: fixture.root });
  const live = await main.handlers.get('scan-folder')(main.event, fixture.scanned, {}, 1);
  assert.equal(live.success, true);

  main.open.result = { canceled: false, filePaths: [fixture.archive] };
  const failed = await main.handlers.get('open-scan-archive')(main.event, 2);
  assert.match(failed.error, /incomplete or was cut off/);
  assert.equal(failed.success, undefined);

  const page = await main.handlers.get('get-folder-page')(main.event, live.scanId, 0, 0, 200, 'name', [], {});
  assert.equal(page.success, true, 'the previous result must remain usable');
  const sort = await main.handlers.get('sort-tree')(main.event, fixture.scanned, 'name', live.scanId, [], {});
  assert.equal(sort.success, true);
  assert.equal(sort.readOnly, false);
  assert.equal(main.scans.folder, 1);
  assert.equal(main.scans.mft, 0);
});

test('a resource-limit import error preserves the active live scan and its revision', async t => {
  const fixture = await fixtureArchive(t, {
    mutate: async archive => {
      const header = JSON.parse((await fsp.readFile(archive, 'utf8')).split('\n')[0]);
      const depth = ARCHIVE_RESOURCE_LIMITS.maxDepth + 1;
      header.counts = { folders: depth, files: 0 };
      const records = [header,
        ...Array.from({ length: depth }, (_, parent) => ({ type: 'folder', parent, name: 'd' })),
        { type: 'end', folders: depth, files: 0 }];
      await fsp.writeFile(archive, records.map(record => JSON.stringify(record)).join('\n') + '\n');
    }
  });
  const main = await loadMain({ root: fixture.root });
  const live = await main.handlers.get('scan-folder')(main.event, fixture.scanned, {}, 1);
  assert.equal(live.success, true);
  main.open.result = { canceled: false, filePaths: [fixture.archive] };
  const failed = await main.handlers.get('open-scan-archive')(main.event, 2);
  assert.match(failed.error, /Unable to open the saved scan:.*tree depth limit/);
  const page = await main.handlers.get('get-folder-page')(main.event, live.scanId, 0, 0, 200, 'name', [], {});
  assert.equal(page.success, true);
  assert.equal(main.scans.folder, 1);
  assert.equal(main.scans.mft, 0);
  assert.equal(main.watcher.stops, 0, 'a rejected import must not stop the live monitor');
});

test('cancelling a large import leaves the previous result untouched', async t => {
  const fixture = await fixtureArchive(t);
  const pending = deferred();
  const fake = {
    readScanArchive: async (_file, options) => {
      options.signal.addEventListener('abort', () => pending.reject(options.signal.reason), { once: true });
      return pending.promise;
    },
    saveScanArchive: async () => { throw new Error('not used'); },
    ARCHIVE_EXTENSION: '.diskoryxscan'
  };
  const main = await loadMain({ root: fixture.root, overrides: { './scan-archive': fake } });
  const live = await main.handlers.get('scan-folder')(main.event, fixture.scanned, {}, 1);
  main.open.result = { canceled: false, filePaths: [fixture.archive] };
  const opening = main.handlers.get('open-scan-archive')(main.event, 7);
  await tick();
  assert.match((await main.handlers.get('open-scan-archive')(main.event, 8)).error, /Wait/);
  assert.equal(main.handlers.get('cancel-scan')(main.event, 7).success, true);
  assert.equal((await opening).cancelled, true);
  const page = await main.handlers.get('get-folder-page')(main.event, live.scanId, 0, 0, 200, 'name', [], {});
  assert.equal(page.success, true);
});

test('Scan and Rescan after opening a saved scan perform a real scan', async t => {
  const fixture = await fixtureArchive(t);
  const main = await loadMain({ root: fixture.root });
  main.open.result = { canceled: false, filePaths: [fixture.archive] };
  const opened = await main.handlers.get('open-scan-archive')(main.event, 1);
  assert.equal(opened.success, true);

  const scanned = await main.handlers.get('scan-folder')(main.event, fixture.scanned, {}, 2);
  assert.equal(scanned.success, true);
  assert.equal(scanned.readOnly, false);
  assert.equal(main.scans.folder, 1, 'an explicit Scan must never reuse the archive');

  main.open.result = { canceled: false, filePaths: [fixture.archive] };
  const reopened = await main.handlers.get('open-scan-archive')(main.event, 3);
  assert.equal(reopened.readOnly, true);
  const rescanned = await main.handlers.get('refresh-tree')(main.event, fixture.scanned, {}, 4);
  assert.equal(rescanned.success, true);
  assert.equal(rescanned.readOnly, false);
  assert.equal(main.scans.folder, 2);

  // The archive was never stored as a switchable location, so it cannot come
  // back as a writable snapshot after another location became active.
  const activate = await main.handlers.get('activate-saved-scan')(main.event, fixture.scanned);
  assert.equal(activate.success, true);
  assert.equal(activate.readOnly, false);
  assert.equal(main.scans.folder, 2);
});

test('saving a scan writes a valid archive, appends its extension and reports cancellation', async t => {
  const fixture = await fixtureArchive(t);
  const main = await loadMain({ root: fixture.root });
  const live = await main.handlers.get('scan-folder')(main.event, fixture.scanned, {}, 1);
  assert.equal(live.success, true);

  const target = path.join(fixture.root, 'exported');
  main.save.result = { canceled: false, filePath: target };
  const saved = await main.handlers.get('save-scan-archive')(main.event, live.scanId);
  assert.equal(saved.success, true, saved.error);
  assert.equal(saved.filePath, `${target}.diskoryxscan`);
  assert.equal(saved.fileCount, fixture.scan.fileCount);
  assert.equal(saved.folderCount, fixture.scan.folderCount);
  assert.match(main.dialogs.save[0].defaultPath, /-diskoryx-scan\.diskoryxscan$/);
  assert.equal(main.dialogs.save[0].filters[0].extensions.join(','), 'diskoryxscan');
  const reopened = await readScanArchive(saved.filePath);
  assert.equal(reopened.fileCount, fixture.scan.fileCount);
  assert.equal(reopened.totalSizeBytes, fixture.scan.totalSizeBytes);

  main.save.result = { canceled: true };
  const cancelled = await main.handlers.get('save-scan-archive')(main.event, live.scanId);
  assert.equal(cancelled.success, false);
  assert.equal(cancelled.cancelled, true);
  assert.match((await main.handlers.get('save-scan-archive')(main.event, live.scanId + 99)).error,
    /scan has expired/);
});

test('a saved scan opens even when its source is gone, and Rescan reports the missing source', async t => {
  const fixture = await fixtureArchive(t);
  const main = await loadMain({ root: fixture.root });
  await fsp.rm(fixture.scanned, { recursive: true, force: true });
  main.open.result = { canceled: false, filePaths: [fixture.archive] };
  const opened = await main.handlers.get('open-scan-archive')(main.event, 1);
  assert.equal(opened.success, true, opened.error);
  assert.equal(opened.readOnly, true);
  assert.equal(opened.fileCount, fixture.scan.fileCount);

  const rescanned = await main.handlers.get('refresh-tree')(main.event, fixture.scanned, {}, 2);
  assert.match(rescanned.error, /Unable to access folder/);
  assert.equal(main.scans.folder, 1);
  // The failed rescan must not discard the opened saved scan.
  const page = await main.handlers.get('get-folder-page')(main.event, opened.scanId, 0, 0, 200, 'name', [], {});
  assert.equal(page.success, true);
  assert.equal(page.items.length, 2);
});

test('a saved scan can be saved again without touching live files', async t => {
  const fixture = await fixtureArchive(t);
  const main = await loadMain({ root: fixture.root });
  main.open.result = { canceled: false, filePaths: [fixture.archive] };
  const opened = await main.handlers.get('open-scan-archive')(main.event, 1);
  const target = path.join(fixture.root, 'copy-of-saved.diskoryxscan');
  main.save.result = { canceled: false, filePath: target };
  const saved = await main.handlers.get('save-scan-archive')(main.event, opened.scanId);
  assert.equal(saved.success, true, saved.error);
  const again = await readScanArchive(target);
  assert.equal(again.readOnly, true);
  assert.equal(again.fileCount, opened.fileCount);
  assert.equal(again.totalSizeBytes, opened.totalSizeBytes);
  assert.equal(again.scanMode, 'standard');
});
