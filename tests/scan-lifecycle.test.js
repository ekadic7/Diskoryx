const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

const root = path.join(__dirname, '..', 'src', 'main');
const rootRequire = createRequire(path.join(root, 'main.js'));
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function scanResult(folderPath) {
  const folder = {
    folderId: 0, path: folderPath, children: [], rawSize: 0,
    extensionStats: {}, fileCount: 0, folderCount: 0
  };
  return {
    success: true, folderPath: path.resolve(folderPath), folderNodes: [folder],
    fileNodes: [], largestFiles: [], fileCount: 0, folderCount: 0,
    totalSizeBytes: 0, scanFilters: {}, scanDurationMs: 10, entriesPerSecond: 0
  };
}

function loadMain(scanFolder, scanMftVolume = async () => null, overrides = {}) {
  const handlers = new Map();
  const appEvents = new Map();
  const warnings = [];
  let live;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), {
    __dirname: root, process, setImmediate, setTimeout, clearTimeout, AbortController,
    console: { ...console, warn: message => warnings.push(message), error() {} },
    require(name) {
      if (name === 'electron') return {
        app: {
          isPackaged: false, getPath: () => root, setPath() {},
          setAppUserModelId() {},
          whenReady: () => ({ then() {} }), on: (name, fn) => appEvents.set(name, fn)
        },
        ipcMain: { handle: (name, fn) => handlers.set(name, fn) }
      };
      if (name === './scanner') return { ...rootRequire(name), scanFolder };
      if (name === './live-updates') return {
        createLiveMonitor: options => {
          live = options;
          return { start: () => true, stop() {} };
        }
      };
      if (name === './mft-scanner') return {
        ...rootRequire(name), scanMftVolume, getMftScannerPath: () => 'local-helper.exe'
      };
      return overrides[name] || rootRequire(name);
    }
  });
  const progress = [];
  const sender = new EventEmitter();
  sender.isDestroyed = () => false;
  sender.send = (channel, value) => { if (channel === 'scan-progress') progress.push({ channel, ...value }); };
  const event = { sender };
  return { handlers, appEvents, event, progress, warnings, live };
}

test('paused live monitoring preserves navigation, analysis and guarded file actions on the saved snapshot', async () => {
  let scans = 0;
  const main = loadMain(async folder => { scans++; return scanResult(folder); });
  const view = await main.handlers.get('scan-folder')(main.event, 'C:\\fixture', {}, 1);
  main.live.onStale('A changed hard link requires Rescan.');
  const page = await main.handlers.get('get-folder-page')(main.event, view.scanId, 0, 0, 200, 'name', [], {});
  assert.equal(page.success, true);
  const sorted = await main.handlers.get('sort-tree')(main.event, 'C:\\fixture', 'size', view.scanId, [], {});
  assert.equal(sorted.success, true);
  assert.equal(sorted.scanId, view.scanId);
  assert.equal(sorted.liveStatus.state, 'stale');
  assert.match(sorted.liveStatus.message, /last saved snapshot/);
  const analysis = await main.handlers.get('analysis-page')(main.event, view.scanId, { view: 'largest' });
  assert.equal(analysis.success, true);
  const action = await main.handlers.get('rename-file')(main.event, 'C:\\fixture\\missing.txt', 'new.txt', view.scanId);
  assert.doesNotMatch(action.error, /scan has expired/);
  assert.equal(scans, 1, 'pausing or browsing must never launch a hidden scan');
});

test('Recycle Bin restore is registered at startup before any copy or Undo action', () => {
  const main = loadMain(async folder => scanResult(folder));
  assert.equal(typeof main.handlers.get('restore-recycled-item'), 'function');
});

