const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { inspectFileAction, validateNewName } = require('../src/main/file-action-guard');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diskoryx-actions-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const selected = path.join(root, 'scan');
  await fs.mkdir(selected);
  const file = path.join(selected, 'one.txt');
  await fs.writeFile(file, 'original');
  return { root, selected, file };
}

function loadMain(directory, confirmation, recycle, saveDialog, overrides = {}) {
  const handlers = new Map();
  let scanCalls = 0;
  const appRoot = path.join(__dirname, '..', 'src', 'main');
  const rootRequire = createRequire(path.join(appRoot, 'main.js'));
  vm.runInNewContext(fsSync.readFileSync(path.join(appRoot, 'main.js'), 'utf8'), {
    __dirname: appRoot, process, console: { ...console, warn() {} }, setImmediate, AbortController,
    require(name) {
      if (name === 'electron') return {
        app: { getPath: () => directory, setPath() {}, whenReady: () => ({ then() {} }), on() {} },
        BrowserWindow: { fromWebContents: () => ({}) },
        ipcMain: { handle(name, fn) {
          assert.equal(handlers.has(name), false, `IPC handler registered twice: ${name}`);
          handlers.set(name, fn);
        } },
        dialog: { showMessageBox: confirmation, showSaveDialog: saveDialog,
          showOpenDialog() { assert.fail('Paste must not open a Windows folder picker'); } },
        shell: { trashItem: recycle }
      };
      if (name === './scanner') return {
        ...rootRequire(name),
        scanFolder(...args) { scanCalls++; return rootRequire(name).scanFolder(...args); }
      };
      if (name === './live-updates') return { createLiveMonitor: () => ({ start: () => true, stop() {} }) };
      return overrides[name] || rootRequire(name);
    }
  });
  const sender = new EventEmitter();
  sender.isDestroyed = () => false;
  sender.send = (channel, request) => {
    if (channel !== 'recycle-confirmation') return;
    Promise.resolve(confirmation({}, { defaultId: 0, cancelId: 0 })).then(result =>
      handlers.get('confirm-recycle')({ sender }, request.requestId, result.response === 1));
  };
  return { handlers, event: { sender }, get scanCalls() { return scanCalls; } };
}

test('Windows names reject path escapes, streams and reserved devices', () => {
  for (const value of ['test.txt', 'new folder', 'report.final.log']) assert.equal(validateNewName(value), value);
  for (const value of ['', '../test', '..', 'a:b', 'NUL.txt', 'COM1', 'LPT9.log', 'x.', 'x ', ' x', 'a\0b']) {
    assert.throws(() => validateNewName(value), /valid Windows/);
  }
});

test('Create folder validates membership, inserts folders into cached totals and rejects stale revisions', async t => {
  const { root, selected } = await fixture(t);
  const main = loadMain(root);
  const scan = await main.handlers.get('scan-folder')(main.event, selected, {}, 1);
  const createFolder = main.handlers.get('create-folder');

  assert.match((await createFolder(main.event, scan.scanId, 0, 'NUL.txt')).error, /valid Windows/);
  assert.match((await createFolder(main.event, scan.scanId, 999, 'not-created')).error, /available folder/);
  const created = await createFolder(main.event, scan.scanId, 0, 'new folder');
  assert.equal(created.success, true, created.error);
  assert.equal(created.snapshotChanged, true);
  assert.equal(created.item.type, 'folder');
  assert.equal(created.item.path, path.join(selected, 'new folder'));
  assert.equal(await fs.readdir(created.item.path).then(items => items.length), 0);

  const rootPage = await main.handlers.get('get-folder-page')(
    main.event, created.scanId, 0, 0, 200, 'name', [], {}
  );
  assert.equal(rootPage.success, true);
  assert.ok(rootPage.items.some(item => item.path === created.item.path));
  const nested = await createFolder(main.event, created.scanId, created.item.folderId, 'nested');
  assert.equal(nested.success, true, nested.error);
  assert.equal(nested.item.parentFolderId, created.item.folderId);
  const nestedPage = await main.handlers.get('get-folder-page')(
    main.event, nested.scanId, created.item.folderId, 0, 200, 'name', [], {}
  );
  assert.equal(nestedPage.items[0].path, nested.item.path);
  assert.equal(nestedPage.items[0].rawSize, 0);

  assert.match((await createFolder(main.event, scan.scanId, 0, 'stale')).error, /current scan/);
  assert.match((await createFolder(main.event, nested.scanId, created.item.folderId, 'nested')).error, /already exists/);
  assert.equal(main.scanCalls, 1, 'Create folder updates the cached view without rescanning its root');
});

