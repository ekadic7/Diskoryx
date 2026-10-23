const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadUI() {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, { open: false, classList: { toggle() {} }, addEventListener() {} });
    return elements.get(id);
  };
  let notify;
  const timers = [];
  const refreshed = [];
  const context = vm.createContext({
    document: { getElementById: get, addEventListener() {} },
    window: { electronAPI: { onLiveUpdate(fn) { notify = fn; } } },
    scanInProgress: false, fileActionInProgress: false,
    renameDialog: { open: false }, messageDialog: { open: false }, copyDialog: { open: false },
    fileContextMenu: { hidden: true }, exportCsvButton: { disabled: false },
    currentFolderPath: 'C:\\fixture', currentScanId: 5,
    setTimeout(fn) { timers.push(fn); },
    setFileActionBusy(value) { context.fileActionInProgress = value; },
    async refreshAfterFileAction(value) { refreshed.push(value); }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'live-updates.js'), 'utf8'), context);
  return {
    context, refreshed, get,
    stale(scanId) {
      notify({
        scanId, folderPath: 'C:\\fixture', snapshotChanged: true,
        status: { state: 'stale', message: 'Browsing the last saved snapshot.' }
      });
    },
    change(scanId, folderPath = 'C:\\fixture') {
      notify({ scanId, folderPath, snapshotChanged: true, status: { state: 'watching', message: 'watching' } });
    },
    async drain() { timers.shift()?.(); await Promise.resolve(); await Promise.resolve(); }
  };
}

test('live UI drops queued revisions overtaken by a successful app action', async () => {
  const ui = loadUI();
  ui.context.renameDialog.open = true;
  ui.change(6);
  assert.equal(ui.refreshed.length, 0);
  ui.context.currentScanId = 7;
  ui.context.renameDialog.open = false;
  await ui.drain();
  assert.equal(ui.refreshed.length, 0, 'old notification must not replace a newer actionable snapshot');
  ui.change(8);
  await Promise.resolve();
  assert.equal(ui.refreshed.length, 1);
  assert.equal(ui.refreshed[0].scanId, 8);
});

test('live UI waits until a context menu closes and ignores other roots or same revisions', async () => {
  const ui = loadUI();
  ui.context.fileContextMenu.hidden = false;
  ui.change(6);
  assert.equal(ui.refreshed.length, 0);
  ui.context.fileContextMenu.hidden = true;
  await ui.drain();
  assert.equal(ui.refreshed.length, 1);
  ui.context.currentScanId = 6;
  ui.change(6);
  ui.change(7, 'C:\\different');
  await Promise.resolve();
  assert.equal(ui.refreshed.length, 1);
});

test('watcher changes refresh the view silently without a success toast', async () => {
  const ui = loadUI();
  ui.change(6);
  await Promise.resolve();
  assert.equal(ui.refreshed.length, 1);
  assert.equal(ui.refreshed[0].silent, true, 'external-change refresh must not raise a success toast');
  assert.equal(ui.refreshed[0].actionLabel, undefined);
  assert.equal(ui.refreshed[0].scanId, 6);
});

test('pausing live monitoring keeps snapshot export available and refreshes an unseen committed revision', async () => {
  const ui = loadUI();
  ui.stale(5);
  assert.equal(ui.context.exportCsvButton.disabled, false);
  assert.equal(ui.refreshed.length, 0);
  ui.stale(6);
  await Promise.resolve();
  assert.equal(ui.refreshed[0].scanId, 6);
});
