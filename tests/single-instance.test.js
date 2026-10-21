const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');

test('another launch exits without opening a second window; existing minimized window is focused', t => {
  const root = path.join(__dirname, '..', 'src', 'main');
  const localRequire = createRequire(path.join(root, 'main.js'));
  for (const owns of [false, true]) {
    const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'diskoryx-single-instance-'));
    t.after(() => fs.rmSync(appData, { recursive: true, force: true }));
    const events = new Map();
    let windows = 0;
    let quits = 0;
    let focuses = 0;
    let restores = 0;
    let existing;
    class Window {
      constructor() { windows++; existing = this; }
      loadFile() {}
      isDestroyed() { return false; }
      isMinimized() { return true; }
      restore() { restores++; }
      focus() { focuses++; }
      static getAllWindows() { return existing ? [existing] : []; }
    }
    vm.runInNewContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), {
      __dirname: root, process, console, setImmediate, AbortController,
      require(name) {
        if (name === 'electron') return {
          app: {
            getPath: () => appData, setPath() {},
            requestSingleInstanceLock: () => owns, quit() { quits++; },
            on: (name, fn) => events.set(name, fn),
            whenReady: () => ({ then: fn => fn() })
          },
          BrowserWindow: Window, Menu: { setApplicationMenu() {} },
          ipcMain: { handle() {} }
        };
        if (name === './mft-broker') return { requireStandardUser() {}, closeScanBroker: async () => {} };
        return localRequire(name);
      }
    });
    assert.equal(windows, owns ? 1 : 0);
    assert.equal(quits, owns ? 0 : 1);
    if (owns) {
      events.get('second-instance')();
      assert.equal(focuses, 1);
      assert.equal(restores, 1);
      assert.equal(windows, 1);
    }
  }
});
