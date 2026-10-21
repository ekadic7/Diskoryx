const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspectFileAction } = require('../src/main/file-action-guard');
const { copyWithHandles } = require('../src/main/windows-copy');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const vm = require('node:vm');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diskoryx-copy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  await fs.mkdir(source);
  await fs.mkdir(destination);
  const target = path.join(source, 'file.txt');
  await fs.writeFile(target, 'original');
  return {
    root, source, destination, target,
    async request(item = target) {
      return {
        root: source, target: item, name: path.basename(item), destination,
        entries: await inspectFileAction(source, item),
        destinationEntries: await inspectFileAction(root, destination)
      };
    }
  };
}

test('native copy streams a file with no overwrite and leaves source unchanged', async t => {
  const f = await fixture(t);
  const result = await copyWithHandles(await f.request());
  assert.equal(result.success, true);
  assert.equal(await fs.readFile(result.path, 'utf8'), 'original');
  assert.equal(await fs.readFile(f.target, 'utf8'), 'original');
  await assert.rejects(copyWithHandles(await f.request()), /already exists/);
  assert.deepEqual(await fs.readdir(f.destination), ['file.txt']);
});

test('native Move relocates files and populated folders with no overwrite and permits moving back', async t => {
  const f = await fixture(t);
  const request = await f.request();
  request.move = true;
  const original = await fs.stat(f.target, { bigint: true });
  const moved = await copyWithHandles(request);
  assert.equal(moved.moved, true);
  assert.equal((await fs.stat(moved.path, { bigint: true })).ino, original.ino);
  await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
  assert.equal(await fs.readFile(moved.path, 'utf8'), 'original');
  const back = await copyWithHandles({
    root: f.destination, target: moved.path, name: 'file.txt', destination: f.source, move: true,
    entries: await inspectFileAction(f.destination, moved.path),
    destinationEntries: await inspectFileAction(f.root, f.source)
  });
  assert.equal(await fs.readFile(back.path, 'utf8'), 'original');
  const folder = path.join(f.source, 'nested');
  await fs.mkdir(path.join(folder, 'empty'), { recursive: true });
  await fs.writeFile(path.join(folder, 'child.txt'), 'child');
  const folderRequest = await f.request(folder);
  const destination = await copyWithHandles({ ...folderRequest, move: true });
  assert.equal(await fs.readFile(path.join(destination.path, 'child.txt'), 'utf8'), 'child');
  await assert.rejects(fs.stat(folder), { code: 'ENOENT' });
});

test('native Move refuses occupied destinations, replaced identities, self descendants and precommit cancellation', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.destination, 'file.txt'), 'keep');
  await assert.rejects(copyWithHandles({ ...await f.request(), move: true }), /exists/);
  assert.equal(await fs.readFile(f.target, 'utf8'), 'original');
  await fs.unlink(path.join(f.destination, 'file.txt'));
  const controller = new AbortController();
  await assert.rejects(copyWithHandles({ ...await f.request(), move: true }, {
    signal: controller.signal, beforeCommit: () => controller.abort()
  }));
  assert.equal(await fs.readFile(f.target, 'utf8'), 'original');
  assert.deepEqual(await fs.readdir(f.destination), []);
  const folder = path.join(f.source, 'folder');
  const inside = path.join(folder, 'inside');
  await fs.mkdir(inside, { recursive: true });
  await fs.writeFile(path.join(folder, 'keep.txt'), 'keep');
  const descendant = { ...await f.request(folder), destination: inside, move: true,
    destinationEntries: await inspectFileAction(f.root, inside) };
  await assert.rejects(copyWithHandles(descendant), /itself|descendants/);
  assert.equal(await fs.readFile(path.join(folder, 'keep.txt'), 'utf8'), 'keep');
  const replaced = { ...await f.request(), move: true };
  await fs.rename(f.target, path.join(f.source, 'old.txt'));
  await fs.writeFile(f.target, 'replacement');
  await assert.rejects(copyWithHandles(replaced), /identity|changed/i);
});

