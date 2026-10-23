const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { HASH_CHUNK_BYTES, SAMPLE_CHUNK_BYTES, isUserFilePath, findDuplicates, hashFile, runBounded } = require('../src/main/duplicates');

async function tempFolder(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diskoryx-dup-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('identical content under different names is one group; same name and size with other content is not', async t => {
  const dir = await tempFolder(t);
  await fs.writeFile(path.join(dir, 'a.bin'), 'same-content');
  await fs.writeFile(path.join(dir, 'b-copy.bin'), 'same-content');
  await fs.writeFile(path.join(dir, 'c.bin'), 'other-stuff');
  await fs.mkdir(path.join(dir, 'sub'));
  await fs.writeFile(path.join(dir, 'sub', 'a.bin'), 'xxxxxxxxxxx');
  const result = await findDuplicates(dir);
  assert.equal(result.success, true);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].copyCount, 2);
  assert.equal(result.groups[0].duplicateLogicalBytes, 'same-content'.length);
  assert.deepEqual(result.groups[0].paths.map(p => path.basename(p)), ['a.bin', 'b-copy.bin']);
});

test('same size and name with different content is not reported', async t => {
  const dir = await tempFolder(t);
  await fs.mkdir(path.join(dir, 'x'));
  await fs.mkdir(path.join(dir, 'y'));
  await fs.writeFile(path.join(dir, 'x', 'report.txt'), 'AAAA');
  await fs.writeFile(path.join(dir, 'y', 'report.txt'), 'BBBB');
  const result = await findDuplicates(dir);
  assert.equal(result.groups.length, 0);
  assert.equal(result.candidateFileCount, 2);
});

test('single-read and streamed hashing produce the same digest at the chunk boundary', async t => {
  const dir = await tempFolder(t);
  const boundary = Buffer.alloc(HASH_CHUNK_BYTES, 9);
  const justOver = Buffer.alloc(HASH_CHUNK_BYTES + 1, 9);
  await fs.writeFile(path.join(dir, 'boundary.bin'), boundary);
  await fs.writeFile(path.join(dir, 'over.bin'), justOver);
  const expected = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
  assert.equal(await hashFile(path.join(dir, 'boundary.bin')), expected(boundary));
  assert.equal(await hashFile(path.join(dir, 'over.bin')), expected(justOver));
});

test('identical empty files and identical large files are confirmed by streamed hash', async t => {
  const dir = await tempFolder(t);
  await fs.writeFile(path.join(dir, 'empty1'), '');
  await fs.writeFile(path.join(dir, 'empty2'), '');
  const big = Buffer.alloc(HASH_CHUNK_BYTES * 2 + 17, 7);
  await fs.writeFile(path.join(dir, 'big1.bin'), big);
  await fs.writeFile(path.join(dir, 'big2.bin'), big);
  const result = await findDuplicates(dir);
  assert.equal(result.groups.length, 2);
  const emptyGroup = result.groups.find(group => group.sizeBytes === 0);
  const bigGroup = result.groups.find(group => group.sizeBytes === big.length);
  assert.equal(emptyGroup.duplicateLogicalBytes, 0);
  assert.equal(bigGroup.digest, crypto.createHash('sha256').update(big).digest('hex'));
  assert.equal(await hashFile(path.join(dir, 'big1.bin')), bigGroup.digest);
});

test('hard links to one NTFS record count as one copy and do not promise extra space', async t => {
  const dir = await tempFolder(t);
  await fs.writeFile(path.join(dir, 'original.dat'), 'shared-bytes');
  await fs.link(path.join(dir, 'original.dat'), path.join(dir, 'link.dat'));
  const result = await findDuplicates(dir);
  assert.equal(result.groups.length, 0);
  assert.equal(result.duplicateLogicalBytes, 0);
});

test('hard link plus an independent copy reclaims exactly one copy of the bytes', async t => {
  const dir = await tempFolder(t);
  await fs.writeFile(path.join(dir, 'a.dat'), 'twelve-bytes');
  await fs.link(path.join(dir, 'a.dat'), path.join(dir, 'a-link.dat'));
  await fs.writeFile(path.join(dir, 'b.dat'), 'twelve-bytes');
  const result = await findDuplicates(dir);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].copyCount, 2);
  assert.equal(result.duplicateLogicalBytes, 'twelve-bytes'.length);
});

test('a file that disappears after collection is reported as unverified, never as a duplicate', async t => {
  const dir = await tempFolder(t);
  await fs.writeFile(path.join(dir, 'keep.txt'), 'dup-data');
  const gonePath = path.join(dir, 'gone.txt');
  await fs.writeFile(gonePath, 'dup-data');
  let removed = false;
  const result = await findDuplicates(dir, {
    onProgress(progress) {
      if (progress.stage === 'scan' && progress.filesScanned >= 2 && !removed) {
        fsSync.rmSync(gonePath);
        removed = true;
      }
    }
  });
  assert.equal(result.groups.length, 0);
  assert.equal(result.candidateFileCount, 2);
  assert.deepEqual(result.unverified, [{ path: gonePath, reason: 'missing' }]);
});

