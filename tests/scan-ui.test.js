const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function element() {
  const listeners = new Map();
  const classes = new Set();
  return {
    value: '', textContent: '', disabled: false, hidden: true, children: [], style: {},
    addEventListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
    },
    async fire(name, event = {}) {
      for (const fn of listeners.get(name) || []) await fn({ target: this, preventDefault() {}, ...event });
    },
    click() { return this.disabled ? Promise.resolve() : this.fire('click'); },
    remove() {}, close() { this.open = false; }, showModal() { this.open = true; }, focus() {}, select() {},
    querySelector(selector) {
      return this.children.find(child => child.className === selector.slice(1)) || element();
    },
    querySelectorAll(selector) {
      return this.children.filter(child => child.classList.contains(selector.slice(1)));
    },
    append(...children) {
      for (const child of children) {
        child.parentElement = this;
        this.children.push(child);
      }
    },
    replaceChildren() { this.children = []; },
    setAttribute() {},
    classList: {
      add(name) { classes.add(name); },
      contains(name) { return classes.has(name); },
      toggle(name, force) {
        if (force) classes.add(name);
        else classes.delete(name);
      }
    }
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function loadUI(api = {}, multiDrive = false, localStorage = { getItem: () => null }) {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  let progress;
  const document = Object.assign(element(), {
    getElementById: get, querySelector: get, createElement: element,
    dispatchEvent() {}
  });
  const context = vm.createContext({
    document, Event: class {}, CustomEvent: class {},
    setTimeout: () => 1, clearTimeout() {},
    updatePasteAvailability() {},
    window: {
      localStorage,
      electronAPI: {
        onScanProgress(fn) { progress = fn; }, ...api
      }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'virtual-tree.js'), 'utf8'), context);
  const rendered = [];
  context.recordRender = result => rendered.push(result);
  vm.runInContext('globalThis.renderActualResult = renderResult; renderResult = recordRender;', context);
  if (multiDrive) {
    vm.runInContext('renderResult = result => { currentResult = result; currentScanId = result.scanId; recordRender(result); };', context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'drive-scans.js'), 'utf8'), context);
  }
  get('drive-select').value = 'C:\\';
  get('scan-drive-btn').disabled = false;
  return {
    get, rendered, document,
    progress: value => progress(value),
    run: code => vm.runInContext(code, context)
  };
}

test('previously saved scan filters remain available after the profile migration', () => {
  const legacy = JSON.stringify({
    includeExtensions: ['.txt'],
    excludeExtensions: ['.tmp'],
    excludeFolderNames: ['cache']
  });
  const migrated = loadUI({}, false, {
    getItem: key => key === 'filevisor.scanFilters' ? legacy : null
  });
  assert.deepEqual(JSON.parse(migrated.run('JSON.stringify(currentScanFilters)')), {
    includeExtensions: ['.txt'],
    excludeExtensions: ['.tmp'],
    excludeFolderNames: ['cache']
  });

  const current = loadUI({}, false, {
    getItem: key => key === 'diskoryx.scanFilters' ? '{"includeExtensions":[".log"]}' : legacy
  });
  assert.deepEqual(JSON.parse(current.run('JSON.stringify(currentScanFilters)')), {
    includeExtensions: ['.log'],
    excludeExtensions: [],
    excludeFolderNames: []
  });
});

test('drive chooser shows each drive letter once', async () => {
  const ui = loadUI({
    async listDrives() { return { drives: [{ path: 'C:\\', label: 'C:' }, { path: 'D:\\', label: 'D:' }] }; }
  }, true);
  await ui.get('choose-drives-btn').click();
  const names = ui.get('drive-checklist').children.map(label => label.children[1].textContent);
  assert.deepEqual(names, ['C:', 'D:']);
});

