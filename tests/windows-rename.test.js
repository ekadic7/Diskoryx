const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const fsSync = require('node:fs');
const { createRequire } = require('node:module');
const { spawn, execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { inspectFileAction } = require('../src/main/file-action-guard');
const {
  getFileActionHelperPath, renameWithHandles, createFolderWithHandles, recycleWithPinnedAncestors
} = require('../src/main/windows-rename');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diskoryx-native-rename-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const parent = path.join(root, 'scan');
  await fs.mkdir(parent);
  const target = path.join(parent, 'original.txt');
  await fs.writeFile(target, 'original content');
  const entries = await inspectFileAction(parent, target);
  return { root, parent, target, entries };
}

test('native rename confirms verified standard-user rights before opening the commit gate', async t => {
  const f = await fixture(t);
  const child = spawn(getFileActionHelperPath(), [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code));
  });

  // EOF instead of commit must leave the target untouched after reporting rights.
  child.stdin.end(JSON.stringify({
    root: f.parent, target: f.target, newName: 'not-committed.txt', entries: f.entries, mode: 'rename'
  }) + '\n');
  assert.equal(await closed, 0, stderr || stdout);
  assert.deepEqual(stdout.trim().split(/\r?\n/).map(line => JSON.parse(line)),
    [{ ready: true, renameUsesStandardRights: true }]);
  assert.equal(await fs.readFile(f.target, 'utf8'), 'original content');
});

test('Create folder uses ordinary rights and creates an empty child without overwrite', async t => {
  const f = await fixture(t);
  const created = await createFolderWithHandles(f.parent, f.parent, 'new folder', f.entries.slice(0, -1));
  const createdPath = path.join(f.parent, 'new folder');
  assert.equal(created.path, createdPath);
  assert.deepEqual(await fs.readdir(createdPath), []);
  await assert.rejects(createFolderWithHandles(f.parent, f.parent, 'new folder', f.entries.slice(0, -1)),
    /already exists|Windows error 183/i);
  assert.deepEqual(await fs.readdir(createdPath), []);
});

test('Create folder refuses invalid names, replaced parents and reparse-point ancestors', async t => {
  const f = await fixture(t);
  for (const name of ['.', '..', 'bad/name', 'NUL.txt', ' trailing ', 'folder.']) {
    await assert.rejects(createFolderWithHandles(f.parent, f.parent, name, f.entries.slice(0, -1)));
  }
  const parentChain = f.entries.slice(0, -1);
  await fs.rename(f.parent, path.join(f.root, 'old-parent'));
  await fs.mkdir(f.parent);
  await assert.rejects(createFolderWithHandles(f.parent, f.parent, 'refused', parentChain), /changed/i);
  await fs.rmdir(f.parent);
  await fs.symlink(path.join(f.root, 'old-parent'), f.parent, 'junction');
  try {
    await assert.rejects(inspectFileAction(f.root, f.parent), /links or junctions/);
    assert.deepEqual(await fs.readdir(path.join(f.root, 'old-parent')), ['original.txt']);
  } finally { await fs.unlink(f.parent); }
});

test('Create folder pins parent identities until commit and never replaces a competing item', async t => {
  const f = await fixture(t);
  const entries = f.entries.slice(0, -1);
  await assert.rejects(createFolderWithHandles(f.parent, f.parent, 'occupied', entries, async () => {
    await fs.mkdir(path.join(f.parent, 'occupied'));
  }), /already exists|Windows error 183/i);
  assert.deepEqual(await fs.readdir(path.join(f.parent, 'occupied')), []);
  const locked = await createFolderWithHandles(f.parent, f.parent, 'locked', entries, async () => {
    await assert.rejects(fs.rename(f.parent, path.join(f.root, 'renamed-parent')));
  });
  assert.equal(locked.path, path.join(f.parent, 'locked'));
  assert.deepEqual(await fs.readdir(locked.path), []);
  await fs.rename(f.parent, path.join(f.root, 'unlocked-parent'));
});

test('an older helper cannot authorize Rename without confirming standard-user rights', async () => {
  const root = path.join(__dirname, '..', 'src', 'main');
  const localRequire = createRequire(path.join(root, 'windows-rename.js'));
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let input = '';
  let killed = false;
  child.stdin.on('data', chunk => {
    input += chunk;
    if (input.includes('\n')) queueMicrotask(() => child.stdout.write('{"ready":true}\n'));
  });
  child.kill = () => {
    killed = true;
    child.stdout.end();
    queueMicrotask(() => child.emit('close', 1, null));
  };
  const context = {
    module: { exports: {} }, __dirname: root, process, setTimeout, clearTimeout,
    require(name) {
      if (name === 'node:fs') return { existsSync: () => true };
      if (name === 'node:child_process') return { spawn: () => child };
      return localRequire(name);
    }
  };
  vm.runInNewContext(fsSync.readFileSync(path.join(root, 'windows-rename.js'), 'utf8'), context);
  await assert.rejects(context.module.exports.renameWithHandles('C:\\scan', 'C:\\scan\\one', 'two', [],
    () => assert.fail('must not authorize an older helper')), /did not confirm standard-user Rename rights/);
  assert.equal(killed, true);
  assert.doesNotMatch(input, /\ncommit\n/);
});