test('volume capacity reports real filesystem stats for the current scan and rejects stale scan IDs', async t => {
  const { root, selected } = await fixture(t);
  const main = loadMain(root);
  const scan = await main.handlers.get('scan-folder')(main.event, selected, {}, 1);
  const handler = main.handlers.get('volume-capacity');
  const [capacity, actual] = await Promise.all([
    handler(main.event, scan.scanId),
    fs.statfs(path.parse(selected).root, { bigint: true })
  ]);
  assert.equal(capacity.success, true, capacity.error);
  assert.equal(capacity.volumePath, path.parse(selected).root);
  assert.equal(capacity.totalBytes, Number(actual.blocks * actual.bsize));
  assert.equal(capacity.availableBytes, Number(actual.bavail * actual.bsize));
  assert.match((await handler(main.event, scan.scanId + 1)).error, /expired/);
});

test('file actions reject junction ancestors and replacement identities', async t => {
  const { root, selected, file } = await fixture(t);
  const snapshot = await inspectFileAction(selected, file);
  await fs.rename(file, path.join(selected, 'old.txt'));
  await fs.writeFile(file, 'replacement');
  await assert.rejects(inspectFileAction(selected, file, snapshot), /changed/);
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'victim.txt'), 'untouched');
  const link = path.join(selected, 'redirect');
  await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await assert.rejects(inspectFileAction(selected, path.join(link, 'victim.txt')), /links or junctions/);
  } finally {
    await fs.unlink(link);
  }
  await assert.rejects(inspectFileAction(selected, path.join(outside, 'victim.txt')), /outside/);
});

test('rename updates the cached view without rescanning and rejects a destination present at validation', async t => {
  const { root, selected, file } = await fixture(t);
  const main = loadMain(root);
  const scan = await main.handlers.get('scan-folder')(main.event, selected, {}, 1);
  const rename = main.handlers.get('rename-file');
  await fs.writeFile(path.join(selected, 'exists.txt'), 'keep');
  assert.match((await rename(main.event, file, 'exists.txt', scan.scanId)).error, /already exists/);
  assert.match((await rename(main.event, file, 'NUL', scan.scanId)).error, /valid Windows/);
  const unscanned = path.join(selected, 'new.txt');
  await fs.writeFile(unscanned, 'not scanned');
  assert.match((await rename(main.event, unscanned, 'other.txt', scan.scanId)).error, /not part/);
  const result = await rename(main.event, file, 'renamed.txt', scan.scanId);
  assert.equal(result.success, true);
  assert.equal(await fs.readFile(result.path, 'utf8'), 'original');
  assert.equal(await fs.readFile(path.join(selected, 'exists.txt'), 'utf8'), 'keep');
  assert.match((await rename(main.event, result.path, 'again.txt', scan.scanId)).error, /expired/);
  const view = await main.handlers.get('sort-tree')(main.event, selected, 'name', result.scanId, [], {});
  assert.equal(view.success, true);
  assert.equal(view.structure[0].name, 'renamed.txt');
  assert.equal(view.totalSizeBytes, scan.totalSizeBytes);
  assert.equal(view.fileCount, scan.fileCount);
  assert.equal(view.scanDurationMs, scan.scanDurationMs);
  assert.equal(view.scanMode, scan.scanMode);
  const again = await rename(main.event, result.path, 'again.log', result.scanId);
  assert.equal(again.success, true);
  const filtered = await main.handlers.get('sort-tree')(
    main.event, selected, 'size', again.scanId, [], { includeExtensions: ['.log'] }
  );
  assert.equal(filtered.fileCount, 1);
  assert.equal(filtered.structure[0].name, 'again.log');
  assert.equal(filtered.filesByType.log, 1);
  assert.equal(main.scanCalls, 1);
});

test('history restores and redoes a name through guarded rename without rescanning or duplicate records', async t => {
  const { root, selected, file } = await fixture(t);
  const main = loadMain(root);
  const scan = await main.handlers.get('scan-folder')(main.event, selected, {}, 1);
  const renamed = await main.handlers.get('rename-file')(main.event, file, 'renamed.log', scan.scanId);
  const history = () => main.handlers.get('action-history')();
  assert.equal((await history()).entries.length, 1);
  const entry = (await history()).entries[0];
  assert.equal(entry.canRestore, true);
  assert.equal(entry.chain, undefined, 'native identity chain stays in main');
  const analysis = main.handlers.get('analysis-page');
  const before = await analysis(main.event, renamed.scanId, { view: 'types' });
  assert.equal(before.items[0].extension, 'log');
  const restored = await main.handlers.get('restore-name')(main.event, entry.id, renamed.scanId);
  assert.equal(restored.success, true);
  assert.equal(restored.path, file);
  assert.equal(await fs.readFile(file, 'utf8'), 'original');
  assert.equal((await history()).entries[0].state, 'undone');
  const after = await analysis(main.event, restored.scanId, { view: 'types' });
  assert.equal(after.items[0].extension, 'txt');
  const redone = await main.handlers.get('restore-name')(main.event, entry.id, restored.scanId);
  assert.equal(redone.success, true);
  assert.equal(await fs.readFile(renamed.path, 'utf8'), 'original');
  assert.equal((await history()).entries.length, 1);
  assert.equal((await history()).entries[0].state, 'done');
  assert.equal(main.scanCalls, 1);
});

