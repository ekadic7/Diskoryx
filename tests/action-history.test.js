const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ActionHistory } = require('../src/main/action-history');

const chain = [{ path: 'C:\\scan\\one.txt', identity: '1:2', inode: '2', volume: '1', isDirectory: false }];

test('history save/load preserves identity and undo state without exposing native identity in list', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diskoryx-history-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'history.json');
  const history = new ActionHistory(file);
  await history.load();
  const entry = history.record('C:\\scan', chain[0].path, 'C:\\scan\\two.txt', chain);
  history.restored(entry, chain[0].path);
  history.record('C:\\scan', chain[0].path, null, chain);
  await history.save();
  const loaded = new ActionHistory(file);
  await loaded.load();
  assert.equal(loaded.entries[1].chain[0].identity, '1:2');
  assert.equal(loaded.entries[1].state, 'undone');
  assert.equal(loaded.list('C:\\scan')[0].canRestore, false);
  assert.equal(loaded.list('C:\\scan')[1].chain, undefined);
  assert.deepEqual((await fs.readdir(root)), ['history.json']);
});

test('history remains bounded and rejects malformed stored records', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diskoryx-history-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'history.json');
  const history = new ActionHistory();
  for (let index = 0; index < 600; index++) history.record('C:\\scan', chain[0].path, null, chain);
  assert.equal(history.entries.length, 500);
  await fs.writeFile(file, JSON.stringify({ version: 1, entries: [{ id: 'damaged' }] }));
  await assert.rejects(new ActionHistory(file).load(), /Damaged/);
});

test('history storage enforces the 16 MiB limit before loading and retains newest records when saving', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diskoryx-history-limit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'history.json');
  const oversized = await fs.open(file, 'w');
  await oversized.truncate(17 * 1024 * 1024);
  await oversized.close();
  await assert.rejects(new ActionHistory(file).load(), /16 MiB/);
  const history = new ActionHistory(file);
  history.record('C:\\scan', chain[0].path, null, chain).note = 'x'.repeat(9 * 1024 * 1024);
  const newest = history.record('C:\\scan', chain[0].path, null, chain);
  newest.note = 'y'.repeat(9 * 1024 * 1024);
  await history.save();
  assert.equal(history.entries.length, 1);
  assert.equal(history.entries[0].id, newest.id);
  assert((await fs.stat(file)).size <= 16 * 1024 * 1024);
});