test('Rename refuses an administrator-only folder without an elevated fallback', async t => {
  const f = await fixture(t);
  const icacls = path.join(process.env.WINDIR, 'System32', 'icacls.exe');
  try {
    execFileSync(icacls, [f.parent, '/inheritance:r', '/grant:r', '*S-1-5-32-544:F', '*S-1-5-18:F'],
      { windowsHide: true, stdio: 'pipe' });
    await assert.rejects(renameWithHandles(f.parent, f.target, 'refused.txt', f.entries),
      /standard-user access.*no elevated fallback.*Windows error 5/);
  } finally {
    // Only this fixture's owner-controlled ACL is changed; restore it before cleanup.
    execFileSync(icacls, [f.parent, '/reset'], { windowsHide: true, stdio: 'pipe' });
  }
  assert.equal(await fs.readFile(f.target, 'utf8'), 'original content');
  await assert.rejects(fs.stat(path.join(f.parent, 'refused.txt')), { code: 'ENOENT' });
});

test('native rename pins target and ancestors until commit and releases all locks afterward', async t => {
  const f = await fixture(t);
  await renameWithHandles(f.parent, f.target, 'renamed.txt', f.entries, async () => {
    await assert.rejects(fs.rename(f.parent, path.join(f.root, 'replaced-scan')));
    await assert.rejects(fs.rename(f.target, path.join(f.parent, 'replaced.txt')));
    await assert.rejects(fs.writeFile(f.target, 'unexpected replacement'));
    assert.equal(await fs.readFile(f.target, 'utf8'), 'original content');
  });
  assert.equal(await fs.readFile(path.join(f.parent, 'renamed.txt'), 'utf8'), 'original content');
  await fs.rename(f.parent, path.join(f.root, 'unlocked-scan'));
});

test('a destination created after helper readiness is never overwritten', async t => {
  const f = await fixture(t);
  const destination = path.join(f.parent, 'occupied.txt');
  await assert.rejects(renameWithHandles(f.parent, f.target, 'occupied.txt', f.entries, async () => {
    await fs.writeFile(destination, 'keep destination');
  }), /no-replace rename/);
  assert.equal(await fs.readFile(destination, 'utf8'), 'keep destination');
  assert.equal(await fs.readFile(f.target, 'utf8'), 'original content');
  await fs.rename(f.target, path.join(f.parent, 'after-failure.txt'));
});

test('replaced leaf identity before native locking is rejected', async t => {
  const f = await fixture(t);
  await fs.rename(f.target, path.join(f.parent, 'old.txt'));
  await fs.writeFile(f.target, 'replacement');
  await assert.rejects(renameWithHandles(f.parent, f.target, 'new.txt', f.entries), /changed/);
  assert.equal(await fs.readFile(f.target, 'utf8'), 'replacement');
  assert.equal(await fs.readFile(path.join(f.parent, 'old.txt'), 'utf8'), 'original content');
});

test('junction substitution before native locking cannot redirect rename outside the scan', async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'original.txt'), 'outside content');
  await fs.rename(f.parent, path.join(f.root, 'saved-scan'));
  await fs.symlink(outside, f.parent, 'junction');
  try {
    await assert.rejects(renameWithHandles(f.parent, f.target, 'new.txt', f.entries), /junctions/);
    assert.equal(await fs.readFile(path.join(outside, 'original.txt'), 'utf8'), 'outside content');
    await assert.rejects(fs.stat(path.join(outside, 'new.txt')), { code: 'ENOENT' });
  } finally {
    await fs.unlink(f.parent);
  }
});

test('aborted native readiness keeps source intact and releases path locks', async t => {
  const f = await fixture(t);
  await assert.rejects(renameWithHandles(f.parent, f.target, 'new.txt', f.entries, () => {
    throw new Error('The scan changed');
  }), /scan changed/);
  assert.equal(await fs.readFile(f.target, 'utf8'), 'original content');
  await fs.rename(f.parent, path.join(f.root, 'unlocked-scan'));
});

test('native identity checks include the volume and reject incompatible open writers', async t => {
  const f = await fixture(t);
  const wrongVolume = f.entries.map(entry => ({ ...entry, volume: '0' }));
  await assert.rejects(renameWithHandles(f.parent, f.target, 'new.txt', wrongVolume), /changed/);
  const writer = await fs.open(f.target, 'r+');
  try {
    await assert.rejects(renameWithHandles(f.parent, f.target, 'new.txt', f.entries), /Unable to lock/);
    assert.equal(await fs.readFile(f.target, 'utf8'), 'original content');
  } finally {
    await writer.close();
  }
  await renameWithHandles(f.parent, f.target, 'after-writer.txt', f.entries);
  assert.equal(await fs.readFile(path.join(f.parent, 'after-writer.txt'), 'utf8'), 'original content');
});

