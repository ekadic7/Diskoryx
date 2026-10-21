const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(overrides = {}) {
  const elements = new Map();
  function element() {
    const listeners = new Map();
    return {
      children: [], hidden: false, disabled: false, open: false, value: '', textContent: '',
      addEventListener(type, listener) { listeners.set(type, listener); },
      fire(type, event = {}) { return listeners.get(type)?.(event); },
      append(...children) { this.children.push(...children); },
      replaceChildren() { this.children = []; },
      setAttribute() {},
      querySelectorAll() { return this.children; },
      showModal() { this.open = true; },
      close() { this.open = false; this.fire('close'); },
      focus() { this.focused = true; }
    };
  }
  function get(id) {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  }
  const pages = [];
  const transfers = [];
  const busy = [];
  const events = new Map();
  const roots = [{ folderPath: 'C:\\sample', active: true }, { folderPath: 'D:\\target', active: false }];
  const context = {
    document: { getElementById: get, createElement: element,
      addEventListener: (name, listener) => events.set(name, listener) },
    copiedItemName: 'source.txt', copiedItemPath: 'C:\\sample\\source.txt', transferMode: 'move',
    scanInProgress: false, fileActionInProgress: false, currentScanId: 7,
    currentFolderPath: 'C:\\sample', sortRequestId: 0, currentSearchQuery: '',
    setFileActionBusy(value) { busy.push(value); context.fileActionInProgress = value; },
    renderResult(result) { context.currentScanId = result.scanId; context.currentFolderPath = result.folderPath; },
    pasteIntoFolder: async (...args) => { transfers.push(args); },
    window: { electronAPI: {
      listSavedScans: async () => ({ success: true, scans: roots }),
      activateSavedScan: async folderPath => ({ success: true, folderPath, scanId: 8 }),
      getFolderPage: async (...args) => {
        pages.push(args);
        return { success: true, offset: args[2], totalCount: 2, items: args[1] === 0
          ? [{ type: 'folder', name: 'empty <literal>', path: 'C:\\sample\\empty', folderId: 5 },
            { type: 'file', name: 'source.txt', path: 'C:\\sample\\source.txt' }] : [] };
      },
      ...overrides
    } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'destination.js'), 'utf8'), context);
  return { get, context, pages, transfers, busy, fire: name => events.get(name)?.(),
    open: () => get('choose-destination').fire('click'),
    async settle() { await new Promise(resolve => setImmediate(resolve)); } };
}

test('destination picker shows exact path, only folders and explicit Move here without transferring on open', async () => {
  const f = fixture();
  await f.open();
  assert.equal(f.get('destination-dialog').open, true);
  assert.equal(f.get('destination-cancel').focused, true);
  assert.equal(f.get('destination-source').textContent, 'Moving: C:\\sample\\source.txt');
  assert.equal(f.get('destination-path').textContent, 'C:\\sample');
  assert.equal(f.get('destination-confirm').textContent, 'Move here');
  assert.equal(f.get('destination-confirm').disabled, false);
  assert.equal(f.get('destination-folders').children.length, 1);
  assert.equal(f.get('destination-folders').children[0].children[1].textContent, 'empty <literal>');
  assert.equal(f.get('destination-more').hidden, true);
  assert.equal(f.transfers.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(f.pages[0])), [7, 0, 0, 200, 'name', [], {}]);
  f.get('destination-folders').children[0].fire('click');
  await f.settle();
  assert.equal(f.get('destination-path').textContent, 'C:\\sample\\empty');
  assert.match(f.get('destination-status').textContent, /No subfolders/);
  assert.equal(f.get('destination-confirm').disabled, false);
  f.get('destination-up').fire('click');
  await f.settle();
  assert.equal(f.get('destination-path').textContent, 'C:\\sample');
  f.get('destination-folders').children[0].fire('click');
  await f.settle();
  await f.get('destination-confirm').fire('click');
  assert.equal(f.get('destination-dialog').open, false);
  assert.deepEqual(f.transfers, [[5, 7]]);
});

test('Copy here uses the displayed root and Cancel keeps selection without filesystem actions', async () => {
  const f = fixture();
  f.context.transferMode = 'copy';
  await f.open();
  assert.equal(f.get('destination-confirm').textContent, 'Copy here');
  f.get('destination-cancel').fire('click');
  assert.equal(f.transfers.length, 0);
  assert.equal(f.context.copiedItemName, 'source.txt');
  await f.open();
  await f.get('destination-confirm').fire('click');
  assert.deepEqual(f.transfers, [[0, 7]]);
});