test('name restore refuses conflicting original path and replacement identity without touching either file', async t => {
  const { root, selected, file } = await fixture(t);
  const main = loadMain(root);
  const scan = await main.handlers.get('scan-folder')(main.event, selected, {}, 1);
  const renamed = await main.handlers.get('rename-file')(main.event, file, 'renamed.txt', scan.scanId);
  const entry = (await main.handlers.get('action-history')()).entries[0];
  await fs.writeFile(file, 'conflict');
  const conflict = await main.handlers.get('restore-name')(main.event, entry.id, renamed.scanId);
  assert.match(conflict.error, /already exists/);
  assert.equal(await fs.readFile(file, 'utf8'), 'conflict');
  await fs.rename(renamed.path, path.join(selected, 'kept.txt'));
  await fs.writeFile(renamed.path, 'replacement');
  const replacement = await main.handlers.get('restore-name')(main.event, entry.id, renamed.scanId);
  assert.match(replacement.error, /changed/);
  assert.equal(await fs.readFile(renamed.path, 'utf8'), 'replacement');
  assert.equal((await main.handlers.get('action-history')()).entries[0].state, 'done');
});

test('folder name restore keeps descendant paths and extension totals coherent', async t => {
  const { root, selected } = await fixture(t);
  const folder = path.join(selected, 'old');
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'child.txt'), 'child');
  const main = loadMain(root);
  const scan = await main.handlers.get('scan-folder')(main.event, selected, {}, 1);
  const renamed = await main.handlers.get('rename-file')(main.event, folder, 'new', scan.scanId);
  const entry = (await main.handlers.get('action-history')()).entries[0];
  const restored = await main.handlers.get('restore-name')(main.event, entry.id, renamed.scanId);
  assert.equal(restored.success, true);
  const search = await main.handlers.get('search-files')(main.event, restored.scanId, 'child', [], 0, 200, {});
  assert.equal(search.results[0].path, path.join(folder, 'child.txt'));
  assert.equal(main.scanCalls, 1);
  assert.match((await main.handlers.get('restore-name')(main.event, entry.id, renamed.scanId)).error, /expired/);
  assert.match((await main.handlers.get('restore-name')(main.event, 'invented', restored.scanId)).error, /cannot restore/);
});

test('saved history restores after restarting the app and rescanning the original location', async t => {
  const { root, selected, file } = await fixture(t);
  const first = loadMain(root);
  const scan = await first.handlers.get('scan-folder')(first.event, selected, {}, 1);
  const renamed = await first.handlers.get('rename-file')(first.event, file, 'renamed.txt', scan.scanId);
  assert.equal(renamed.success, true);
  const second = loadMain(root);
  let entries = (await second.handlers.get('action-history')()).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].canRestore, false);
  const rescan = await second.handlers.get('scan-folder')(second.event, selected, {}, 2);
  entries = (await second.handlers.get('action-history')()).entries;
  assert.equal(entries[0].canRestore, true);
  const restored = await second.handlers.get('restore-name')(second.event, entries[0].id, rescan.scanId);
  assert.equal(restored.success, true);
  assert.equal(await fs.readFile(file, 'utf8'), 'original');
});

test('corrupt history is preserved and refuses modification before touching a file', async t => {
  const { root, selected, file } = await fixture(t);
  const historyFile = path.join(root, 'action-history.json');
  await fs.writeFile(historyFile, '{damaged');
  const main = loadMain(root);
  const scan = await main.handlers.get('scan-folder')(main.event, selected, {}, 1);
  assert.ok((await main.handlers.get('action-history')()).error);
  const result = await main.handlers.get('rename-file')(main.event, file, 'new.txt', scan.scanId);
  assert.ok(result.error);
  assert.equal(await fs.readFile(file, 'utf8'), 'original');
  assert.equal(await fs.readFile(historyFile, 'utf8'), '{damaged');
});