test('saved locations switch without scanning and reject old revisions while retaining each complete result', async () => {
  let calls = 0;
  const main = loadMain(async folder => { calls++; return scanResult(folder); });
  const scan = main.handlers.get('scan-folder');
  const first = await scan(main.event, 'C:\\first', { includeExtensions: ['.txt'] }, 1);
  await main.handlers.get('sort-tree')(main.event, 'C:\\first', 'date', first.scanId, [], { includeExtensions: ['.txt'] });
  const second = await scan(main.event, 'D:\\second', {}, 2);
  const list = main.handlers.get('list-saved-scans');
  assert.equal(list().scans.length, 2);
  assert.equal(list().scans.find(item => item.active).folderPath, 'D:\\second');
  const activate = main.handlers.get('activate-saved-scan');
  const returned = await activate(main.event, 'c:\\FIRST');
  assert.equal(returned.success, true);
  assert.equal(returned.folderPath, 'C:\\first');
  assert.equal(returned.sortType, 'date');
  assert.equal(returned.scanFilters.includeExtensions.join(','), '.txt');
  assert.ok(returned.scanId > second.scanId);
  assert.equal(returned.liveStatus.state, 'stale');
  assert.match(returned.liveStatus.message, /not monitored/);
  const page = main.handlers.get('get-folder-page');
  assert.match((await page(main.event, first.scanId, 0, 0, 200, 'name', [], {})).error, /expired/);
  assert.equal((await page(main.event, returned.scanId, 0, 0, 200, 'name', [], {})).success, true);
  const again = await activate(main.event, 'D:\\second');
  assert.equal(again.success, true);
  assert.ok(again.scanId > returned.scanId);
  assert.equal(list().scans.length, 2);
  assert.equal(calls, 2);
  assert.match((await activate(main.event, null)).error, /available saved/);
  assert.match((await activate(main.event, 'Z:\\missing')).error, /no longer available/);
  await main.handlers.get('refresh-tree')(main.event, 'D:\\second', {}, 3);
  assert.equal(list().scans.length, 2, 'rescanning replaces its snapshot, not the other location');
  assert.equal(calls, 3);
});

test('saved locations survive cancelled or failed scans and cannot switch during an active scan', async () => {
  const pending = deferred();
  const main = loadMain(async (folder, _progress, _filters, signal) => {
    if (folder === 'E:\\pending') {
      await pending.promise;
      signal.throwIfAborted();
    }
    if (folder === 'F:\\failed') throw new Error('drive unavailable');
    return scanResult(folder);
  });
  const scan = main.handlers.get('scan-folder');
  await scan(main.event, 'C:\\first', {}, 1);
  const second = await scan(main.event, 'D:\\second', {}, 2);
  const running = scan(main.event, 'E:\\pending', {}, 3);
  assert.match((await main.handlers.get('activate-saved-scan')(main.event, 'C:\\first')).error, /Wait/);
  assert.equal(main.handlers.get('cancel-scan')(main.event, 3).success, true);
  pending.resolve();
  assert.equal((await running).cancelled, true);
  assert.match((await scan(main.event, 'F:\\failed', {}, 4)).error, /drive unavailable/);
  const list = main.handlers.get('list-saved-scans')().scans;
  assert.equal(list.length, 2);
  assert.equal(list.find(item => item.active).folderPath, second.folderPath);
  assert.equal((await main.handlers.get('activate-saved-scan')(main.event, 'C:\\first')).success, true);
});