test('cross-volume transfer pipeline verifies bytes before source retirement and preserves sources on refusal', async t => {
  const build = await fs.mkdtemp(path.join(os.tmpdir(), 'diskoryx-move-pipeline-'));
  t.after(() => fs.rm(build, { recursive: true, force: true }));
  const native = path.join(__dirname, '..', 'native', 'file-actions');
  const source = await fs.readFile(path.join(native, 'Copy.cs'), 'utf8');
  const condition = 'sourceInfo.VolumeSerialNumber == destinationInfo.VolumeSerialNumber';
  assert.equal(source.split(condition).length, 2);
  // This fixture exercises copy/verify/retire on one physical volume, not an actual second disk.
  await fs.writeFile(path.join(build, 'Copy.cs'), source.replace(condition, 'false'));
  const helper = path.join(build, 'fixture-actions.exe');
  await promisify(execFile)(path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), [
    '/nologo', '/target:exe', '/platform:x64', '/optimize+', '/reference:System.Web.Extensions.dll',
    `/out:${helper}`, path.join(native, 'Program.cs'), path.join(build, 'Copy.cs'), path.join(native, 'Restore.cs')
  ], { windowsHide: true });
  const module = { exports: {} };
  vm.runInNewContext(await fs.readFile(path.join(__dirname, '..', 'src', 'main', 'windows-copy.js'), 'utf8'), {
    module, require: name => name === './windows-rename' ? { getFileActionHelperPath: () => helper } : require(name)
  });
  const move = module.exports.copyWithHandles;
  await t.test('files and populated folders finish with verified destination bytes and no source', async t => {
    const f = await fixture(t);
    const folder = path.join(f.source, 'nested');
    await fs.mkdir(path.join(folder, 'empty'), { recursive: true });
    await fs.writeFile(path.join(folder, 'child.txt'), 'child bytes');
    for (const item of [f.target, folder]) {
      const result = await move({ ...await f.request(item), move: true });
      assert.equal(result.moved, true);
      await assert.rejects(fs.stat(item), { code: 'ENOENT' });
      const target = item === folder ? path.join(result.path, 'child.txt') : result.path;
      assert.equal(await fs.readFile(target, 'utf8'), item === folder ? 'child bytes' : 'original');
    }
  });
  await t.test('cancel and unsupported hard links preserve every source and publish nothing', async t => {
    const f = await fixture(t);
    const file = await fs.open(f.target, 'w');
    await file.truncate(32 * 1024 * 1024);
    await file.close();
    const controller = new AbortController();
    const result = await move({ ...await f.request(), move: true }, {
      signal: controller.signal, onProgress: () => controller.abort()
    });
    assert.equal(result.cancelled, true);
    assert.equal((await fs.stat(f.target)).size, 32 * 1024 * 1024);
    assert.deepEqual(await fs.readdir(f.destination), []);
    await fs.link(f.target, path.join(f.source, 'alias.txt'));
    await assert.rejects(move({ ...await f.request(), move: true }), /hard-linked/);
    assert.deepEqual(await fs.readdir(f.destination), []);
    assert.equal((await fs.stat(f.target)).nlink, 2);
  });
  await t.test('source cleanup failure keeps a complete destination and reports uncertain completion', async t => {
    const f = await fixture(t);
    await fs.chmod(f.target, 0o444);
    try {
      await assert.rejects(move({ ...await f.request(), move: true }), error =>
        error.outcomeUncertain === true && /Verified copy remains/.test(error.message));
    } finally { await fs.chmod(f.target, 0o666); }
    assert.equal(await fs.readFile(f.target, 'utf8'), 'original');
    assert.equal(await fs.readFile(path.join(f.destination, 'file.txt'), 'utf8'), 'original');
  });
  await t.test('a source child arriving during transfer is retained and prevents publication', async t => {
    const f = await fixture(t);
    const folder = path.join(f.source, 'changing-folder');
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'old.txt'), 'old');
    const large = await fs.open(path.join(folder, 'large.bin'), 'w');
    await large.truncate(32 * 1024 * 1024);
    await large.close();
    await assert.rejects(move({ ...await f.request(folder), move: true }, {
      onProgress: () => { fsSync.writeFileSync(path.join(folder, 'new.txt'), 'new'); }
    }), /contents changed/);
    assert.equal(await fs.readFile(path.join(folder, 'new.txt'), 'utf8'), 'new');
    assert.equal(await fs.readFile(path.join(folder, 'old.txt'), 'utf8'), 'old');
    assert.deepEqual(await fs.readdir(f.destination), []);
  });
});