test('a file changed since collection is rejected before its contents are hashed', async t => {
  const dir = await tempFolder(t);
  const filePath = path.join(dir, 'file.dat');
  await fs.writeFile(filePath, 'before');
  const { collectFiles } = require('../src/main/duplicates');
  const { files } = await collectFiles(dir);
  const { verifyUnchanged } = require('../src/main/duplicates');
  await new Promise(resolve => setTimeout(resolve, 5));
  await fs.writeFile(filePath, 'after!');
  await assert.rejects(hashFile(filePath, undefined, files[0]), { code: 'DUPLICATE_CHANGED' });
  assert.equal(await verifyUnchanged(files[0]), false);
});

test('unreadable candidate files are unverified and cannot form duplicate groups', async t => {
  const dir = await tempFolder(t);
  const readable = path.join(dir, 'readable.bin');
  const blocked = path.join(dir, 'blocked.bin');
  await fs.writeFile(readable, 'same bytes');
  await fs.writeFile(blocked, 'same bytes');
  const originalOpen = fsp.open;
  fsp.open = async (filePath, ...args) => {
    if (path.resolve(filePath) === blocked) {
      throw Object.assign(new Error('Access denied'), { code: 'EACCES' });
    }
    return originalOpen(filePath, ...args);
  };
  let result;
  try {
    result = await findDuplicates(dir);
  } finally {
    fsp.open = originalOpen;
  }
  assert.equal(result.groups.length, 0);
  assert.deepEqual(result.unverified, [{ path: blocked, reason: 'unreadable' }]);
});

test('missing and non-directory roots fail explicitly', async t => {
  const dir = await tempFolder(t);
  const filePath = path.join(dir, 'file.txt');
  await fs.writeFile(filePath, 'content');
  assert.match((await findDuplicates(path.join(dir, 'missing'))).error, /Unable to access folder/);
  assert.match((await findDuplicates(filePath)).error, /not a regular folder/);
});

test('cancel stops hashing with AbortError and returns no groups', async t => {
  const dir = await tempFolder(t);
  for (let i = 0; i < 20; i++) await fs.writeFile(path.join(dir, `f${i}.txt`), 'same');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(findDuplicates(dir, { signal: controller.signal }), { name: 'AbortError' });
});