test('main admits one scan, matches cancellation owner/token and drains before allowing another', async () => {
  const pending = deferred();
  const started = deferred();
  let calls = 0;
  let signal;
  let report;
  const main = loadMain((_folder, progress, _filters, abortSignal) => {
    calls++;
    signal = abortSignal;
    report = progress;
    started.resolve();
    return pending.promise;
  });
  const scan = main.handlers.get('scan-folder');
  const refresh = main.handlers.get('refresh-tree');
  const cancel = main.handlers.get('cancel-scan');
  const first = scan(main.event, 'C:\\first', {}, 1);
  await started.promise;
  assert.equal(calls, 1);
  assert.match((await scan(main.event, 'C:\\second', {}, 2)).error, /already running/);
  assert.match((await refresh(main.event, 'C:\\second', {}, 2)).error, /already running/);
  report({ scannedEntries: 100 });
  assert.equal(main.progress[0].requestId, 1);
  assert.match(cancel({ sender: {} }, 1).error, /no longer/);
  assert.match(cancel(main.event, 2).error, /no longer/);
  assert.equal(signal.aborted, false);
  assert.equal(cancel(main.event, 1).success, true);
  assert.equal(signal.aborted, true);
  report({ scannedEntries: 200 });
  assert.equal(main.progress.length, 1);
  assert.match((await scan(main.event, 'C:\\second', {}, 2)).error, /already running/);
  pending.resolve(scanResult('C:\\first'));
  assert.equal((await first).cancelled, true);
  assert.equal(main.event.sender.listenerCount('destroyed'), 0);
  const next = await refresh(main.event, 'C:\\second', {}, 2);
  assert.equal(next.success, true);
  assert.equal(next.scanId, 1, 'cancelled scans must not publish partial results');
  assert.equal(calls, 2);
  assert.match(cancel(main.event, 1).error, /no longer/);
});

test('cancelled MFT scan never starts filesystem fallback and previous completed scan survives', async () => {
  const pending = deferred();
  const started = deferred();
  let standardCalls = 0;
  let mftCalls = 0;
  const main = loadMain(async folder => {
    standardCalls++;
    return scanResult(folder);
  }, (_folder, _progress, _filters, _packaged, signal) => {
    mftCalls++;
    signal.addEventListener('abort', () => pending.reject(signal.reason), { once: true });
    started.resolve();
    return pending.promise;
  });
  const scan = main.handlers.get('scan-folder');
  const previous = await scan(main.event, 'C:\\previous', {}, 1);
  assert.equal(previous.success, true);
  const inFlight = scan(main.event, 'C:\\', {}, 2);
  await started.promise;
  assert.equal(mftCalls, 1);
  main.handlers.get('cancel-scan')(main.event, 2);
  assert.equal((await inFlight).cancelled, true);
  assert.equal(standardCalls, 1);
  assert.equal(main.warnings.length, 0, 'cancellation is not a fallback failure');
  const restored = await scan(main.event, 'C:\\previous', {}, 3);
  assert.equal(restored.scanId, previous.scanId);
  assert.equal(standardCalls, 1, 'previous cache stays intact');
});

test('genuine MFT failure still falls back and subsequent scans recover from errors', async () => {
  let standardCalls = 0;
  const main = loadMain(async folder => {
    standardCalls++;
    if (standardCalls === 1) throw new Error('filesystem unavailable');
    return scanResult(folder);
  }, async () => { throw new Error('access denied'); });
  const scan = main.handlers.get('scan-folder');
  assert.match((await scan(main.event, 'C:\\', {}, 1)).error, /filesystem unavailable/);
  const result = await scan(main.event, 'C:\\', {}, 2);
  assert.equal(result.success, true);
  assert.equal(result.scanMode, 'standard');
  assert.equal(result.scanModeReason, 'MFT unavailable; filesystem traversal used.');
  assert.equal(standardCalls, 2);
  assert.equal(main.warnings.length, 2);
});

test('declined or unavailable administrator connection never launches a slow fallback scan', async () => {
  const main = loadMain(() => { assert.fail('must not silently traverse the disk after UAC refusal'); }, async () => {
    const error = new Error('UAC was declined');
    error.noFallback = true;
    throw error;
  });
  const result = await main.handlers.get('scan-folder')(main.event, 'C:\\', {}, 1);
  assert.match(result.error, /UAC was declined/);
  assert.equal(main.warnings.length, 0);
});