test('selected drives scan sequentially, block duplicate requests and keep the last completed result on Stop', async () => {
  const pending = deferred();
  const requests = [];
  const ui = loadUI({
    async scanFolder(folder, _filters, requestId) {
      requests.push({ folder, requestId });
      return requests.length === 1 ? { success: true, scanId: 1, folderPath: folder } : pending.promise;
    },
    async cancelScan() { return { success: true }; }
  }, true);
  ui.run('selectedDrivePaths = ["C:\\\\", "D:\\\\", "E:\\\\"]; updateDriveSelection();');
  const running = ui.get('scan-drive-btn').click();
  for (let count = 0; count < 10 && requests.length < 2; count++) await Promise.resolve();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].folder, 'C:\\');
  assert.equal(requests[1].folder, 'D:\\');
  assert.equal(requests[0].requestId, requests[1].requestId);
  assert.equal(ui.get('choose-drives-btn').disabled, true);
  assert.equal(ui.get('saved-scans-select').disabled, true);
  await ui.get('scan-drive-btn').fire('click');
  assert.equal(requests.length, 2);
  await ui.get('stop-scan-btn').click();
  pending.resolve({ cancelled: true });
  await running;
  assert.equal(requests.length, 2, 'Stop must not launch the third drive');
  assert.equal(ui.rendered.at(-1).folderPath, 'C:\\');
  assert.equal(ui.get('choose-drives-btn').disabled, false);
});

test('failed drive or rejected IPC stops the queue without discarding completed results', async () => {
  for (const reject of [false, true]) {
    const requests = [];
    const ui = loadUI({
      async scanFolder(folder) {
        requests.push(folder);
        if (requests.length === 1) return { success: true, scanId: 1, folderPath: folder };
        if (reject) throw new Error('Drive disconnected');
        return { error: 'Drive disconnected' };
      }
    }, true);
    ui.run('selectedDrivePaths = ["C:\\\\", "D:\\\\", "E:\\\\"];');
    await ui.get('scan-drive-btn').click();
    assert.equal(requests.length, 2);
    assert.equal(ui.rendered.at(-1).folderPath, 'C:\\');
    assert.match(ui.get('message-text').textContent, /Drive disconnected.*\nRemaining drives/);
    assert.equal(ui.get('scan-drive-btn').disabled, false);
  }
});

test('app messages preserve literal errors and update an existing themed dialog', () => {
  const ui = loadUI();
  ui.run('showAppMessage("<img src=x onerror=alert(1)>\\nAccess denied");');
  assert.equal(ui.get('message-dialog').open, true);
  assert.equal(ui.get('message-title').textContent, 'Unable to complete action');
  assert.equal(ui.get('message-text').textContent, '<img src=x onerror=alert(1)>\nAccess denied');
  ui.run('showAppMessage("Saved locally", "Export complete");');
  assert.equal(ui.get('message-title').textContent, 'Export complete');
  assert.equal(ui.get('message-text').textContent, 'Saved locally');
});

test('Explorer and copy-path rejections use themed messages instead of native alerts', async () => {
  const ui = loadUI({
    async copyPath() { return { error: 'Copy denied' }; },
    async revealInExplorer() { throw new Error('Explorer unavailable'); }
  });
  ui.run('contextFile = {path: "C:\\\\test\\\\one.txt"};');
  for (const [action, expected] of [['copy-path', 'Copy denied'], ['reveal', 'Explorer unavailable']]) {
    await ui.get('file-context-menu').fire('click', {
      target: { closest: () => ({ dataset: { fileAction: action } }) }
    });
    assert.equal(ui.get('message-text').textContent, expected);
    assert.equal(ui.get('message-dialog').open, true);
  }
});

test('CSV success and failure share the app message dialog and restore export controls', async () => {
  let fail = false;
  const ui = loadUI({
    async exportCsv() {
      return fail ? { error: 'Export denied' } : { success: true, rowCount: 2, filePath: 'C:\\test.csv' };
    }
  });
  ui.run('currentScanId = 7;');
  await ui.get('export-csv-btn').fire('click');
  assert.equal(ui.get('message-title').textContent, 'Export complete');
  assert.match(ui.get('message-text').textContent, /2 tree items/);
  assert.equal(ui.get('export-csv-btn').disabled, false);
  fail = true;
  await ui.get('export-csv-btn').fire('click');
  assert.equal(ui.get('message-title').textContent, 'Unable to complete action');
  assert.equal(ui.get('message-text').textContent, 'Export denied');
  assert.equal(ui.get('export-csv-btn').disabled, false);
});

