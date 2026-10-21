const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter, getEventListeners } = require('node:events');
const { PassThrough } = require('node:stream');

function fixture(onSpawn = () => {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let kills = 0;
  let launches = 0;
  let argumentsUsed;
  child.kill = () => { kills++; return true; };
  const context = {
    module: { exports: {} },
    require(name) {
      assert.equal(name, 'node:child_process');
      return {
        spawn(...args) {
          launches++;
          argumentsUsed = args;
          onSpawn();
          return child;
        }
      };
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'mft-session.js'), 'utf8'), context);
  return {
    start: context.module.exports.startMftSession, child,
    get kills() { return kills; },
    get launches() { return launches; },
    get argumentsUsed() { return argumentsUsed; }
  };
}

test('MFT session forwards only the device argument without a shell and exposes streams', async () => {
  const f = fixture();
  const controller = new AbortController();
  const session = f.start('scanner.exe', '\\\\.\\C:', controller.signal);
  assert.equal(f.argumentsUsed[0], 'scanner.exe');
  assert.deepEqual(Array.from(f.argumentsUsed[1]), ['\\\\.\\C:']);
  assert.equal(f.argumentsUsed[2].windowsHide, true);
  assert.equal(f.argumentsUsed[2].shell, undefined);
  assert.equal(session.stdout, f.child.stdout);
  assert.equal(session.stderr, f.child.stderr);
  f.child.emit('close', 0, null);
  const result = await session.completion;
  assert.equal(result.code, 0);
  assert.equal(result.error, null);
  await session.dispose();
  assert.equal(f.kills, 0, 'never kill an already closed/reused PID');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('Stop and dispose kill once and do not settle until the owned process closes', async () => {
  const f = fixture();
  const controller = new AbortController();
  const session = f.start('scanner.exe', '\\\\.\\C:', controller.signal);
  controller.abort();
  session.stop();
  let disposed = false;
  const cleanup = session.dispose().then(() => { disposed = true; });
  await Promise.resolve();
  assert.equal(disposed, false);
  assert.equal(f.kills, 1);
  f.child.emit('close', null, 'SIGTERM');
  await cleanup;
  assert.equal(disposed, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('spawn failure is retained until close, and cancellation before launch never spawns', async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => f.start('scanner.exe', '\\\\.\\C:', controller.signal), { name: 'AbortError' });
  assert.equal(f.launches, 0);
  const session = f.start('scanner.exe', '\\\\.\\C:');
  const error = new Error('ENOENT scanner missing');
  f.child.emit('error', error);
  f.child.emit('close', -4058, null);
  assert.equal((await session.completion).error, error);
  await session.dispose();
  assert.equal(f.kills, 0);
});

test('cancellation during launch still stops the newly owned process', async () => {
  const controller = new AbortController();
  const f = fixture(() => controller.abort());
  const session = f.start('scanner.exe', '\\\\.\\C:', controller.signal);
  assert.equal(f.kills, 1);
  f.child.emit('close', null, 'SIGTERM');
  await session.dispose();
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