test('mode and reason follow actual scanner, progress and cached sorted views', async () => {
  const main = loadMain(async (folder, report) => {
    report({ scannedEntries: 1 });
    return scanResult(folder);
  }, async (folder, report) => {
    report({ scannedEntries: 2 });
    return scanResult(folder);
  });

  const scan = main.handlers.get('scan-folder');
  const standard = await scan(main.event, 'C:\\folder', {}, 1);
  assert.equal(standard.scanMode, 'standard');
  assert.match(standard.scanModeReason, /Folder scans/);
  assert.equal(main.progress.at(-1).scanMode, 'standard');
  const fast = await scan(main.event, 'C:\\', {}, 2);
  assert.equal(fast.scanMode, 'mft');
  assert.equal(fast.scanModeReason, '');
  assert.equal(main.progress.at(-1).scanMode, 'mft');
  const sorted = await main.handlers.get('sort-tree')(main.event, 'C:\\', 'size', fast.scanId, [], {});
  assert.equal(sorted.scanMode, 'mft');
  assert.equal(sorted.scanModeReason, '');
});

test('removed views are rejected while normal cached sorting remains available', async () => {
    let scans = 0;
    const main = loadMain(async folder => {
      scans++;
      const result = scanResult(folder);
      result.totalSizeBytes = 100;
      result.fileCount = 4;
      result.folderNodes[0].extensionStats = {
        txt: { fileCount: 2, totalSizeBytes: 75, oldFilesCount: 0 },
        log: { fileCount: 1, totalSizeBytes: 25, oldFilesCount: 0 },
        unknown: { fileCount: 1, totalSizeBytes: 0, oldFilesCount: 0 }
      };
      return result;
    });
    const scan = await main.handlers.get('scan-folder')(main.event, 'C:\\folder', {}, 1);
    const sorted = main.handlers.get('sort-tree');
    for (const mode of ['largest', 'types']) {
      assert.match((await sorted(main.event, 'C:\\folder', mode, scan.scanId, [], {})).error, /Unsupported sort/);
    }
    const filtered = await sorted(main.event, 'C:\\folder', 'size', scan.scanId, [], { includeExtensions: ['log'] });
    assert.equal(filtered.success, true);
    assert.equal(filtered.totalSizeBytes, 25);
    assert.equal(scans, 1);
});

test('closing the owning renderer or quitting cancels the scan', async () => {
  for (const closeOwner of [true, false]) {
    const main = loadMain((_folder, _progress, _filters, signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const running = main.handlers.get('scan-folder')(main.event, 'C:\\test', {}, 1);
    if (closeOwner) main.event.sender.emit('destroyed');
    else main.appEvents.get('before-quit')();
    assert.equal((await running).cancelled, true);
    assert.equal(main.event.sender.listenerCount('destroyed'), 0);
  }
});

test('file mutation IPC refuses requests without an active scan before filesystem access', async () => {
  const forbidden = new Proxy({}, {
    get(_target, name) { assert.fail(`File mutation touched ${String(name)}`); }
  });
  const main = loadMain(async folder => scanResult(folder), undefined, {
    'node:fs/promises': forbidden
  });
  for (const channel of ['rename-file', 'delete-file']) {
    for (const target of ['C:\\scan\\junction\\victim.txt', 'C:\\Windows\\victim.txt', null, {}]) {
      const result = await main.handlers.get(channel)(main.event, target, 'new.txt');
      assert.equal(result.success, undefined);
      assert.match(result.error, /scan has expired/);
    }
  }
});

test('stop during initial view preparation does not publish the new cache', async () => {
  const sorting = deferred();
  const sortingStarted = deferred();
  let calls = 0;
  const main = loadMain(async folder => {
    calls++;
    return scanResult(folder);
  }, undefined, {
    './tree-sort': { sortItemList: () => { sortingStarted.resolve(); return sorting.promise; } }
  });
  const running = main.handlers.get('scan-folder')(main.event, 'C:\\test', {}, 1);
  await sortingStarted.promise;
  assert.equal(main.handlers.get('cancel-scan')(main.event, 1).success, true);
  sorting.resolve([]);
  assert.equal((await running).cancelled, true);
  assert.equal((await main.handlers.get('scan-folder')(main.event, 'C:\\test', {}, 2)).success, true);
  assert.equal(calls, 2);
});