test('rapid repeated Scan/Rescan/Browse actions launch only one request and reject stale progress', async () => {
  const pending = deferred();
  const requests = [];
  let foldersOpened = 0;
  const ui = loadUI({
    scanFolder(...args) { requests.push(args); return pending.promise; },
    showFolderDialog() { foldersOpened++; },
    async cancelScan() { return { success: true }; }
  });
  const first = ui.get('scan-drive-btn').click();
  await ui.get('scan-drive-btn').fire('click');
  await ui.get('refresh-btn').fire('click');
  await ui.get('folder-picker-btn').fire('click');
  assert.equal(requests.length, 1);
  assert.equal(foldersOpened, 0);
  for (const id of ['scan-drive-btn', 'drive-select', 'folder-picker-btn', 'refresh-btn', 'sort-select']) {
    assert.equal(ui.get(id).disabled, true, id);
  }
  assert.equal(ui.get('stop-scan-btn').hidden, false);
  const id = requests[0][2];
  const update = requestId => ui.progress({
    requestId, scannedEntries: 10, entriesPerSecond: 100, elapsedMs: 50, filteredCount: 0, skippedCount: 0
  });
  update(id - 1);
  assert.equal(ui.get('file-tree').children[0].textContent, 'Preparing scan...');
  update(id);
  assert.match(ui.get('file-tree').children[0].textContent, /Scanning.*10 items/);
  pending.resolve({ success: true });
  await first;
  assert.equal(ui.rendered.length, 1);
  assert.equal(ui.get('scan-drive-btn').disabled, false);
  assert.equal(ui.get('stop-scan-btn').hidden, true);
  update(id);
  assert.equal(ui.rendered.length, 1);
});

test('Stop sends one matching cancellation, stays locked until cleanup and restores last result', async () => {
  const pending = deferred();
  const cancelled = [];
  const ui = loadUI({
    scanFolder: () => pending.promise,
    async cancelScan(id) { cancelled.push(id); return { success: true }; }
  });
  ui.run('currentResult = {success: true, scanId: 10}; currentScanId = 10;');
  const first = ui.get('scan-drive-btn').click();
  await ui.get('stop-scan-btn').click();
  await ui.get('stop-scan-btn').fire('click');
  assert.deepEqual(cancelled, [1]);
  assert.equal(ui.get('stop-scan-btn').disabled, true);
  assert.equal(ui.get('stop-scan-btn').textContent, 'Stopping...');
  assert.equal(ui.get('scan-drive-btn').disabled, true);
  pending.resolve({ cancelled: true });
  await first;
  assert.equal(ui.rendered[0].scanId, 10);
  assert.equal(ui.get('scan-drive-btn').disabled, false);
  assert.equal(ui.get('export-csv-btn').disabled, false);
  assert.match(ui.get('action-toast').textContent, /Scan stopped/);
});

test('Stop without an earlier result returns to empty state, and failed cancellation can be retried', async () => {
  const pending = deferred();
  let attempts = 0;
  const ui = loadUI({
    scanFolder: () => pending.promise,
    async cancelScan() {
      if (++attempts === 1) throw new Error('IPC unavailable');
      return { success: true };
    }
  });
  const running = ui.get('scan-drive-btn').click();
  await ui.get('stop-scan-btn').click();
  assert.equal(ui.get('stop-scan-btn').disabled, false);
  assert.match(ui.get('action-toast').textContent, /IPC unavailable/);
  await ui.get('stop-scan-btn').click();
  pending.resolve({ cancelled: true });
  await running;
  assert.equal(ui.rendered.length, 0);
  assert.match(ui.get('file-tree').children[0].textContent, /Scan stopped/);
  assert.equal(ui.get('export-csv-btn').disabled, true);
});

test('late cancellation reply from an old scan cannot change controls of a new scan', async () => {
  const first = deferred();
  const second = deferred();
  const cancel = deferred();
  let calls = 0;
  const ui = loadUI({
    scanFolder: () => ++calls === 1 ? first.promise : second.promise,
    cancelScan: () => cancel.promise
  });
  const running = ui.get('scan-drive-btn').click();
  const stopping = ui.get('stop-scan-btn').click();
  first.resolve({ cancelled: true });
  await running;
  const next = ui.get('scan-drive-btn').click();
  cancel.reject(new Error('old cancel failure'));
  await stopping;
  assert.equal(ui.get('stop-scan-btn').textContent, 'Stop scan');
  assert.equal(ui.get('stop-scan-btn').disabled, false);
  assert(!ui.get('action-toast').textContent.includes('old cancel failure'));
  second.resolve({ success: true });
  await next;
  assert.equal(calls, 2);
});