test('history write failure reports completed rename explicitly without invalidating the cached result', async t => {
  const { root, selected, file } = await fixture(t);
  const { ActionHistory } = require('../src/main/action-history');
  class UnwritableHistory extends ActionHistory {
    async save() { throw new Error('History storage is read-only'); }
  }
  const main = loadMain(root, null, null, null, { './action-history': { ActionHistory: UnwritableHistory } });
  const scan = await main.handlers.get('scan-folder')(main.event, selected, {}, 1);
  const result = await main.handlers.get('rename-file')(main.event, file, 'new.txt', scan.scanId);
  assert.equal(result.success, true);
  assert.match(result.historyWarning, /completed.*read-only/);
  assert.equal(await fs.readFile(result.path, 'utf8'), 'original');
  const view = await main.handlers.get('sort-tree')(main.event, selected, 'name', result.scanId, [], {});
  assert.equal(view.structure[0].name, 'new.txt');
});

test('copy/paste inserts a file into cached totals and supports verified undo/redo without rescanning', async t => {
  const { root, selected, file } = await fixture(t);
  const destination = path.join(selected, 'destination');
  await fs.mkdir(destination);
  const main = loadMain(root, async () => ({ response: 1 }), async target =>
    fs.rename(target, path.join(root, `copy-in-bin-${Date.now()}`)), null, {
    showOpenDialog: async () => ({ canceled: false, filePaths: [destination] })
  });
  const scan = await main.handlers.get('scan-folder')(main.event, selected, {}, 1);
  assert.equal((await main.handlers.get('copy-item')(main.event, file, scan.scanId)).success, true);
  const folder = scan.structure.find(item => item.path === destination);
  const pasted = await main.handlers.get('paste-item')(main.event, scan.scanId, folder.folderId);
  assert.equal(pasted.success, true, pasted.error);
  assert.equal(pasted.snapshotChanged, true);
  assert.equal(await fs.readFile(pasted.path, 'utf8'), 'original');
  let view = await main.handlers.get('sort-tree')(main.event, selected, 'name', pasted.scanId, [], {});
  assert.equal(view.fileCount, 2);
  assert.equal(view.totalSizeBytes, scan.totalSizeBytes * 2);
  const entry = (await main.handlers.get('action-history')()).entries[0];
  assert.equal(entry.kind, 'copy');
  const undone = await main.handlers.get('copy-history-action')(main.event, entry.id);
  assert.equal(undone.success, true, undone.error);
  assert.equal(await fs.readFile(file, 'utf8'), 'original');
  await assert.rejects(fs.stat(pasted.path), { code: 'ENOENT' });
  view = await main.handlers.get('sort-tree')(main.event, selected, 'name', undone.scanId, [], {});
  assert.equal(view.fileCount, 1);
  const redone = await main.handlers.get('copy-history-action')(main.event, entry.id);
  assert.equal(redone.success, true, redone.error);
  assert.equal(await fs.readFile(pasted.path, 'utf8'), 'original');
  assert.equal(typeof main.handlers.get('restore-recycled-item'), 'function');
  const undoneAgain = await main.handlers.get('copy-history-action')(main.event, entry.id);
  assert.equal(undoneAgain.success, true, undoneAgain.error);
  assert.equal(main.scanCalls, 1);
});

test('undo copy refuses edited or replacement contents without recycling user changes', async t => {
  const { root, selected, file } = await fixture(t);
  const destination = path.join(selected, 'destination');
  await fs.mkdir(destination);
  let recycled = 0;
  const main = loadMain(root, async () => ({ response: 1 }), async () => { recycled++; }, null, {
    showOpenDialog: async () => ({ canceled: false, filePaths: [destination] })
  });

  const scan = await main.handlers.get('scan-folder')(main.event, selected, {}, 1);
  await main.handlers.get('copy-item')(main.event, file, scan.scanId);
  const folder = scan.structure.find(item => item.path === destination);
  const pasted = await main.handlers.get('paste-item')(main.event, scan.scanId, folder.folderId);
  assert.equal(pasted.success, true, pasted.error);
  const entry = (await main.handlers.get('action-history')()).entries[0];
  await fs.writeFile(pasted.path, 'user changed this copy');
  const result = await main.handlers.get('copy-history-action')(main.event, entry.id);
  assert.match(result.error, /changed|refused/);
  assert.equal(result.refreshRequired, false, 'refusal before shell does not invalidate the snapshot');
  assert.equal(recycled, 0);
  assert.equal(await fs.readFile(pasted.path, 'utf8'), 'user changed this copy');
});

test('in-app Paste requires a current scanned folder ID and never opens a native picker', async t => {
  const { root, selected, file } = await fixture(t);
  const main = loadMain(root);
  const scan = await main.handlers.get('scan-folder')(main.event, selected, {}, 1);
  await main.handlers.get('copy-item')(main.event, file, scan.scanId);
  const paste = main.handlers.get('paste-item');
  for (const id of [-1, 999, 'C:\\outside', null]) {
    assert.match((await paste(main.event, scan.scanId, id)).error, /destination folder/);
  }
  assert.match((await paste(main.event, scan.scanId + 1, 0)).error, /scan changed/);
  assert.match((await paste({ sender: {} }, scan.scanId, 0)).error, /Use Copy/);
  const pasted = await paste(main.event, scan.scanId, 0);
  assert.equal(pasted.success, true, pasted.error);
  assert.equal(path.basename(pasted.path), 'one - Copy.txt');
  assert.equal(await fs.readFile(file, 'utf8'), 'original');
  assert.equal(main.scanCalls, 1);
});