test('native copy copies a nested folder, empty directories and Unicode files', async t => {
  const f = await fixture(t);
  const folder = path.join(f.source, 'folder');
  await fs.mkdir(path.join(folder, 'empty'), { recursive: true });
  await fs.writeFile(path.join(folder, 'život.txt'), 'contents');
  const result = await copyWithHandles(await f.request(folder));
  assert.equal(result.success, true);
  assert.equal(result.entries, 3);
  assert.equal(await fs.readFile(path.join(result.path, 'život.txt'), 'utf8'), 'contents');
  assert.deepEqual(await fs.readdir(path.join(result.path, 'empty')), []);
});

test('copy refuses descendant junctions and replacement identities without publishing', async t => {
  const f = await fixture(t);
  const request = await f.request();
  await fs.rename(f.target, path.join(f.source, 'kept.txt'));
  await fs.writeFile(f.target, 'replacement');
  await assert.rejects(copyWithHandles(request), /changed/);
  const folder = path.join(f.source, 'folder');
  await fs.mkdir(folder);
  await fs.symlink(f.destination, path.join(folder, 'redirect'), 'junction');
  try { await assert.rejects(copyWithHandles(await f.request(folder)), /links and junctions/); }
  finally { await fs.unlink(path.join(folder, 'redirect')); }
  assert.deepEqual(await fs.readdir(f.destination), []);
});

test('copy cancel removes only its staging output and never publishes a partial file', async t => {
  const f = await fixture(t);
  const file = await fs.open(f.target, 'w');
  await file.truncate(32 * 1024 * 1024);
  await file.close();
  const controller = new AbortController();
  const result = await copyWithHandles(await f.request(), {
    signal: controller.signal, onProgress: () => controller.abort()
  });
  assert.equal(result.cancelled, true);
  assert.deepEqual(await fs.readdir(f.destination), []);
  assert.equal((await fs.stat(f.target)).size, 32 * 1024 * 1024);
});

test('copy refuses a destination introduced after readiness and pins parent paths', async t => {
  const f = await fixture(t);
  await assert.rejects(copyWithHandles(await f.request(), { beforeCommit: async () => {
    await assert.rejects(fs.rename(f.destination, path.join(f.root, 'moved')));
    await fs.writeFile(path.join(f.destination, 'file.txt'), 'keep');
  } }), /already exists|already|exists/);
  assert.equal(await fs.readFile(path.join(f.destination, 'file.txt'), 'utf8'), 'keep');
  assert.deepEqual(await fs.readdir(f.destination), ['file.txt']);
});

test('copy refuses alternate data streams instead of silently dropping their contents', async t => {
  const f = await fixture(t);
  await fs.writeFile(`${f.target}:metadata`, 'important side-stream');
  await assert.rejects(copyWithHandles(await f.request()), /alternate data streams/);
  assert.equal(await fs.readFile(`${f.target}:metadata`, 'utf8'), 'important side-stream');
  assert.deepEqual(await fs.readdir(f.destination), []);
});

test('native copy accepts exactly 4096 entries and refuses 4097 before creating staging output', async t => {
  const f = await fixture(t);
  const folder = path.join(f.source, 'bounded-folder');
  await fs.mkdir(folder);
  for (let offset = 0; offset < 4096; offset += 32) {
    await Promise.all(Array.from({ length: 32 }, (_, index) =>
      fs.mkdir(path.join(folder, `empty-${offset + index}`))));
  }
  await assert.rejects(copyWithHandles(await f.request(folder)), /4096 entries/);
  assert.deepEqual(await fs.readdir(f.destination), [], 'oversized source must not create staging');
  await fs.rmdir(path.join(folder, 'empty-4095'));
  const result = await copyWithHandles(await f.request(folder));
  assert.equal(result.success, true);
  assert.equal(result.entries, 4096);
  assert.equal((await fs.readdir(result.path)).length, 4095);
});