test('duplicate folder dialogs are prevented, and scan failures restore controls', async () => {
  const dialog = deferred();
  let dialogs = 0;
  let scans = 0;
  const ui = loadUI({
    showFolderDialog() { dialogs++; return dialog.promise; },
    async scanFolder() { scans++; throw new Error('scan unavailable'); }
  });
  const choosing = ui.get('folder-picker-btn').click();
  await ui.get('folder-picker-btn').fire('click');
  await ui.get('scan-drive-btn').fire('click');
  assert.equal(dialogs, 1);
  assert.equal(scans, 0);
  dialog.resolve(null);
  await choosing;
  await ui.get('scan-drive-btn').click();
  assert.equal(scans, 1);
  assert.match(ui.get('file-tree').children[0].textContent, /scan unavailable/);
  assert.equal(ui.get('folder-picker-btn').disabled, false);
  assert.equal(ui.get('scan-drive-btn').disabled, false);
});

test('removed views cannot launch and explorer sorting remains blocked during scanning', async () => {
  const calls = [];
  const ui = loadUI({
    async sortTree(...args) { calls.push(args); return { success: true }; }
  });
  ui.run("currentFolderPath = 'C:\\\\test'; currentScanId = 5;");
  await ui.document.fire('diskoryx:sort', { detail: 'largest' });
  await ui.document.fire('diskoryx:sort', { detail: 'types' });
  assert.equal(calls.length, 0);
  for (const type of ['name', 'size', 'date']) {
    ui.get('sort-select').value = type;
    await ui.get('sort-select').fire('change');
    assert.equal(calls.at(-1)[1], type);
    assert.equal(calls.at(-1)[3].length, 0);
  }
  ui.run('scanInProgress = true;');
  await ui.document.fire('diskoryx:sort', { detail: 'largest' });
  await ui.get('sort-select').fire('change');
  assert.equal(calls.length, 3);
});

test('flat file rows reuse table geometry, paths, scan shares, selection and file actions', async () => {
  const ui = loadUI();
  ui.run(`
    globalThis.selectedFiles = [];
    globalThis.contextFiles = [];
    virtualTree = {
      renderRow: VirtualTree.prototype.renderRow, selectedPath: null,
      onFileSelect: item => selectedFiles.push(item),
      onFileContext: item => contextFiles.push(item)
    };
    currentResult = { totalSizeBytes: 1000 };
    renderFiles([
      { name: '<script>.txt', path: 'C:\\\\one\\\\same.txt', type: 'file', rawSize: 250, size: '250 B' },
      { name: 'same.txt', path: 'C:\\\\two\\\\same.txt', type: 'file', rawSize: 0, size: '250 B', isHardLinkAlias: true }
    ], treeContainer);
  `);
  // Startup's empty message is not part of the rendered file list.
  const rows = ui.get('file-tree').children.filter(child => child.classList.contains('result-file-row'));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].style.top, undefined);
  assert.equal(rows[0].children[0].children[1].children[0].textContent, '<script>.txt');
  assert.equal(rows[0].children[0].children[1].children[1].textContent, 'C:\\one\\same.txt');
  assert.equal(rows[0].title, 'C:\\one\\same.txt');
  assert.equal(rows[0].children[1].textContent, '250 B');
  assert.equal(rows[0].children[2].children[0].children[0].style.width, '25%');
  assert.equal(rows[0].children[2].children[1].textContent, '25.0%');
  assert.equal(rows[1].children[2].children[1].textContent, '0.0%');
  assert.equal(ui.get('share-column-label').textContent, 'Of scan');
  await rows[0].click();
  assert.equal(ui.run('selectedFiles[0].path'), 'C:\\one\\same.txt');
  assert.equal(rows[0].classList.contains('is-selected'), true);
  await rows[1].click();
  assert.equal(rows[0].classList.contains('is-selected'), false);
  assert.equal(rows[1].classList.contains('is-selected'), true);
  await rows[0].fire('contextmenu');
  assert.equal(ui.run('contextFiles[0].path'), 'C:\\one\\same.txt');
});