test('switching saved locations retains renamed source and copied destination without rescanning', async t => {
  const { root, selected, file } = await fixture(t);
  const destination = path.join(root, 'another-root');
  await fs.mkdir(destination);
  const main = loadMain(root);
  const first = await main.handlers.get('scan-folder')(main.event, selected, {}, 1);
  const renamed = await main.handlers.get('rename-file')(main.event, file, 'renamed.txt', first.scanId);
  assert.equal(renamed.success, true, renamed.error);
  const source = path.join(selected, 'renamed.txt');
  assert.equal((await main.handlers.get('copy-item')(main.event, source, renamed.scanId)).success, true);
  const second = await main.handlers.get('scan-folder')(main.event, destination, {}, 2);
  const pasted = await main.handlers.get('paste-item')(main.event, second.scanId, 0);
  assert.equal(pasted.success, true, pasted.error);
  const activate = main.handlers.get('activate-saved-scan');
  const returned = await activate(main.event, selected);
  assert.equal(returned.success, true, returned.error);
  assert.equal(returned.fileCount, 1);
  assert.equal(returned.structure[0].path, source);
  const other = await activate(main.event, destination);
  assert.equal(other.fileCount, 1);
  assert.equal(other.structure[0].path, path.join(destination, 'renamed.txt'));
  assert.equal(other.totalSizeBytes, Buffer.byteLength('original'));
  assert.equal(main.scanCalls, 2);
  assert.equal(await fs.readFile(source, 'utf8'), 'original');
  assert.equal(await fs.readFile(path.join(destination, 'renamed.txt'), 'utf8'), 'original');
});

test('Move selection, Paste and History return/redo update both snapshots without rescanning', async t => {
  const { root, selected, file } = await fixture(t);
  const destination = path.join(root, 'another-root');
  await fs.mkdir(destination);
  const main = loadMain(root);
  const first = await main.handlers.get('scan-folder')(main.event, selected, {}, 1);
  const chosen = await main.handlers.get('copy-item')(main.event, file, first.scanId, 'move');
  assert.equal(chosen.success, true, chosen.error);
  assert.equal(chosen.mode, 'move');
  const second = await main.handlers.get('scan-folder')(main.event, destination, {}, 2);
  const moved = await main.handlers.get('paste-item')(main.event, second.scanId, 0);
  assert.equal(moved.success, true, moved.error);
  assert.equal(moved.moved, true);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  const entry = (await main.handlers.get('action-history')()).entries[0];
  assert.equal(entry.kind, 'move');
  assert.equal((await main.handlers.get('activate-saved-scan')(main.event, selected)).fileCount, 0);
  const restored = await main.handlers.get('move-history-action')(main.event, entry.id);
  assert.equal(restored.success, true, restored.error);
  assert.equal(await fs.readFile(file, 'utf8'), 'original');
  assert.equal((await main.handlers.get('action-history')()).entries[0].state, 'undone');
  const redone = await main.handlers.get('move-history-action')(main.event, entry.id);
  assert.equal(redone.success, true, redone.error);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  assert.equal((await main.handlers.get('activate-saved-scan')(main.event, destination)).fileCount, 1);
  await fs.writeFile(path.join(destination, 'one.txt'), 'edited moved content');
  const refused = await main.handlers.get('move-history-action')(main.event, entry.id);
  assert.match(refused.error, /changed|refused/);
  assert.equal(main.scanCalls, 2);
});

test('Copy into the same folder chooses numbered names without overwrite and History redo keeps that name', async t => {
  const { root, selected, file } = await fixture(t);
  const main = loadMain(root, async () => ({ response: 1 }), target =>
    fs.rename(target, path.join(root, 'recycled-copy.txt')));
  const scan = await main.handlers.get('scan-folder')(main.event, selected, {}, 1);
  await main.handlers.get('copy-item')(main.event, file, scan.scanId);
  const first = await main.handlers.get('paste-item')(main.event, scan.scanId, 0);
  assert.equal(first.success, true, first.error);
  assert.equal(path.basename(first.path), 'one - Copy.txt');
  const second = await main.handlers.get('paste-item')(main.event, first.scanId, 0);
  assert.equal(second.success, true, second.error);
  assert.equal(path.basename(second.path), 'one - Copy (2).txt');
  const entry = (await main.handlers.get('action-history')()).entries[0];
  const undone = await main.handlers.get('copy-history-action')(main.event, entry.id);
  assert.equal(undone.success, true, undone.error);
  const redone = await main.handlers.get('copy-history-action')(main.event, entry.id);
  assert.equal(redone.success, true, redone.error);
  assert.equal(redone.path, second.path);
  assert.equal(await fs.readFile(file, 'utf8'), 'original');
  assert.equal(main.scanCalls, 1);
});

