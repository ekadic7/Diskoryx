const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { scanFolder } = require('../src/main/scanner');
const { saveScanArchive, readScanArchive } = require('../src/main/scan-archive');
const { EXIT, runCli, writeCsvAtomically } = require('../src/main/cli');

const mainRoot = path.join(__dirname, '..', 'src', 'main');
const rootRequire = createRequire(path.join(mainRoot, 'main.js'));

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(__dirname, 'review-fixture-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 10 }));
  const source = path.join(root, 'source');
  await fsp.mkdir(source);
  await fsp.writeFile(path.join(source, 'one.txt'), '1234');
  return { root, source };
}

function loadMain(root, overrides = {}) {
  const handlers = new Map();
  const progress = [];
  const updates = [];
  const save = { result: { canceled: true } };
  const open = { result: { canceled: true } };
  let live;
  vm.runInNewContext(fs.readFileSync(path.join(mainRoot, 'main.js'), 'utf8'), {
    __dirname: mainRoot, process, setImmediate, setTimeout, clearTimeout, AbortController,
    console: { ...console, warn() {}, error() {} },
    require(name) {
      if (name === 'electron') return {
        app: {
          isPackaged: false, getPath: () => root, getVersion: () => '1.0.3',
          setPath() {}, setAppUserModelId() {}, whenReady: () => ({ then() {} }), on() {}
        },
        BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
        ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
        dialog: { showSaveDialog: async () => save.result, showOpenDialog: async () => open.result }
      };
      if (name === './live-updates') return {
        createLiveMonitor(options) {
          live = options;
          return { start: () => true, stop() {} };
        }
      };
      if (name === './mft-scanner') return { ...rootRequire(name), getMftScannerPath: () => null };
      return overrides[name] || rootRequire(name);
    }
  });
  const sender = new EventEmitter();
  sender.isDestroyed = () => false;
  sender.send = (channel, value) => {
    if (channel === 'scan-progress') progress.push(value);
    if (channel === 'live-update') updates.push(value);
  };
  const event = { sender };
  return { handlers, event, save, open, live, progress, updates };
}

test('Copy final notifications reconcile independent source/destination edits without double counting', async t => {
  const { root, source } = await fixture(t);
  const destination = path.join(root, 'destination');
  await fsp.mkdir(destination);
  const externalSource = path.join(source, 'independent.txt');
  const copied = path.join(destination, 'source');
  const main = loadMain(root, {
    './windows-copy': {
      async copyWithHandles(request) {
        assert.equal(main.live.isBusy(), true, 'notifications wait while the action owns the snapshot');
        await fsp.cp(request.target, copied, { recursive: true });
        await fsp.writeFile(externalSource, 'source change');
        return { success: true, path: copied };
      }
    }
  });
  const scan = await main.handlers.get('scan-folder')(main.event, root, {}, 1);
  assert.equal(scan.success, true, scan.error);
  const selected = await main.handlers.get('copy-item')(main.event, source, scan.scanId);
  assert.equal(selected.success, true, selected.error);
  const destinationId = scan.structure.find(item => item.path === destination).folderId;
  const pasted = await main.handlers.get('paste-item')(main.event, scan.scanId, destinationId);
  assert.equal(pasted.success, true, pasted.error);
  assert.equal(pasted.refreshRequired, false);
  const copiedFile = path.join(copied, 'one.txt');
  const externalDestination = path.join(copied, 'independent.txt');
  await fsp.writeFile(copiedFile, 'destination resized after publication');
  await fsp.writeFile(externalDestination, 'destination change');
  const staging = path.join(destination, '.diskoryx-copy-owned-fixture');
  await fsp.mkdir(staging);
  await fsp.writeFile(path.join(staging, 'hidden.txt'), 'not published');
  const batch = [source, copied, externalSource, copiedFile, externalDestination, staging, path.join(staging, 'hidden.txt')];
  assert.equal(main.live.isBusy(), false);
  await main.live.onBatch([...batch], () => true);
  const revision = main.updates.at(-1).scanId;
  const refreshed = await main.handlers.get('sort-tree')(main.event, root, 'name', revision, [], {});
  assert.equal(refreshed.success, true, refreshed.error);
  assert.equal(refreshed.liveStatus.state, 'watching');
  assert.equal(refreshed.fileCount, 4);
  assert.equal(refreshed.totalSizeBytes, 4 + Buffer.byteLength('source change') +
    Buffer.byteLength('destination resized after publication') + Buffer.byteLength('destination change'));
  const search = await main.handlers.get('search-files')(main.event, revision, 'independent', [], 0, 200, {});
  assert.equal(search.totalCount, 2, 'both independent edits must be visible');
  const notifications = main.updates.length;
  await main.live.onBatch([...batch], () => true);
  assert.equal(main.updates.length, notifications, 'repeated final events must not count files twice or publish phantom revisions');
});