test('search pages append table rows using the scan total and keep load-more behavior', async () => {
  const offsets = [];
  const ui = loadUI({
    async searchFiles(_scanId, _query, _extensions, offset) {
      offsets.push(offset);
      return {
        success: true, totalCount: 2,
        results: [{ name: `file${offset}.txt`, path: `C:\\file${offset}.txt`, type: 'file', size: '50 B', rawSize: 50 }]
      };
    }
  });
  ui.run(`
    virtualTree = {
      renderRow: VirtualTree.prototype.renderRow, clear() { treeContainer.replaceChildren(); },
      onFileSelect() {}, onFileContext() {}
    };
    currentResult = { totalSizeBytes: 1000 };
    currentScanId = 1;
    currentSearchQuery = 'file';
  `);
  await ui.run('loadSearchPage(0, false)');
  assert.equal(ui.get('file-tree').children.length, 2);
  assert.equal(ui.get('file-tree').children[0].children[2].children[1].textContent, '5.0%');
  assert.equal(ui.get('file-tree').children[1].className, 'tree-load-more');
  await ui.run('loadSearchPage(1, true)');
  assert.deepEqual(offsets, [0, 1]);
  const rows = ui.get('file-tree').children.filter(child => child.classList.contains('result-file-row'));
  assert.equal(rows.length, 2);
  assert.equal(rows[1].children[2].children[1].textContent, '5.0%');
});

test('map selection leaves search view for the tree without resetting map navigation', async () => {
  const calls = [];
  const ui = loadUI({
    async sortTree(...args) {
      calls.push(args);
      return { success: true, scanId: 5, sortType: 'name' };
    }
  });
  ui.run(`
    currentFolderPath = 'C:\\\\test';
    currentScanId = 5;
    currentSearchQuery = 'file';
    globalThis.revealed = [];
    globalThis.mapReset = null;
    virtualTree = { root: null, async revealItem(item) { revealed.push(item); } };
    renderResult = (result, updateMap) => {
      mapReset = updateMap;
      virtualTree.root = {};
    };
  `);
  await ui.run("syncTreeToMapItem({type: 'folder', folderId: 2})");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], 'name');
  assert.equal(ui.run('mapReset'), false);
  assert.equal(ui.run('currentSearchQuery'), '');
  assert.equal(ui.run('revealed[0].folderId'), 2);
  await ui.run("syncTreeToMapItem({type: 'file', parentFolderId: 2})");
  assert.equal(calls.length, 1, 'existing tree is reused without sorting or rescanning');
  assert.equal(ui.run('revealed.length'), 2);
});

test('map selection reports reveal errors and ignores selection during scanning', async () => {
  const ui = loadUI();
  ui.run(`
    currentScanId = 5;
    virtualTree = { root: {}, async revealItem() { throw new Error('Folder unavailable'); } };
  `);
  await ui.run("syncTreeToMapItem({type: 'folder', folderId: 2})");
  assert.match(ui.get('action-toast').textContent, /Unable to sync.*Folder unavailable/);
  ui.get('action-toast').textContent = '';
  ui.run('scanInProgress = true;');
  await ui.run("syncTreeToMapItem({type: 'folder', folderId: 2})");
  assert.equal(ui.get('action-toast').textContent, '');
});

test('mode badge describes a successful filesystem fallback without exposing the failed MFT details', () => {
  const ui = loadUI();
  ui.run("updateScanMode({scanMode: 'mft', scanModeReason: ''})");
  assert.equal(ui.get('scan-mode').hidden, false);
  assert.equal(ui.get('scan-mode').textContent, 'Fast \u00b7 MFT');
  ui.run("updateScanMode({scanMode: 'standard', scanModeReason: 'MFT unavailable; filesystem traversal used.'})");
  assert.equal(ui.get('scan-mode').textContent, 'Standard \u00b7 Filesystem \u2014 MFT unavailable; filesystem traversal used.');
  assert.equal(ui.get('scan-mode').title, ui.get('scan-mode').textContent);
  ui.run('updateScanMode(null)');
  assert.equal(ui.get('scan-mode').hidden, true);
  assert.equal(ui.get('scan-mode').textContent, '');
});

