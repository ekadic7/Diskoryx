const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { migrateUserData } = require('../src/main/user-data-migration');

test('migration copies saved history and local settings without changing the previous data', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diskoryx-data-migration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const previous = path.join(root, 'previous');
  const current = path.join(root, 'current');
  const previousStorage = path.join(previous, 'Local Storage', 'leveldb');
  await fs.mkdir(previousStorage, { recursive: true });
  await fs.writeFile(path.join(previous, 'action-history.json'), '{"entries":[]}');
  await fs.writeFile(path.join(previousStorage, 'CURRENT'), 'MANIFEST-000001');

  assert.equal(migrateUserData(previous, current), true);
  assert.equal(await fs.readFile(path.join(current, 'action-history.json'), 'utf8'), '{"entries":[]}');
  assert.equal(await fs.readFile(path.join(current, 'Local Storage', 'leveldb', 'CURRENT'), 'utf8'), 'MANIFEST-000001');
  assert.equal(await fs.readFile(path.join(previous, 'action-history.json'), 'utf8'), '{"entries":[]}');
  assert.equal(await fs.readFile(path.join(previousStorage, 'CURRENT'), 'utf8'), 'MANIFEST-000001');
});

test('migration never overwrites existing Diskoryx data or creates an empty profile', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diskoryx-data-migration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const previous = path.join(root, 'previous');
  const current = path.join(root, 'current');
  await fs.mkdir(path.join(previous, 'Local Storage'), { recursive: true });
  await fs.writeFile(path.join(previous, 'action-history.json'), 'old');
  await fs.mkdir(current);
  await fs.writeFile(path.join(current, 'action-history.json'), 'new');
  assert.equal(migrateUserData(previous, current), false);
  assert.equal(await fs.readFile(path.join(current, 'action-history.json'), 'utf8'), 'new');

  const absent = path.join(root, 'absent');
  assert.equal(migrateUserData(absent, path.join(root, 'empty-target')), false);
  assert.equal(await fs.stat(path.join(root, 'empty-target')).then(() => true, () => false), false);
});