test('Unicode and extensionless names survive the native stdin protocol', async t => {
  const f = await fixture(t);
  const name = 'čitanje-日本語.txt';
  await renameWithHandles(f.parent, f.target, name, f.entries);
  const renamed = path.join(f.parent, name);
  await renameWithHandles(f.parent, renamed, 'README', await inspectFileAction(f.parent, renamed));
  assert.equal(await fs.readFile(path.join(f.parent, 'README'), 'utf8'), 'original content');
  assert.deepEqual(await fs.readdir(f.parent), ['README']);
});

test('native no-replace rename refuses existing directories without disturbing their contents', async t => {
  const f = await fixture(t);
  const existing = path.join(f.parent, 'occupied');
  await fs.mkdir(existing);
  await fs.writeFile(path.join(existing, 'keep.txt'), 'keep folder');
  await assert.rejects(renameWithHandles(f.parent, f.target, 'occupied', f.entries), /no-replace rename/);
  assert.equal(await fs.readFile(path.join(existing, 'keep.txt'), 'utf8'), 'keep folder');
  assert.equal(await fs.readFile(f.target, 'utf8'), 'original content');
});

test('missing native helper fails explicitly rather than using a path-based fallback', async () => {
  const root = path.join(__dirname, '..', 'src', 'main');
  const localRequire = createRequire(path.join(root, 'windows-rename.js'));
  const context = {
    module: { exports: {} }, __dirname: root, process,
    require(name) {
      if (name === 'node:fs') return { existsSync: () => false };
      if (name === 'node:child_process') return { spawn() { assert.fail('must not spawn when helper is absent'); } };
      return localRequire(name);
    }
  };
  vm.runInNewContext(fsSync.readFileSync(path.join(root, 'windows-rename.js'), 'utf8'), context);
  await assert.rejects(context.module.exports.renameWithHandles('C:\\scan', 'C:\\scan\\one', 'two', []),
    /helper is missing.*no path-based fallback/);
});

test('recycle guard pins ancestors across asynchronous shell work but permits the leaf to move', async t => {
  const f = await fixture(t);
  const moved = path.join(f.root, 'recycled.txt');
  let called = 0;
  await recycleWithPinnedAncestors(f.parent, f.target, f.entries, async () => {
    called++;
    await assert.rejects(fs.rename(f.parent, path.join(f.root, 'redirected')));
    await new Promise(resolve => setTimeout(resolve, 30));
    await assert.rejects(fs.rename(f.parent, path.join(f.root, 'redirected')));
    await fs.rename(f.target, moved);
  });
  assert.equal(called, 1);
  assert.equal(await fs.readFile(moved, 'utf8'), 'original content');
  await fs.rename(f.parent, path.join(f.root, 'unlocked-scan'));
});

test('recycle guard rejects changed ancestors before issuing the shell operation', async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'original.txt'), 'outside');
  await fs.rename(f.parent, path.join(f.root, 'saved-scan'));
  await fs.symlink(outside, f.parent, 'junction');
  try {
    await assert.rejects(recycleWithPinnedAncestors(f.parent, f.target, f.entries,
      () => assert.fail('must not call shell on redirected ancestors')), /junctions/);
    assert.equal(await fs.readFile(path.join(outside, 'original.txt'), 'utf8'), 'outside');
  } finally {
    await fs.unlink(f.parent);
  }
});

test('failed recycle drains shell work, releases locks and marks the snapshot uncertain', async t => {
  const f = await fixture(t);
  await assert.rejects(recycleWithPinnedAncestors(f.parent, f.target, f.entries, async markIssued => {
    markIssued();
    await new Promise(resolve => setTimeout(resolve, 30));
    throw new Error('Shell recycle failed');
  }), error => {
    assert.equal(error.outcomeUncertain, true);
    assert.match(error.message, /Shell recycle failed/);
    return true;
  });

  assert.equal(await fs.readFile(f.target, 'utf8'), 'original content');
  await fs.rename(f.parent, path.join(f.root, 'unlocked-scan'));
});

test('a definite refusal inside the guard before shell issuance does not require Rescan', async t => {
  const f = await fixture(t);
  await assert.rejects(recycleWithPinnedAncestors(f.parent, f.target, f.entries, async () => {
    throw new Error('Copy was edited; undo refused before shell');
  }), error => {
    assert.equal(error.outcomeUncertain, undefined);
    assert.match(error.message, /edited/);
    return true;
  });
  assert.equal(await fs.readFile(f.target, 'utf8'), 'original content');
});

test('recycle ancestor locks do not expire while an issued shell operation remains pending', async t => {
  const f = await fixture(t);
  let entered;
  let release;
  const ready = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const running = recycleWithPinnedAncestors(f.parent, f.target, f.entries, async () => {
    entered();
    await pending;
  });
  await ready;
  try {
    t.mock.timers.tick(60000);
    await assert.rejects(fs.rename(f.parent, path.join(f.root, 'redirected')));
  } finally {
    release();
  }
  await running;
  await fs.rename(f.parent, path.join(f.root, 'unlocked-scan'));
});