test('restored rename and recycle UI pass captured scan identity and expose errors or cancellation', async () => {
  const calls = [];
  const ui = loadUI({
    async renameFile(...args) {
      calls.push(['rename', ...args]);
      return { error: 'The item changed' };
    },
    async deleteFile(...args) {
      calls.push(['delete', ...args]);
      return { cancelled: true };
    }
  });
  ui.run("contextFile = {path: 'C:\\\\test\\\\one.txt'}; contextScanId = 7;");
  ui.get('rename-input').value = 'two.txt';
  await ui.get('rename-form').fire('submit');
  assert.deepEqual(calls[0], ['rename', 'C:\\test\\one.txt', 'two.txt', 7]);
  assert.equal(ui.get('rename-error').hidden, false);
  assert.match(ui.get('rename-error').textContent, /item changed/);
  await ui.get('file-context-menu').fire('click', {
    target: { closest: () => ({ dataset: { fileAction: 'delete' } }) }
  });
  assert.deepEqual(calls[1], ['delete', 'C:\\test\\one.txt', 7]);
  assert.equal(ui.run('fileActionInProgress'), false);
});

test('successful rename refreshes cached sorted data and selection without any scan lifecycle', async () => {
  const pending = deferred();
  const calls = [];
  const ui = loadUI({
    renameFile: () => pending.promise,
    scanFolder() { assert.fail('rename must not scan'); },
    refreshTree() { assert.fail('rename must not rescan'); },
    async sortTree(...args) {
      calls.push(args);
      return {
        success: true, scanId: 8, folderPath: 'C:\\test', sortType: 'size',
        fileCount: 1, totalSizeBytes: 10, totalSizeFormatted: '10 B', scanDurationMs: 100,
        entriesPerSecond: 10, structure: [], scanFilters: {}
      };
    }
  });
  const events = [];
  ui.document.dispatchEvent = event => events.push(event);
  ui.run(`
    renderResult = renderActualResult;
    currentFolderPath = 'C:\\\\test'; currentScanId = 7; currentSortType = 'size';
    currentResult = {success: true}; contextScanId = 7;
    contextFile = {path: 'C:\\\\test\\\\old.txt'};
    globalThis.reveals = [];
    virtualTree = {clear() {}, async revealItem(item) { reveals.push(item); }};
    diskTreemap = {frame: {folderId: 0}, showRoot() {}};
  `);
  ui.get('rename-input').value = 'new.txt';
  const running = ui.get('rename-form').fire('submit');
  assert.equal(ui.get('scan-drive-btn').disabled, true);
  assert.equal(ui.get('sort-select').disabled, true);
  assert.equal(ui.get('stop-scan-btn').hidden, true);
  await ui.get('scan-drive-btn').fire('click');
  pending.resolve({
    success: true, scanId: 8, parentFolderId: 0,
    item: { type: 'file', name: 'new.txt', path: 'C:\\test\\new.txt', size: '10 B' }
  });
  await running;
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], 'size');
  assert.equal(calls[0][2], 8);
  assert.equal(ui.run('currentScanId'), 8);
  assert.equal(ui.run('scanInProgress'), false);
  assert.equal(ui.run('reveals[0].name'), 'new.txt');
  assert.equal(ui.get('scan-drive-btn').disabled, false);
  assert.equal(ui.get('export-csv-btn').disabled, false);
  assert.equal(ui.get('action-toast').textContent, 'Item renamed');
});