test('changing scanned locations rebinds the revision before confirmation and does not start a scan', async () => {
  const f = fixture();
  await f.open();
  f.get('destination-location').value = 'D:\\target';
  await f.get('destination-location').fire('change');
  assert.deepEqual(f.busy, [true, false]);
  assert.equal(f.get('destination-path').textContent, 'D:\\target');
  assert.equal(f.context.currentSearchQuery, '');
  assert.equal(f.context.currentScanId, 8);
  assert.equal(f.get('destination-confirm').disabled, false);
  await f.get('destination-confirm').fire('click');
  assert.deepEqual(f.transfers, [[0, 8]]);
});

test('folder load failure and a changed scan explicitly refuse confirmation', async () => {
  const f = fixture({ getFolderPage: async () => ({ error: 'Folder expired <literal>' }) });
  await f.open();
  assert.equal(f.get('destination-error').textContent, 'Folder expired <literal>');
  assert.equal(f.get('destination-confirm').disabled, true);
  await f.get('destination-confirm').fire('click');
  assert.equal(f.transfers.length, 0);
  const fresh = fixture();
  await fresh.open();
  fresh.context.currentScanId++;
  await fresh.get('destination-confirm').fire('click');
  assert.equal(fresh.transfers.length, 0);
  assert.match(fresh.get('destination-error').textContent, /scan changed/);
});

test('cancel during a pending folder request discards late results and cannot enable confirmation', async () => {
  let release;
  const f = fixture({ getFolderPage: () => new Promise(resolve => { release = resolve; }) });
  const opening = f.open();
  await f.settle();
  assert.equal(f.get('destination-confirm').disabled, true);
  f.get('destination-cancel').fire('click');
  release({ success: true, items: [], offset: 0, totalCount: 0 });
  await opening;
  await f.get('destination-confirm').fire('click');
  assert.equal(f.transfers.length, 0);
  assert.equal(f.get('destination-dialog').open, false);
});

test('location-switch failure keeps confirmation disabled and permits cancellation', async () => {
  const f = fixture({ activateSavedScan: async () => ({ error: 'Location unavailable' }) });
  await f.open();
  await f.get('destination-location').fire('change');
  assert.equal(f.get('destination-error').textContent, 'Location unavailable');
  assert.equal(f.get('destination-confirm').disabled, true);
  assert.equal(f.get('destination-cancel').disabled, false);
  assert.deepEqual(f.busy, [true, false]);
});

test('folder paging appends folders and Up resets pagination', async () => {
  const f = fixture({ getFolderPage: async (_scan, folder, offset) => ({
    success: true, offset, totalCount: folder === 0 ? 201 : 0,
    items: folder === 0 ? Array.from({ length: offset ? 1 : 200 }, (_, index) => ({
      type: 'folder', name: `folder-${offset + index}`, path: `C:\\sample\\folder-${offset + index}`,
      folderId: offset + index + 1
    })) : []
  }) });
  await f.open();
  assert.equal(f.get('destination-more').hidden, false);
  f.get('destination-more').fire('click');
  await f.settle();
  assert.equal(f.get('destination-folders').children.length, 201);
  assert.equal(f.get('destination-more').hidden, true);
  f.get('destination-folders').children[200].fire('click');
  await f.settle();
  f.get('destination-up').fire('click');
  await f.settle();
  assert.equal(f.get('destination-folders').children.length, 200);
  assert.equal(f.get('destination-more').hidden, false);
});

test('live snapshot refresh keeps the chosen folder and binds confirmation to the refreshed revision', async () => {
  const f = fixture();
  await f.open();
  f.get('destination-folders').children[0].fire('click');
  await f.settle();
  f.fire('diskoryx:files-changed');
  assert.equal(f.get('destination-confirm').disabled, true);
  f.context.currentScanId = 9;
  f.fire('diskoryx:result');
  await f.settle();
  assert.equal(f.get('destination-path').textContent, 'C:\\sample\\empty');
  assert.equal(f.get('destination-confirm').disabled, false);
  await f.get('destination-confirm').fire('click');
  assert.deepEqual(f.transfers, [[5, 9]]);
});