test('Move History survives restart and refuses a replaced original parent without touching either location', async t => {
  const { root, selected, file } = await fixture(t);
  const destination = path.join(root, 'destination');
  await fs.mkdir(destination);
  const main = loadMain(root);
  const first = await main.handlers.get('scan-folder')(main.event, selected, {}, 1);
  await main.handlers.get('copy-item')(main.event, file, first.scanId, 'move');
  const second = await main.handlers.get('scan-folder')(main.event, destination, {}, 2);
  const moved = await main.handlers.get('paste-item')(main.event, second.scanId, 0);
  assert.equal(moved.success, true, moved.error);
  const restarted = loadMain(root);
  const entry = (await restarted.handlers.get('action-history')()).entries[0];
  assert.equal(entry.kind, 'move');
  await fs.rename(selected, path.join(root, 'original-parent'));
  await fs.mkdir(selected);
  const result = await restarted.handlers.get('move-history-action')(restarted.event, entry.id);
  assert.match(result.error, /changed|replaced|identity/i);
  assert.equal(await fs.readFile(moved.path, 'utf8'), 'original');
  assert.deepEqual(await fs.readdir(selected), []);
  assert.equal(result.refreshRequired, false);
});

test('same-parent Move is a definite no-op refusal and Cancel selection clears owned backend state', async t => {
  const { root, selected, file } = await fixture(t);
  const main = loadMain(root);
  const scan = await main.handlers.get('scan-folder')(main.event, selected, {}, 1);
  await main.handlers.get('copy-item')(main.event, file, scan.scanId, 'move');
  const result = await main.handlers.get('paste-item')(main.event, scan.scanId, 0);
  assert.match(result.error, /already in this folder/);
  assert.equal(result.refreshRequired, false);
  assert.equal((await main.handlers.get('sort-tree')(main.event, selected, 'name', scan.scanId, [], {})).success, true);
  await main.handlers.get('clear-copy-selection')({ sender: {} });
  assert.match((await main.handlers.get('paste-item')(main.event, scan.scanId, 0)).error, /already in this folder/);
  await main.handlers.get('clear-copy-selection')(main.event);
  assert.match((await main.handlers.get('paste-item')(main.event, scan.scanId, 0)).error, /Use Copy/);
  assert.equal(await fs.readFile(file, 'utf8'), 'original');
  assert.equal(main.scanCalls, 1);
});

test('folder copy adds bounded subtree ids, search paths, pages and deduplicated extension totals', async t => {
  const { root, selected } = await fixture(t);
  const source = path.join(selected, 'folder');
  await fs.mkdir(path.join(source, 'nested'), { recursive: true });
  await fs.writeFile(path.join(source, 'nested', 'unique.json'), '12345');
  const destination = path.join(selected, 'destination');
  await fs.mkdir(destination);
  const main = loadMain(root, null, null, null, {
    showOpenDialog: async () => ({ canceled: false, filePaths: [destination] })
  });
  const scan = await main.handlers.get('scan-folder')(main.event, selected, {}, 1);
  await main.handlers.get('copy-item')(main.event, source, scan.scanId);
  const folder = scan.structure.find(item => item.path === destination);
  const pasted = await main.handlers.get('paste-item')(main.event, scan.scanId, folder.folderId);
  assert.equal(pasted.success, true, pasted.error);
  const view = await main.handlers.get('sort-tree')(main.event, selected, 'name', pasted.scanId, [], {});
  assert.equal(view.fileCount, scan.fileCount + 1);
  assert.equal(view.folderCount, scan.folderCount + 2);
  assert.equal(view.totalSizeBytes, scan.totalSizeBytes + 5);
  const search = await main.handlers.get('search-files')(main.event, pasted.scanId, 'unique.json', [], 0, 200, {});
  assert.equal(search.results.length, 2);
  assert(search.results.some(item => item.path === path.join(destination, 'folder', 'nested', 'unique.json')));
  const types = await main.handlers.get('analysis-page')(main.event, pasted.scanId, { view: 'types' });
  assert.equal(types.items.find(item => item.extension === 'json').count, 2);
  assert.equal(main.scanCalls, 1, 'only copied subtree is read, never the full scan');
});