test('recycle refresh preserves search and falls back to surviving map parent without scanning', async () => {
  const ui = loadUI({
    async deleteFile() { return { success: true, scanId: 9, parentFolderId: 2, item: null }; },
    refreshTree() { assert.fail('recycle must not rescan'); },
    async sortTree() { return { success: true, scanId: 9 }; },
    async getFolderAncestors() { return { error: 'Folder removed' }; }
  });
  ui.run(`
    currentFolderPath = 'C:\\\\test'; currentScanId = 8; currentSearchQuery = 'README';
    contextFile = {path: 'C:\\\\test\\\\java\\\\README'}; contextScanId = 8;
    globalThis.mapTargets = [];
    diskTreemap = {frame: {folderId: 3}, async navigateToFolder(item) { mapTargets.push(item); }};
    loadSearchPage = async (offset, append) => { globalThis.searchReload = [currentSearchQuery, offset, append]; };
  `);
  await ui.get('file-context-menu').fire('click', {
    target: { closest: () => ({ dataset: { fileAction: 'delete' } }) }
  });
  assert.equal(ui.run('mapTargets[0].folderId'), 2);
  assert.deepEqual(Array.from(ui.run('searchReload')), ['README', 0, false]);
  assert.equal(ui.run('currentScanId'), 9);
  assert.equal(ui.run('fileActionInProgress'), false);
});

test('failed cached view refresh reports a completed action without silently rescanning', async () => {
  const ui = loadUI({
    async deleteFile() { return { success: true, scanId: 9, parentFolderId: 0, item: null }; },
    async sortTree() { return { error: 'Snapshot unavailable' }; },
    refreshTree() { assert.fail('must not silently rescan'); }
  });

  test('uncertain native rename completion invalidates stale views and asks for explicit Rescan', async () => {
    const ui = loadUI({
      async renameFile() { return { error: 'Rename outcome uncertain. Rescan.', refreshRequired: true }; },
      refreshTree() { assert.fail('must not automatically rescan'); }
    });

    test('uncertain recycle completion clears stale views and never launches an automatic scan', async () => {
      const ui = loadUI({
        async deleteFile() { return { error: 'Recycle completion is uncertain. Rescan.', refreshRequired: true }; },
        refreshTree() { assert.fail('must not automatically rescan'); }
      });
      ui.run('window.alert = () => { throw new Error("Native alerts must not be used"); };');
      ui.run(`
        currentFolderPath = 'C:\\\\test'; currentScanId = 7; currentResult = { success: true };
        contextFile = { path: 'C:\\\\test\\\\old.txt' }; contextScanId = 7;
        virtualTree = { clear() {} }; diskTreemap = { clear() {} };
      `);
      await ui.get('file-context-menu').fire('click', {
        target: { closest: () => ({ dataset: { fileAction: 'delete' } }) }
      });
      assert.equal(ui.run('currentScanId'), null);
      assert.equal(ui.get('export-csv-btn').disabled, true);
      assert.match(ui.get('message-text').textContent, /Recycle completion is uncertain/);
      assert.equal(ui.get('message-dialog').open, true);
      assert.match(ui.get('file-tree').children[0].textContent, /Use Rescan/);
      assert.equal(ui.run('fileActionInProgress'), false);
    });
    ui.run(`
      currentFolderPath = 'C:\\\\test'; currentScanId = 7; currentResult = { success: true };
      contextFile = { path: 'C:\\\\test\\\\old.txt' }; contextScanId = 7;
      virtualTree = { clear() {} }; diskTreemap = { clear() {} };
    `);
    ui.get('rename-input').value = 'new.txt';
    await ui.get('rename-form').fire('submit');
    assert.equal(ui.run('currentScanId'), null);
    assert.equal(ui.run('currentResult'), null);
    assert.equal(ui.get('export-csv-btn').disabled, true);
    assert.equal(ui.get('rename-error').hidden, false);
    assert.match(ui.get('file-tree').children[0].textContent, /Use Rescan/);
  });
  ui.run(`
    currentFolderPath = 'C:\\\\test'; currentScanId = 8;
    contextFile = {path: 'C:\\\\test\\\\README'}; contextScanId = 8;
    virtualTree = {clear() {}};
    diskTreemap = {clear() {}};
  `);
  await ui.get('file-context-menu').fire('click', {
    target: { closest: () => ({ dataset: { fileAction: 'delete' } }) }
  });
  assert.match(ui.get('action-toast').textContent, /completed.*Snapshot unavailable/);
  assert.match(ui.get('file-tree').children[0].textContent, /Use Rescan/);
  assert.equal(ui.get('export-csv-btn').disabled, true);
  assert.equal(ui.run('fileActionInProgress'), false);
});
