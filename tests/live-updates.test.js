const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { createLiveMonitor } = require('../src/main/live-updates');
const { reconcilePaths } = require('../src/main/live-reconcile');
const { scanFolder } = require('../src/main/scanner');
const { createTreeBuilder } = require('../src/main/mft-scanner');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const inspectRoot = () => ({ dev: 1, ino: 2, isDirectory: () => true, isSymbolicLink: () => false });
function cloneSnapshot(scan) {
  const copy = structuredClone(scan);
  for (let index = 0; index < scan.folderNodes.length; index++) {
    if (scan.folderNodes[index]) Object.setPrototypeOf(
      copy.folderNodes[index].extensionStats, Object.getPrototypeOf(scan.folderNodes[index].extensionStats)
    );
  }
  return copy;
}

test('live monitor coalesces events, waits for actions and uses one nonpersistent recursive watcher', async () => {
  let callback;
  let busy = true;
  let closed = 0;
  const batches = [];
  const watcher = new EventEmitter();
  watcher.close = () => { closed++; };
  const monitor = createLiveMonitor({
    delay: 5, inspectRoot, isBusy: () => busy, onBatch: async paths => { batches.push(paths); },
    onStale: message => assert.fail(message),
    watch(root, options, listener) {
      assert.equal(options.recursive, true);
      assert.equal(options.persistent, false);
      callback = listener; return watcher;
    }
  });
  monitor.start('C:\\fixture');
  callback('change', 'one.txt');
  callback('change', 'one.txt');
  await wait(20);
  assert.equal(batches.length, 0);
  busy = false;
  await wait(25);
  assert.deepEqual(batches, [['C:\\fixture\\one.txt']]);
  monitor.stop();
  assert.equal(closed, 1);
});

test('missing paths and event overflow stop watching with an explicit stale notification', async () => {
  for (const overflow of [false, true]) {
    let callback;
    let stale;
    let closed = false;
    const monitor = createLiveMonitor({
      maxPaths: 1, delay: 5, inspectRoot, onBatch: async () => assert.fail('must not apply lost events'),
      onStale: reason => { stale = reason; },
      watch(_root, _options, listener) {
        callback = listener;
        return { on() {}, close() { closed = true; } };
      }
    });

    monitor.start('C:\\fixture');
    if (overflow) { callback('change', 'one'); callback('rename', 'two'); }
    else callback('rename', null);
    await wait(20);
    assert.ok(stale);
    assert.equal(closed, true);
  }
});

test('root replacement pauses monitoring instead of merging a new tree into the old snapshot', async () => {
  let callback;
  let replaced = false;
  let resolveStale;
  const stale = new Promise(resolve => { resolveStale = resolve; });
  const monitor = createLiveMonitor({
    delay: 5, inspectRoot: () => ({ ...inspectRoot(), ino: replaced ? 3 : 2 }),
    onBatch: async () => assert.fail('must not merge a replaced root'),
    onStale: resolveStale,
    watch(_root, _options, listener) { callback = listener; return { on() {}, close() {} }; }
  });
  monitor.start('C:\\fixture');
  replaced = true;
  callback('change', 'one');
  const keepAlive = setTimeout(() => resolveStale('test timeout'), 2000);
  try { assert.match(await stale, /root was replaced/); }
  finally { clearTimeout(keepAlive); monitor.stop(); }
});

test('watcher failure waits for in-flight file actions before invalidating the snapshot', async () => {
  let callback;
  let busy = true;
  let stale = false;
  const monitor = createLiveMonitor({
    delay: 5, inspectRoot, isBusy: () => busy, onBatch: async () => {},
    onStale: () => { stale = true; },
    watch(_root, _options, listener) { callback = listener; return { on() {}, close() {} }; }
  });
  monitor.start('C:\\fixture');
  callback('rename', null);
  await wait(20);
  assert.equal(stale, false);
  busy = false;
  await wait(20);
  assert.equal(stale, true);
  monitor.stop();
});

test('watcher loss while reconciling marks that batch obsolete before its completion', async () => {
  let callback;
  let finish;
  let entered;
  let validAtEnd;
  let stale;
  const ready = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { finish = resolve; });
  const monitor = createLiveMonitor({
    delay: 5, inspectRoot,
    onBatch: async (_paths, isCurrent) => {
      entered();
      await pending;
      validAtEnd = isCurrent();
    },
    onStale: message => { stale = message; },
    watch(_root, _options, listener) { callback = listener; return { on() {}, close() {} }; }
  });
  monitor.start('C:\\fixture');
  callback('change', 'one');
  await ready;
  callback('rename', null);
  finish();
  await wait(20);
  assert.equal(validAtEnd, false);
  assert.match(stale, /lost/);
  monitor.stop();
});