test('folder rename updates descendant paths, then recycling removes subtree totals, pages, search and CSV', async t => {
  const { root, selected } = await fixture(t);
  const folder = path.join(selected, 'java');
  await fs.mkdir(path.join(folder, 'nested'), { recursive: true });
  await fs.writeFile(path.join(folder, 'README'), '12345');
  await fs.writeFile(path.join(folder, 'nested', 'config.json'), '1234567890');
  const main = loadMain(root, async () => ({ response: 1 }), async target => {
    // Emulate moving out of the scanned root, not the real Windows Recycle Bin.
    await fs.rename(target, path.join(root, 'recycled'));
  });
  const scan = await main.handlers.get('scan-folder')(main.event, selected, {}, 1);
  const oldFolder = scan.structure.find(item => item.name === 'java');
  const renamed = await main.handlers.get('rename-file')(main.event, folder, 'runtime', scan.scanId);
  assert.equal(renamed.success, true);
  const search = await main.handlers.get('search-files')(main.event, renamed.scanId, 'config', [], 0, 200, {});
  assert.equal(search.results[0].path, path.join(selected, 'runtime', 'nested', 'config.json'));
  const parentId = search.results[0].parentFolderId;
  const ancestors = main.handlers.get('get-folder-ancestors')(main.event, renamed.scanId, parentId, [], {});
  assert.deepEqual(Array.from(ancestors.ancestors, item => item.name), ['runtime', 'nested']);
  const recycled = await main.handlers.get('delete-file')(main.event, renamed.path, renamed.scanId);
  assert.equal(recycled.success, true);
  const view = await main.handlers.get('sort-tree')(main.event, selected, 'size', recycled.scanId, [], {});
  assert.equal(view.fileCount, 1);
  assert.equal(view.folderCount, 0);
  assert.equal(view.totalSizeBytes, 8);
  assert.equal(view.structure.length, 1);
  assert.equal(Object.keys(view.filesByType).join(), 'txt');
  assert.equal((await main.handlers.get('search-files')(
    main.event, recycled.scanId, 'config', [], 0, 200, {}
  )).totalCount, 0);
  assert.match((await main.handlers.get('get-folder-page')(
    main.event, recycled.scanId, oldFolder.folderId, 0, 200, 'name', [], {}
  )).error, /no longer available/);
  assert.match(main.handlers.get('get-folder-ancestors')(
    main.event, recycled.scanId, parentId, [], {}
  ).error, /no longer available/);
  const stale = await main.handlers.get('read-text-preview')(main.event, renamed.scanId, search.results[0].path, 0);
  assert.match(stale.error, /expired/);
  assert.equal(main.scanCalls, 1);
});

test('junction substitution while confirmation is open refuses recycle and leaves outside files unchanged', async t => {
  const { root, selected } = await fixture(t);
  const inside = path.join(selected, 'child');
  const moved = path.join(selected, 'original-child');
  const outside = path.join(root, 'outside');
  await fs.mkdir(inside);
  await fs.mkdir(outside);
  const target = path.join(inside, 'victim.txt');
  const outsideFile = path.join(outside, 'victim.txt');
  await fs.writeFile(target, 'inside');
  await fs.writeFile(outsideFile, 'outside');
  let recycled = 0;
  const main = loadMain(root, async () => {
    await fs.rename(inside, moved);
    await fs.symlink(outside, inside, process.platform === 'win32' ? 'junction' : 'dir');
    return { response: 1 };
  }, async () => { recycled++; });
  const scan = await main.handlers.get('scan-folder')(main.event, selected, {}, 1);
  try {
    const result = await main.handlers.get('delete-file')(main.event, target, scan.scanId);
    assert.match(result.error, /links or junctions/);
    assert.equal(recycled, 0);
    assert.equal(await fs.readFile(outsideFile, 'utf8'), 'outside');
    assert.equal(await fs.readFile(path.join(moved, 'victim.txt'), 'utf8'), 'inside');
  } finally {
    await fs.unlink(inside);
  }
});

test('recycle cancellation preserves the file and confirmed action calls only the recycle API', async t => {
  const { root, selected, file } = await fixture(t);
  let confirmed = false;
  const recycled = [];
  const main = loadMain(root, async (_window, options) => {
    assert.equal(options.defaultId, 0);
    assert.equal(options.cancelId, 0);
    return { response: confirmed ? 1 : 0 };
  }, async target => { recycled.push(target); });
  const scan = await main.handlers.get('scan-folder')(main.event, selected, {}, 1);
  const recycle = main.handlers.get('delete-file');
  assert.equal((await recycle(main.event, file, scan.scanId)).cancelled, true);
  assert.equal(recycled.length, 0);
  assert.equal(await fs.readFile(file, 'utf8'), 'original');
  confirmed = true;
  assert.equal((await recycle(main.event, file, scan.scanId)).success, true);
  assert.deepEqual(recycled, [file]);
});

