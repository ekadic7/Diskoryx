const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MAIN_PASS = 'PASS: hidden Electron startup, real preload/IPC';
const ARCHIVE_SUMS = 'ARCHIVE SUMS {"files":2,"folders":1,"bytes":90016}';
const ARCHIVE_PASS = 'PASS: saved scan reopened in a fresh Electron process';
const STARTUP_PASS = 'PASS: isolated themed startup failure, literal message';

// The runner starts the application, then a second process that reopens the
// saved scan. A queue keeps each stage's fixture output independent.
function runSmoke(results, flags = []) {
  const state = { cleaned: false, exitCode: undefined, spawns: 0, environments: [] };
  const queue = Array.isArray(results) ? [...results] : [results];
  const process = {
    argv: ['node', 'smoke.cjs', ...flags], env: {},
    stdout: { write() {} }, stderr: { write() {} },
    set exitCode(value) { state.exitCode = value; }
  };
  const filename = path.join(__dirname, '..', 'scripts', 'smoke.cjs');
  const context = {
    __dirname: path.dirname(filename), process,
    require(name) {
      if (name === 'electron') return 'fixture-electron';
      if (name === 'node:child_process') return {
        spawnSync: (_file, _args, options) => {
          state.spawns++;
          state.environments.push(options.env);
          return queue.length > 1 ? queue.shift() : queue[0];
        }
      };
      if (name === 'node:fs') return {
        mkdtempSync: () => path.join(__dirname, 'fixture-never-created'),
        mkdirSync() {}, rmSync: () => { state.cleaned = true; }
      };
      return require(name);
    }
  };
  return { state, run: () => vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context) };
}

test('smoke runner rejects a silent successful exit and still cleans its fixtures', () => {
  const { state, run } = runSmoke({ status: 0, stdout: '', stderr: '' });
  assert.throws(run, /did not complete/);
  assert.equal(state.cleaned, true);
});

test('smoke runner requires the expected main or startup-error completion marker', () => {
  const { state, run } = runSmoke([
    { status: 0, stdout: `${MAIN_PASS}\n${ARCHIVE_SUMS}`, stderr: '' },
    { status: 0, stdout: ARCHIVE_PASS, stderr: '' }
  ]);
  run();
  assert.equal(state.exitCode, 0);
  assert.equal(state.cleaned, true);
  const startup = runSmoke({ status: 0, stdout: STARTUP_PASS, stderr: '' }, ['--startup-error']);
  startup.run();
  assert.equal(startup.state.exitCode, 0);
  assert.equal(startup.state.spawns, 1, 'a startup-error run must not reopen a saved scan');
  assert.throws(runSmoke({ status: 0, stdout: 'PASS: unrelated early check' }).run, /did not complete/);
});

test('smoke runner preserves a child failure even after a PASS message', () => {
  const { state, run } = runSmoke({ status: 1, stdout: MAIN_PASS });
  run();
  assert.equal(state.exitCode, 1);
  assert.equal(state.cleaned, true);
});

test('smoke runner reopens the saved scan in a second process and passes its counts', () => {
  const { state, run } = runSmoke([
    { status: 0, stdout: `${MAIN_PASS}\n${ARCHIVE_SUMS}`, stderr: '' },
    { status: 0, stdout: ARCHIVE_PASS, stderr: '' }
  ]);
  run();
  assert.equal(state.spawns, 2);
  const [first, second] = state.environments;
  assert.equal(first.DISKORYX_SMOKE_ARCHIVE_SAVE, first.DISKORYX_SMOKE_ARCHIVE_OPEN);
  assert.equal(second.DISKORYX_SMOKE_ARCHIVE_OPEN_ONLY, '1');
  assert.equal(second.DISKORYX_SMOKE_ARCHIVE_OPEN, first.DISKORYX_SMOKE_ARCHIVE_SAVE);
  assert.equal(second.DISKORYX_SMOKE_ARCHIVE_EXPECT, '{"files":2,"folders":1,"bytes":90016}');
  assert.equal(second.DISKORYX_SMOKE_ROOT, first.DISKORYX_SMOKE_ROOT);
});

test('smoke runner fails when the saved scan did not reopen after the restart', () => {
  const missingArchive = runSmoke({ status: 0, stdout: `${MAIN_PASS}`, stderr: '' });
  assert.throws(missingArchive.run, /did not write a saved scan archive/);
  assert.equal(missingArchive.state.cleaned, true);

  const missingMarker = runSmoke([
    { status: 0, stdout: `${MAIN_PASS}\n${ARCHIVE_SUMS}`, stderr: '' },
    { status: 0, stdout: 'PASS: hidden Electron startup', stderr: '' }
  ]);
  assert.throws(missingMarker.run, /did not reopen after an application restart/);
  assert.equal(missingMarker.state.cleaned, true);
});