for (const [volumeId, available] of [[111, true], [111, false], [null, true]]) {
  test(`re-saving archive volume ${volumeId} preserves its identity when the live source is ${available ? 'replaced' : 'unavailable'}`, async t => {
    const { root, source } = await fixture(t);
    const original = path.join(root, 'original.diskoryxscan');
    await saveScanArchive(await scanFolder(source), original, { volumeId });
    let identityReads = 0;
    const main = loadMain(root, {
      'node:fs/promises': {
        ...fsp,
        async stat(target, ...args) {
          if (target === source) {
            identityReads++;
            if (!available) throw Object.assign(new Error('Source unavailable'), { code: 'ENOENT' });
            return { dev: 222 };
          }
          return fsp.stat(target, ...args);
        }
      }
    });
    main.open.result = { canceled: false, filePaths: [original] };
    const opened = await main.handlers.get('open-scan-archive')(main.event, 1);
    assert.equal(opened.success, true, opened.error);
    const saved = path.join(root, 'resaved.diskoryxscan');
    main.save.result = { canceled: false, filePath: saved };
    assert.equal((await main.handlers.get('save-scan-archive')(main.event, opened.scanId)).success, true);
    assert.equal((await readScanArchive(saved)).archive.volumeId, volumeId);
    assert.equal(identityReads, 0, 're-saving historical metadata must never look up the current volume');
    if (available && volumeId !== null) {
      const compared = await main.handlers.get('compare-with-current')(main.event, 2);
      assert.match(compared.error, /different volume/);
    }
  });
}

for (const available of [true, false]) {
  test(`live snapshot saves its scan-time identity when the source is later ${available ? 'replaced' : 'unavailable'}`, async t => {
    const { root, source } = await fixture(t);
    let dev = 111;
    let reads = 0;
    const main = loadMain(root, {
      'node:fs/promises': {
        ...fsp, async stat(target, ...args) {
          if (target === source) {
            reads++;
            if (dev === null) throw Object.assign(new Error('Source unavailable'), { code: 'ENOENT' });
            return { dev };
          }
          return fsp.stat(target, ...args);
        }
      }
    });
    const scanned = await main.handlers.get('scan-folder')(main.event, source, {}, 1);
    assert.equal(scanned.success, true, scanned.error);
    assert.equal(reads, 2, 'identity is checked at both scan boundaries');
    dev = available ? 222 : null;
    const saved = path.join(root, 'live.diskoryxscan');
    main.save.result = { canceled: false, filePath: saved };
    assert.equal((await main.handlers.get('save-scan-archive')(main.event, scanned.scanId)).success, true);
    assert.equal((await readScanArchive(saved)).archive.volumeId, 111);
    assert.equal(reads, 2, 'saving must not rebind the volume');
  });
}

test('a volume replaced during scanning is not published as a verified snapshot', async t => {
  const { root, source } = await fixture(t);
  let reads = 0;
  const main = loadMain(root, {
    'node:fs/promises': { ...fsp, stat: async () => ({ dev: ++reads === 1 ? 111 : 222 }) }
  });
  const result = await main.handlers.get('scan-folder')(main.event, source, {}, 1);
  assert.match(result.error, /volume changed during the scan/);
  assert.equal(main.handlers.get('list-saved-scans')().scans.length, 0);
});

