const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { inspectCopyTree, verifyCopyTree } = require('../src/main/copy-receipt');

test('copy receipt refuses changed bytes, additional descendants and replacement identities', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diskoryx-receipt-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = path.join(root, 'folder');
  await fs.mkdir(folder);
  const file = path.join(folder, 'one.txt');
  await fs.writeFile(file, 'one');
  const receipt = await inspectCopyTree(folder);
  await verifyCopyTree(folder, receipt);
  await fs.writeFile(path.join(folder, 'added.txt'), 'user file');
  await assert.rejects(verifyCopyTree(folder, receipt), /gained\/lost|changed/);
  await fs.unlink(path.join(folder, 'added.txt'));
  await fs.writeFile(file, 'two');
  await assert.rejects(verifyCopyTree(folder, receipt), /changed/);
  await fs.rename(file, path.join(root, 'saved.txt'));
  await fs.writeFile(file, 'one');
  await assert.rejects(verifyCopyTree(folder, receipt), /changed/);
});
