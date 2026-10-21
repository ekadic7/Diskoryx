const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { inspectFileAction } = require('../src/main/file-action-guard');
const { parseRecycleMetadata, findRecycledEntry } = require('../src/main/recycle-restore');

function metadata(original, version = 2) {
  const text = Buffer.from(original + '\0', 'utf16le');
  const data = Buffer.alloc(version === 1 ? 544 : 28 + text.length);
  data.writeBigUInt64LE(BigInt(version));
  data.writeBigUInt64LE(8n, 8);
  if (version === 2) data.writeUInt32LE(text.length / 2, 24);
  text.copy(data, version === 1 ? 24 : 28);
  return data;
}

test('Recycle Bin metadata supports bounded v1/v2 original paths without guessing formats', () => {
  for (const version of [1, 2]) {
    assert.deepEqual(parseRecycleMetadata(metadata('C:\\test\\život.txt', version)),
      { originalPath: 'C:\\test\\život.txt', bytes: '8' });
  }
  assert.throws(() => parseRecycleMetadata(Buffer.alloc(5)), /Truncated/);
  const invalid = metadata('C:\\test\\one');
  invalid.writeUInt32LE(0xffffffff, 24);
  assert.throws(() => parseRecycleMetadata(invalid), /length/);
  assert.throws(() => parseRecycleMetadata(metadata('relative')), /original/);
});

test('bin lookup requires both original path and exact identity, rejecting same-named replacement entries', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diskoryx-bin-lookup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const selected = path.join(root, 'selected');
  const bin = path.join(root, 'bin-fixture');
  await fs.mkdir(selected);
  await fs.mkdir(bin);
  const original = path.join(selected, 'one.txt');
  await fs.writeFile(original, 'original');
  const entry = { source: original, chain: await inspectFileAction(selected, original) };
  await fs.rename(original, path.join(bin, '$Rmatching.txt'));
  await fs.writeFile(path.join(bin, '$Imatching.txt'), metadata(original));
  await fs.writeFile(path.join(bin, '$Rreplacement.txt'), 'replacement');
  await fs.writeFile(path.join(bin, '$Ireplacement.txt'), metadata(original));
  const result = await findRecycledEntry(entry, bin);
  assert.equal(result.target, path.join(bin, '$Rmatching.txt'));
  await fs.unlink(path.join(bin, '$Rmatching.txt'));
  await assert.rejects(findRecycledEntry(entry, bin), /no longer/);
});

test('ambiguous original-path/identity matches are refused rather than picking a bin entry', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diskoryx-bin-lookup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  const original = path.join(root, 'original');
  await fs.writeFile(original, 'original');
  const entry = { source: original, chain: await inspectFileAction(root, original) };
  await fs.rename(original, path.join(bin, '$Rone'));
  await fs.link(path.join(bin, '$Rone'), path.join(bin, '$Rtwo'));
  await fs.writeFile(path.join(bin, '$Ione'), metadata(original));
  await fs.writeFile(path.join(bin, '$Itwo'), metadata(original));
  await assert.rejects(findRecycledEntry(entry, bin), /More than one/);
});