test('live reconciliation applies additions, size changes, external rename/removal and restored subtrees', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diskoryx-live-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const original = path.join(root, 'original.txt');
  await fs.writeFile(original, '123');
  const scan = await scanFolder(root);
  await fs.writeFile(original, '123456');
  assert.equal(await reconcilePaths(scan, [original]), true);
  assert.equal(scan.totalSizeBytes, 6);
  const renamed = path.join(root, 'renamed.log');
  await fs.rename(original, renamed);
  await reconcilePaths(scan, [original, renamed]);
  assert.equal(scan.fileCount, 1);
  assert.equal(scan.fileNodes[0].path, renamed);
  assert.equal(scan.filesByType.log, 1);
  const restored = path.join(root, 'restored');
  await fs.mkdir(restored);
  const child = path.join(restored, 'child.json');
  await fs.writeFile(child, '12345');
  await reconcilePaths(scan, [restored, child]);
  assert.equal(scan.fileCount, 2);
  assert.equal(scan.folderCount, 1);
  assert.equal(scan.totalSizeBytes, 11);
  await fs.rm(restored, { recursive: true });
  await reconcilePaths(scan, [child, restored]);
  assert.equal(scan.fileCount, 1);
  assert.equal(scan.totalSizeBytes, 6);
});

test('live reconciliation refuses changed hard links instead of double-counting bytes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diskoryx-live-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const original = path.join(root, 'original');
  await fs.writeFile(original, 'one');
  const scan = await scanFolder(root);
  const alias = path.join(root, 'alias');
  await fs.link(original, alias);
  await assert.rejects(reconcilePaths(scan, [alias]), /hard links/);
  assert.equal(scan.fileCount, 1);
});

test('unchanged hard-link notifications do not unnecessarily pause live monitoring', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diskoryx-live-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'one.txt');
  await fs.writeFile(file, 'one');
  await fs.link(file, path.join(root, 'alias.txt'));
  const scan = await scanFolder(root);
  assert.equal(await reconcilePaths(scan, [file]), false);
  await fs.writeFile(file, 'changed data');
  await assert.rejects(reconcilePaths(scan, [file]), /hard link/);
});

test('failed live batch rolls back earlier file and folder changes, preserving IDs and all totals', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diskoryx-live-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'old'));
  await fs.writeFile(path.join(root, 'old', 'child.txt'), 'original child');
  await fs.writeFile(path.join(root, 'one.txt'), 'one');
  const scan = await scanFolder(root);
  const original = cloneSnapshot(scan);
  await fs.rm(path.join(root, 'old'), { recursive: true });
  await fs.mkdir(path.join(root, 'new'));
  await fs.writeFile(path.join(root, 'new', 'new.txt'), 'new child');
  await fs.writeFile(path.join(root, 'one.txt'), 'changed original');
  const alias = path.join(root, 'unsupported-hard-link');
  await fs.link(path.join(root, 'one.txt'), alias);
  const cache = {};
  await assert.rejects(reconcilePaths(scan, [
    path.join(root, 'old'), path.join(root, 'new'), alias
  ], cache), /hard links/);
  assert.deepEqual(scan, original);
  assert.equal(cache.members, undefined);
  await fs.unlink(alias);
  assert.equal(await reconcilePaths(scan, [path.join(root, 'one.txt')], cache), true);
  assert.equal(scan.fileCount, 2);
});

test('watcher loss after a live batch starts restores the complete previous snapshot', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diskoryx-live-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'one.txt');
  await fs.writeFile(file, 'one');
  const scan = await scanFolder(root);
  const original = cloneSnapshot(scan);
  await fs.writeFile(file, 'updated');
  let checks = 0;
  await assert.rejects(reconcilePaths(scan, [file], {}, 0, () => ++checks === 1), /interrupted/);
  assert.deepEqual(scan, original);
});

test('failed MFT live batch preserves null-prototype extension maps and counted aliases', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diskoryx-live-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'one.txt');
  await fs.writeFile(file, 'changed');
  const builders = [createTreeBuilder(root, {}), createTreeBuilder(root, {})];
  for (const builder of builders) {
    builder.addRecord({ path: file, size: 3, modifiedMs: 1600000000000 });
    builder.addRecord({ path: path.join(root, 'alias.txt'), size: 3, sizeOwner: false, hardLinkCount: 2 });
  }
  const scan = await builders[0].finish({}, 10);
  const original = await builders[1].finish({}, 10);
  let checks = 0;
  await assert.rejects(reconcilePaths(scan, [file], {}, 0, () => ++checks === 1), /interrupted/);
  assert.deepEqual(scan, original);
  assert.equal(Object.getPrototypeOf(scan.folderNodes[0].extensionStats), null);
});
