const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('Save and Open live in a compact Scan menu in the header, not the sidebar', () => {
  const html = read('src', 'renderer', 'index.html');
  const menu = /<div class="scan-menu">([\s\S]*?)<\/div>\s*<button id="refresh-btn"/.exec(html);
  assert(menu, 'Scan menu markup is missing in the header');
  assert.match(menu[1], /id="save-scan-btn"[^>]*disabled/);
  assert.match(menu[1], /id="open-scan-btn"/);
  assert.match(menu[1], /id="scan-menu-btn"[^>]*aria-expanded="false"/);
  const sidebar = /<aside[\s\S]*?<\/aside>/.exec(html);
  assert(sidebar, 'sidebar markup is missing');
  assert(!/save-scan-btn|open-scan-btn|archive-actions|compare-panel/.test(sidebar[0]),
    'saved-scan and compare controls must stay out of the sidebar');
  const css = read('src', 'renderer', 'styles', 'design.css');
  assert.match(css, /\.scan-menu-list\s*\{/);
  assert.match(css, /\.archive-badge\s*\{/);
});

test('the read-only archive bar and Compare results live in the main content area', () => {
  const html = read('src', 'renderer', 'index.html');
  const app = read('src', 'renderer', 'app.js');
  const bar = /<section id="archive-bar"[\s\S]*?<\/section>/.exec(html);
  assert(bar, 'archive bar markup is missing');
  assert.match(bar[0], /id="archive-bar-time"/);
  assert.match(bar[0], /READ-ONLY/);
  assert.match(bar[0], /id="compare-scan-btn"[^>]*hidden/);
  const view = /<section id="compare-view"[\s\S]*?<\/section>/.exec(html);
  assert(view, 'compare view markup is missing');
  assert.match(view[0], /id="compare-back-btn"/);
  assert.match(view[0], /id="compare-counts"/);
  assert.match(view[0], /id="compare-identity"[^>]*role="alert"[^>]*hidden/);
  assert.match(view[0], /id="compare-rows"/);
  assert.match(app, /compareView\.hidden = false/);
  assert.match(app, /compareBack\.addEventListener\('click', \(\) => hideCompareView\(\)\)/);
  assert(!/comparePanel|compare-panel/.test(app), 'the old sidebar compare panel must be gone');
});

test('the privacy notice is shown before a scan can be written to disk', () => {
  const html = read('src', 'renderer', 'index.html');
  const app = read('src', 'renderer', 'app.js');
  const dialog = /<dialog id="save-archive-dialog"[\s\S]*?<\/dialog>/.exec(html);
  assert(dialog, 'the save dialog is missing');
  assert.match(dialog[0], /folder names, file names, full paths, sizes and dates/);
  assert.match(dialog[0], /never includes file contents/i);
  assert.match(dialog[0], /does not send it anywhere/i);
  assert.match(dialog[0], /id="save-archive-cancel"[^>]*autofocus/);
  assert.match(dialog[0], /id="save-archive-confirm"/);
  assert(!/https?:\/\//.test(dialog[0]), 'the notice must not contain a network reference');
  // The save button opens the notice first; only its confirm handler talks to the backend.
  const openIndex = app.indexOf("saveScanButton.addEventListener('click'");
  const confirmIndex = app.indexOf("document.getElementById('save-archive-confirm')");
  const invokeIndex = app.indexOf('saveScanArchive(scanId)');
  assert(openIndex > -1 && confirmIndex > openIndex && invokeIndex > confirmIndex);
  assert.match(app.slice(openIndex, confirmIndex), /saveArchiveDialog\.showModal\(\)/);
});

test('a saved scan is presented as read-only and its live-only actions are blocked in the UI', () => {
  const html = read('src', 'renderer', 'index.html');
  const app = read('src', 'renderer', 'app.js');
  const preview = read('src', 'renderer', 'text-preview-ui.js');
  assert.match(html, /id="archive-badge"[^>]*role="status"[^>]*hidden/);
  assert.match(app, /function updateArchiveBadge/);
  assert.match(app, /result\.readOnly/);
  assert.match(app, /Saved scan · /);
  assert.match(app, /Saved scan: read-only/);
  assert.match(app, /currentResult\?\.readOnly/);
  assert.match(preview, /currentResult\?\.readOnly/);
  assert.match(preview, /preview-unavailable/);
  assert.match(read('src', 'renderer', 'drive-scans.js'), /saved scan/);
  assert.match(app, /updateArchiveBadge\(null\)/);
});

test('the preload bridge exposes exactly the saved-scan channels', () => {
  const preload = read('src', 'preload', 'preload.js');
  assert.match(preload, /saveScanArchive: \(scanId\) => ipcRenderer\.invoke\('save-scan-archive', scanId\)/);
  assert.match(preload, /openScanArchive: \(requestId\) => ipcRenderer\.invoke\('open-scan-archive', requestId\)/);
  assert(!/ipcRenderer\.invoke\('save-scan-archive', (?!scanId)/.test(preload));
  const app = read('src', 'renderer', 'app.js');
  assert.match(app, /window\.electronAPI\.saveScanArchive\(scanId\)/);
  assert.match(app, /window\.electronAPI\.openScanArchive\(requestId\)/);
  const main = read('src', 'main', 'main.js');
  assert.match(main, /require\('\.\/scan-archive'\)/);
  assert.match(main, /ipcMain\.handle\('save-scan-archive'/);
  assert.match(main, /ipcMain\.handle\('open-scan-archive'/);
  assert.match(main, /properties: \['openFile'\]/);
});

test('opening a saved scan cancels through the existing Stop scan control', () => {
  const app = read('src', 'renderer', 'app.js');
  assert.match(app, /async function runArchiveOpen\(\)/);
  assert.match(app, /openScanArchive\(requestId\)/);
  assert.match(app, /cancellationRequested/);
  assert.match(app, /setScanControls\(true\)/);
  // Progress for a saved scan uses its own wording, not the disk scan counters.
  assert.match(app, /progress\.phase === 'archive'/);
  assert.match(app, /Opening saved scan\.\.\./);
});

test('Compare renderer and preload send the same numeric request id to progress and Stop', async () => {
  const app = read('src', 'renderer', 'app.js');
  const calls = [];
  const listeners = new Map();
  const controls = [];
  let finish;
  let stop;
  let messages = 0;
  const context = vm.createContext({
    window: {}, scanRequestId: 41, scanInProgress: false, cancellationRequested: true,
    fileActionInProgress: false, folderDialogOpen: false, scanOperation: 'duplicates',
    stopScanButton: { addEventListener: (_type, fn) => { stop = fn; } },
    setScanControls: busy => controls.push(busy),
    hideCompareView() {}, showActionToast() {}, hideActionToast() {},
    showAppMessage: () => assert.fail('cancellation must not display a failure'),
    showMessage: () => { messages++; }, updateScanMode() {},
    formatDuration() {}, formatRate() {},
    require: () => ({
      contextBridge: { exposeInMainWorld: (name, api) => { context.window[name] = api; } },
      ipcRenderer: {
        on: (channel, callback) => listeners.set(channel, callback),
        async invoke(channel, requestId) {
          calls.push([channel, requestId]);
          if (channel === 'compare-with-current') return new Promise(resolve => { finish = resolve; });
          if (channel === 'cancel-scan') { finish({ cancelled: true }); return { success: true }; }
          assert.fail(`Unexpected IPC: ${channel}`);
        }
      }
    })
  });
  vm.runInContext(read('src', 'preload', 'preload.js'), context);
  vm.runInContext(app.slice(app.indexOf('if (window.electronAPI?.onScanProgress)'),
    app.indexOf('async function runScan(')), context);
  vm.runInContext(app.slice(app.indexOf("stopScanButton.addEventListener('click'"),
    app.indexOf("exportCsvButton.addEventListener('click'")), context);
  vm.runInContext(app.slice(app.indexOf('async function runCompare()'),
    app.indexOf("compareScanButton.addEventListener('click'")), context);
  const comparing = context.runCompare();
  assert.equal(context.scanRequestId, 42);
  assert.equal(context.scanOperation, 'compare');
  assert.equal(context.cancellationRequested, false);
  const progress = { scannedEntries: 1, filteredCount: 0, skippedCount: 0 };
  listeners.get('scan-progress')(null, { ...progress, requestId: 41 });
  assert.equal(messages, 0, 'old scan progress is ignored');
  listeners.get('scan-progress')(null, { ...progress, requestId: 42 });
  assert.equal(messages, 1, 'Compare progress reaches the existing scan progress UI');
  await stop();
  await comparing;
  assert.deepEqual(calls, [['compare-with-current', 42], ['cancel-scan', 42]]);
  assert.deepEqual(controls, [true, false]);
  assert.equal(context.scanInProgress, false);
  assert.equal(context.cancellationRequested, false);
});