test('replacement during recycle confirmation refuses the operation and serializes conflicting requests', async t => {
  const { root, selected, file } = await fixture(t);
  let release;
  let recycled = 0;
  const main = loadMain(root, () => new Promise(resolve => { release = resolve; }), async () => { recycled++; });
  const scan = await main.handlers.get('scan-folder')(main.event, selected, {}, 1);
  const running = main.handlers.get('delete-file')(main.event, file, scan.scanId);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.match((await main.handlers.get('refresh-tree')(main.event, selected, {}, 2)).error, /file action/);
  assert.match((await main.handlers.get('rename-file')(main.event, file, 'next.txt', scan.scanId)).error, /Wait/);
  await fs.rename(file, path.join(selected, 'original.txt'));
  await fs.writeFile(file, 'different');
  release({ response: 1 });
  assert.match((await running).error, /changed/);
  assert.equal(recycled, 0);
  assert.equal(await fs.readFile(file, 'utf8'), 'different');
});

test('failed recycle never permanently deletes a file and releases action lock', async t => {
  const { root, selected, file } = await fixture(t);
  const main = loadMain(root, async () => ({ response: 1 }), async () => { throw new Error('Recycle Bin unavailable'); });
  const scan = await main.handlers.get('scan-folder')(main.event, selected, {}, 1);
  const failed = await main.handlers.get('delete-file')(main.event, file, scan.scanId);
  assert.match(failed.error, /Recycle Bin unavailable/);
  assert.equal(failed.refreshRequired, true);
  assert.equal(await fs.readFile(file, 'utf8'), 'original');
  assert.match((await main.handlers.get('rename-file')(main.event, file, 'after.txt', scan.scanId)).error, /expired/);
  const refreshed = await main.handlers.get('refresh-tree')(main.event, selected, {}, 2);
  const unchanged = await main.handlers.get('sort-tree')(main.event, selected, 'name', refreshed.scanId, [], {});
  assert.equal(unchanged.success, true);
  assert.equal(unchanged.structure[0].path, file);
  assert.equal(unchanged.fileCount, 1);
  assert.equal((await main.handlers.get('rename-file')(main.event, file, 'after.txt', refreshed.scanId)).success, true);
});

test('CSV exports the updated snapshot and cannot interleave a file mutation', async t => {
  const { root, selected, file } = await fixture(t);
  const output = path.join(root, 'snapshot.csv');
  let started;
  let release;
  const entered = new Promise(resolve => { started = resolve; });
  const continueExport = new Promise(resolve => { release = resolve; });
  const main = loadMain(root, undefined, undefined, async () => ({ filePath: output }), {
    'node:stream/promises': {
      async pipeline(...args) {
        started();
        await continueExport;
        return require('node:stream/promises').pipeline(...args);
      }
    }
  });

  const scan = await main.handlers.get('scan-folder')(main.event, selected, {}, 1);
  const renamed = await main.handlers.get('rename-file')(main.event, file, 'new.log', scan.scanId);
  const exporting = main.handlers.get('export-csv')(main.event, renamed.scanId);
  await Promise.race([entered, exporting.then(result => { throw new Error(JSON.stringify(result)); })]);
  try {
    const blocked = await main.handlers.get('rename-file')(main.event, renamed.path, 'later.txt', renamed.scanId);
    assert.match(blocked.error, /CSV export/);
  } finally {
    release();
  }
  const exported = await exporting;
  assert.equal(exported.success, true);
  const text = await fs.readFile(output, 'utf8');
  assert.match(text, /new\.log/);
  assert.doesNotMatch(text, /one\.txt/);
  assert.equal((await main.handlers.get('rename-file')(
    main.event, renamed.path, 'later.txt', renamed.scanId
  )).success, true);
  assert.equal(main.scanCalls, 1);
});

test('uncertain native completion invalidates cached actions until an explicit rescan', async t => {
  const { root, selected, file } = await fixture(t);
  const main = loadMain(root, undefined, undefined, undefined, {
    './windows-rename': {
      async renameWithHandles() {
        const error = new Error('Native completion uncertain. Rescan.');
        error.outcomeUncertain = true;
        throw error;
      }
    }
  });
  const scan = await main.handlers.get('scan-folder')(main.event, selected, {}, 1);
  const result = await main.handlers.get('rename-file')(main.event, file, 'new.txt', scan.scanId);
  assert.equal(result.refreshRequired, true);
  assert.match(result.error, /uncertain/);
  assert.match((await main.handlers.get('rename-file')(main.event, file, 'new.txt', scan.scanId)).error, /expired/);
  assert.equal(main.scanCalls, 1);
  const refreshed = await main.handlers.get('refresh-tree')(main.event, selected, {}, 2);
  assert.equal(refreshed.success, true);
  assert.equal(main.scanCalls, 2);
});