test('concurrency is bounded and every job runs', async () => {
  let inFlight = 0;
  let peak = 0;
  const seen = [];
  await runBounded([1, 2, 3, 4, 5, 6, 7, 8, 9], 3, async (value) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise(resolve => setTimeout(resolve, 5));
    seen.push(value);
    inFlight--;
  });
  assert.equal(peak, 3);
  assert.deepEqual(seen.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('symbolic links are skipped and not followed', async t => {
  const dir = await tempFolder(t);
  const outside = await tempFolder(t);
  await fs.writeFile(path.join(outside, 'target.txt'), 'linked-data');
  await fs.writeFile(path.join(dir, 'real.txt'), 'linked-data');
  try {
    await fs.symlink(path.join(outside, 'target.txt'), path.join(dir, 'link.txt'));
  } catch {
    t.skip('symlink creation not permitted on this system');
    return;
  }
  const result = await findDuplicates(dir);
  assert.equal(result.groups.length, 0);
  assert.equal(result.skippedCount, 1);
});

test('bounded candidate validation keeps input order, skips links and counts every candidate once', async t => {
  const dir = await tempFolder(t);
  const outside = await tempFolder(t);
  const names = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt', 'g.txt', 'h.txt', 'i.txt', 'j.txt'];
  const candidateFiles = [];
  for (const name of names) {
    const filePath = path.join(dir, name);
    await fs.writeFile(filePath, 'same');
    candidateFiles.push({ path: filePath, rawSize: 4 });
  }
  const linkedPath = path.join(dir, 'linked.txt');
  await fs.writeFile(path.join(outside, 'target.txt'), 'same');
  try {
    await fs.symlink(path.join(outside, 'target.txt'), linkedPath);
    candidateFiles.push({ path: linkedPath, rawSize: 4 });
  } catch {
    t.skip('symlink creation not permitted on this system');
    return;
  }
  const result = await findDuplicates(dir, { candidateFiles });
  assert.equal(result.groups.length, 1);
  assert.deepEqual(result.groups[0].paths.map(p => path.basename(p)).sort(), names);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.filesScanned, names.length + 1);
});

test('cached inventory eliminates unique sizes before filesystem metadata reads or directory enumeration', async t => {
  const dir = await tempFolder(t);
  const candidateFiles = [];
  for (const [name, contents] of [['one', 'same'], ['two', 'same'], ['unique', 'unique size']]) {
    const filePath = path.join(dir, name);
    await fs.writeFile(filePath, contents);
    candidateFiles.push({ path: filePath, rawSize: Buffer.byteLength(contents) });
  }
  const originalLstat = fsp.lstat;
  const originalReaddir = fsp.readdir;
  let uniqueReads = 0;
  fsp.lstat = async (filePath, ...args) => {
    if (filePath === candidateFiles[2].path) uniqueReads++;
    return originalLstat(filePath, ...args);
  };
  fsp.readdir = async () => { throw new Error('Cached inventory must not enumerate directories.'); };
  let result;
  try {
    result = await findDuplicates(dir, { candidateFiles });
  } finally {
    fsp.lstat = originalLstat;
    fsp.readdir = originalReaddir;
  }
  assert.equal(uniqueReads, 0);
  assert.equal(result.filesScanned, 3);
  assert.equal(result.candidateFileCount, 2);
  assert.equal(result.groups.length, 1);
});

test('different large samples avoid all full-file hashing and read at most 192 KiB per candidate', async t => {
  const dir = await tempFolder(t);
  const size = HASH_CHUNK_BYTES * 4;
  for (let i = 0; i < 6; i++) {
    await fs.writeFile(path.join(dir, `${i}.bin`), Buffer.alloc(size, i));
  }
  const result = await findDuplicates(dir);
  assert.equal(result.candidateFileCount, 6);
  assert.equal(result.fullHashFileCount, 0);
  assert.equal(result.fullHashBytesRead, 0);
  assert.equal(result.sampleBytesRead, 6 * 3 * SAMPLE_CHUNK_BYTES);
  assert.ok(result.sampleBytesRead < size * 6 * 0.05, 'read under 5% of the candidate bytes');
  assert.equal(result.groups.length, 0);
});

test('matching samples never prove duplicates: unsampled differences are rejected by the full hash', async t => {
  const dir = await tempFolder(t);
  const contents = Buffer.alloc(HASH_CHUNK_BYTES * 2, 9);
  await fs.writeFile(path.join(dir, 'original'), contents);
  await fs.writeFile(path.join(dir, 'copy'), contents);
  contents[SAMPLE_CHUNK_BYTES + 17] = 3;
  await fs.writeFile(path.join(dir, 'different'), contents);
  const result = await findDuplicates(dir);
  assert.equal(result.fullHashFileCount, 3);
  assert.equal(result.fullHashBytesRead, contents.length * 3);
  assert.equal(result.groups.length, 1);
  assert.deepEqual(result.groups[0].paths.map(filePath => path.basename(filePath)), ['copy', 'original']);
});

test('changes between sampling and full hashing remain unverified', async t => {
  const dir = await tempFolder(t);
  const size = HASH_CHUNK_BYTES;
  const changed = path.join(dir, 'changed');
  await fs.writeFile(changed, Buffer.alloc(size, 1));
  await fs.writeFile(path.join(dir, 'copy'), Buffer.alloc(size, 1));
  const result = await findDuplicates(dir, {
    onProgress(progress) {
      if (progress.stage === 'sample' && progress.completed === progress.total) {
        fsSync.writeFileSync(changed, Buffer.alloc(size + 1, 2));
      }
    }
  });
  assert.equal(result.groups.length, 0);
  assert.deepEqual(result.unverified, [{ path: changed, reason: 'changed' }]);
});

test('cancellation during sampling stops before full-file hashing', async t => {
  const dir = await tempFolder(t);
  for (let i = 0; i < 3; i++) await fs.writeFile(path.join(dir, `${i}`), Buffer.alloc(HASH_CHUNK_BYTES, 1));
  const controller = new AbortController();
  let fullHashStarted = false;
  await assert.rejects(findDuplicates(dir, {
    signal: controller.signal,
    concurrency: 1,
    onProgress(progress) {
      if (progress.stage === 'sample') controller.abort();
      if (progress.stage === 'hash') fullHashStarted = true;
    }
  }), { name: 'AbortError' });
  assert.equal(fullHashStarted, false);
});

test('user-file scope matches whole system directories, not similarly named user folders or files', () => {
  const root = path.parse(process.cwd()).root;
  for (const relative of ['wInDoWs\\Installer\\a.msi', 'Program Files\\App\\a.exe',
    'Program Files (x86)\\App\\a.exe', 'ProgramData\\a', 'AppData\\cache',
    'Users\\Example\\aPpDaTa\\Local\\cache', '$Recycle.Bin\\a', 'System Volume Information\\a']) {
    assert.equal(isUserFilePath(root, path.join(root, relative)), false, relative);
  }
  for (const relative of ['Users\\Example\\Documents\\Windows\\file.txt',
    'Users\\Example\\Documents\\AppData\\notes.txt', 'Users\\Example\\Downloads\\setup.msi',
    'Windows-backup\\notes.txt', 'Program Files.txt', 'Photos\\a.jpg']) {
    assert.equal(isUserFilePath(root, path.join(root, relative)), true, relative);
  }
});
