const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');

test('preview IPC requires active scan membership and rejects stale scan IDs', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'diskoryx-preview-ipc-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'test.log');
  await fsp.writeFile(file, 'original log');
  const handlers = new Map();
  const mainRoot = path.join(__dirname, '..', 'src', 'main');
  const rootRequire = createRequire(path.join(mainRoot, 'main.js'));
  vm.runInNewContext(fs.readFileSync(path.join(mainRoot, 'main.js'), 'utf8'), {
    __dirname: mainRoot, process, console, setImmediate, setTimeout, clearTimeout, AbortController,
    require(name) {
      if (name === 'electron') return {
        app: { isPackaged: false, getPath: () => root, setPath() {}, setAppUserModelId() {}, whenReady: () => ({ then() {} }), on() {} },
        ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }
      };
      return rootRequire(name);
    }
  });
  const preview = handlers.get('read-text-preview');
  const event = { sender: { isDestroyed: () => false, send() {}, once() {}, removeListener() {} } };
  assert.match((await preview(event, 1, file, 0, null)).error, /expired/);
  const scan = await handlers.get('scan-folder')(event, root, {});
  assert.equal(scan.success, true);
  const result = await preview(event, scan.scanId, file, 0, null);
  assert.equal(result.text, 'original log');
  const newFile = path.join(root, 'not-scanned.txt');
  await fsp.writeFile(newFile, 'not scanned');
  assert.match((await preview(event, scan.scanId, newFile, 0, null)).error, /not part/);
  assert.match((await preview(event, scan.scanId, path.join(root, '..', 'outside.txt'), 0, null)).error, /outside/);
  await fsp.appendFile(file, 'changed');
  assert.match((await preview(event, scan.scanId, file, 0, result.revision)).error, /changed/);
  const refreshed = await handlers.get('refresh-tree')(event, root, {});
  assert.notEqual(refreshed.scanId, scan.scanId);
  assert.match((await preview(event, scan.scanId, file, 0, null)).error, /expired/);
  assert.equal((await preview(event, refreshed.scanId, file, 0, null)).text, 'original logchanged');
});
