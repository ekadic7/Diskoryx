const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function runSmoke(result, flags = []) {
  const state = { cleaned: false, exitCode: undefined };
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
      if (name === 'node:child_process') return { spawnSync: () => result };
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
  for (const [flags, stdout] of [
    [[], 'PASS: hidden Electron startup, real preload/IPC'],
    [['--startup-error'], 'PASS: isolated themed startup failure, literal message']
  ]) {
    const { state, run } = runSmoke({ status: 0, stdout, stderr: '' }, flags);
    run();
    assert.equal(state.exitCode, 0);
    assert.equal(state.cleaned, true);
  }
  const { run } = runSmoke({ status: 0, stdout: 'PASS: unrelated early check' });
  assert.throws(run, /did not complete/);
});

test('smoke runner preserves a child failure even after a PASS message', () => {
  const { state, run } = runSmoke({ status: 1, stdout: 'PASS: hidden Electron startup' });
  run();
  assert.equal(state.exitCode, 1);
  assert.equal(state.cleaned, true);
});