test('Compare progress and Stop use the numeric request id and preserve the archive after cancellation', async t => {
  const { root, source } = await fixture(t);
  const archive = path.join(root, 'before.diskoryxscan');
  await saveScanArchive(await scanFolder(source), archive);
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const main = loadMain(root, {
    './scanner': {
      ...rootRequire('./scanner'),
      scanFolder(_root, report, _filters, signal) {
        report({ scannedEntries: 1, filteredCount: 0, skippedCount: 0 });
        entered();
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
    }
  });
  main.open.result = { canceled: false, filePaths: [archive] };
  const opened = await main.handlers.get('open-scan-archive')(main.event, 10);
  const running = main.handlers.get('compare-with-current')(main.event, 11);
  await started;
  assert.equal(main.progress.at(-1).requestId, 11);
  assert.match(main.handlers.get('cancel-scan')(main.event, 10).error, /no longer running/);
  assert.match(main.handlers.get('cancel-scan')({ sender: new EventEmitter() }, 11).error, /no longer running/);
  assert.equal(main.handlers.get('cancel-scan')(main.event, 11).success, true);
  assert.equal((await running).cancelled, true);
  const page = await main.handlers.get('get-folder-page')(main.event, opened.scanId, 0, 0, 200, 'name', [], {});
  assert.equal(page.success, true, page.error);
  assert.equal(main.handlers.get('list-saved-scans')().scans[0].readOnly, true);
  assert.equal(main.event.sender.listenerCount('destroyed'), 0);
});

for (const force of [false, true]) {
  test(`CLI publication ${force ? 'replaces' : 'preserves'} a competitor created after the output precheck`, async t => {
    const { root, source } = await fixture(t);
    const output = path.join(root, 'raced.csv');
    const scan = await scanFolder(source);
    let created = false;
    const signal = {
      throwIfAborted() {
        if (!created) {
          created = true;
          fs.writeFileSync(output, 'competitor', { flag: 'wx' });
        }
      }
    };
    if (force) {
      assert.equal(await writeCsvAtomically(scan, output, true, signal), output);
      assert.match(await fsp.readFile(output, 'utf8'), /"one\.txt"/);
    } else {
      await assert.rejects(writeCsvAtomically(scan, output, false, signal), error =>
        error.exitCode === EXIT.OUTPUT_EXISTS && /already exists/.test(error.message));
      assert.equal(await fsp.readFile(output, 'utf8'), 'competitor');
    }
    assert.equal((await fsp.readdir(root)).some(name => name.endsWith('.partial')), false);
  });
}

test('CLI returns exit 4 for an output that races in during export', async t => {
  const { root, source } = await fixture(t);
  const output = path.join(root, 'exit-code.csv');
  const stderr = [];
  const io = { stdout: { write() {} }, stderr: { write: text => stderr.push(text) } };
  const originalLink = fsp.link;
  t.after(() => { fsp.link = originalLink; });
  fsp.link = async (from, to) => {
    if (to === output) await fsp.writeFile(output, 'competitor', { flag: 'wx' });
    return originalLink(from, to);
  };
  assert.equal(await runCli(['scan', source, '--csv', output], io), EXIT.OUTPUT_EXISTS);
  assert.match(stderr.join(''), /already exists/);
  assert.equal(await fsp.readFile(output, 'utf8'), 'competitor');
});

test('CLI fails closed when no-replace hard-link publication is unsupported', async t => {
  const { root, source } = await fixture(t);
  const output = path.join(root, 'unsupported.csv');
  const originalLink = fsp.link;
  t.after(() => { fsp.link = originalLink; });
  fsp.link = async () => { throw Object.assign(new Error('Hard links unsupported'), { code: 'ENOTSUP' }); };
  await assert.rejects(writeCsvAtomically(await scanFolder(source), output, false), error =>
    error.exitCode === EXIT.WRITE_FAILED && error.code === 'ENOTSUP');
  assert.equal(fs.existsSync(output), false, 'must not silently fall back to a replacing rename');
  assert.equal((await fsp.readdir(root)).some(name => name.endsWith('.partial')), false);
});
