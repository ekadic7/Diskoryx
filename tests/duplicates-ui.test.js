const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('Duplicate Finder provides a drive selector and an explicit content-read notice', () => {
  const html = read('src', 'renderer', 'index.html');
  assert.match(html, /data-view="duplicates"[^>]*>[\s\S]*?Duplicate finder/);
  const panel = /<section id="duplicates-panel"[\s\S]*?<\/section>/.exec(html);
  assert(panel, 'Duplicate Finder panel is missing');
  assert.match(panel[0], /id="duplicates-drive-select"[^>]*disabled/);
  assert.match(panel[0], /id="find-duplicates-btn"[^>]*disabled/);
  assert.match(panel[0], /choose a local drive/i);
  assert.match(panel[0], /id="duplicates-scope-select"/);
  assert.match(panel[0], /value="user" selected/);
  assert.match(panel[0], /Entire drive \(includes system files\)/);
  assert.match(panel[0], /completed full-drive scan is reused without scanning directories again/i);
  assert.match(panel[0], /reads candidate file contents/i);
  assert.match(panel[0], /Windows may download online-only cloud files/i);
  assert.match(panel[0], /No files are changed or deleted/);
  assert.match(panel[0], /Matching contents can have different names/);
  assert.match(panel[0], /Windows Installer caches and application files may be required/);
  assert.match(panel[0], /Logical bytes in extra copies/);
  assert.match(panel[0], /<details class="duplicates-info"><summary>Info/);
  assert.match(panel[0], /id="duplicates-chart"/);
  assert.match(html, /<script src="duplicates-ui\.js"><\/script>/);
});

test('Duplicate analysis uses an explicitly selected local drive and offers no file actions', () => {
  const ui = read('src', 'renderer', 'duplicates-ui.js');
  assert.match(ui, /window\.electronAPI\.listDrives\(\)/);
  assert.match(ui, /window\.electronAPI\.findDuplicates\(drivePath, requestId, scope\)/);
  assert.doesNotMatch(ui, /deleteFile|copyItem|moveHistoryAction|restoreRecycledItem/);
  assert.match(ui, /setScanControls\(true\)/);
  assert.match(ui, /window\.electronAPI\.onDuplicateProgress/);
  assert.match(ui, /result\.cancelled/);
  assert.match(ui, /diskoryx:files-changed/);

  const main = read('src', 'main', 'main.js');
  assert.match(main, /ipcMain\.handle\('find-duplicates'/);
  assert.match(main, /async function listLocalDrives\(\)/);
  assert.match(main, /find\(drive => drive\.path\.toLowerCase\(\) === drivePath\.toLowerCase\(\)\)/);
  assert.match(main, /const volumeRoot = selectedDrive\.path/);
  assert.match(main, /scanLocation\(volumeRoot, event, normalizeScanFilters\(\{\}\), job\)/);
  assert.match(main, /findDuplicates\(volumeRoot/);
  assert.match(main, /activeScanJob = job/);
});

test('Duplicate results use theme variables and avoid claiming physical disk savings', () => {
  const css = read('src', 'renderer', 'styles', 'design.css');
  assert.match(css, /\.duplicates-table/);
  assert.match(css, /background: var\(--surface-raised\)/);
  const ui = read('src', 'renderer', 'duplicates-ui.js');
  assert.match(ui, /not an estimate of physical disk space freed/i);
});

function loadDuplicateUI(result) {
  class Element {
    constructor(tag = 'div') {
      this.tag = tag;
      this.children = [];
      this.listeners = {};
      this.style = {};
      this.value = '';
      this.hidden = false;
      this.open = false;
      this.ownText = '';
    }
    set textContent(value) { this.ownText = String(value); this.children = []; }
    get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.ownText = ''; this.children = children; }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    async fire(type) { await this.listeners[type]?.({}); }
    setAttribute(name, value) { this[name] = value; }
    querySelector(tag) {
      for (const child of this.children) {
        if (child.tag === tag) return child;
        const found = child.querySelector(tag);
        if (found) return found;
      }
      return null;
    }
    scrollIntoView() {}
    focus() { this.focused = true; }
  }
  const elements = new Map();
  const events = {};
  const get = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  let calls = 0;
  const context = {
    document: {
      getElementById: get,
      createElement: tag => new Element(tag),
      addEventListener: (type, listener) => { events[type] = listener; }
    },
    window: { electronAPI: {
      findDuplicates: async () => { calls++; return result; },
      onDuplicateProgress() {}
    } },
    scanInProgress: false, fileActionInProgress: false, cancellationRequested: false,
    scanRequestId: 0, scanOperation: 'scan', setScanControls() {}
  };
  get('duplicates-sort').value = 'bytes';
  vm.runInNewContext(read('src', 'renderer', 'duplicates-ui.js'), context);
  get('duplicates-drive-select').value = 'C:\\';
  get('duplicates-scope-select').value = 'user';
  return { get, events, run: () => get('find-duplicates-btn').fire('click'), calls: () => calls };
}

function duplicateResult(length = 15576) {
  const groups = Array.from({ length }, (_, index) => ({
    copyCount: index % 4 + 2, sizeBytes: 100, duplicateLogicalBytes: index * 100,
    paths: [`C:\\Documents\\file-${String(index).padStart(5, '0')}.txt`, `C:\\Copies\\copy-${index}.txt`]
  }));
  return { success: true, groups, filesScanned: length * 2, skippedCount: 0, unverified: [],
    scopePath: 'C:\\', scope: 'user', excludedFileCount: 10, inventoryReused: true,
    duplicateLogicalBytes: groups.reduce((sum, group) => sum + group.duplicateLogicalBytes, 0) };
}

test('15,576 groups render only 50 rows and 10 correctly scaled bars; paths load on demand', async () => {
  const ui = loadDuplicateUI(duplicateResult());
  await ui.run();
  assert.equal(ui.get('duplicates-results').hidden, false);
  assert.equal(ui.get('duplicates-groups').textContent, '15,576');
  assert.match(ui.get('duplicates-status').textContent, /Based on last drive scan; Rescan for newer files\./);
  assert.equal(ui.get('duplicates-rows').children.length, 50);
  assert.equal(ui.get('duplicates-chart').children.length, 10);
  const bars = ui.get('duplicates-chart').children;
  assert.equal(bars[0].children[1].children[0].style.width, '100%');
  const secondWidth = parseFloat(bars[1].children[1].children[0].style.width);
  assert.ok(secondWidth < 100 && secondWidth > 99);
  const details = ui.get('duplicates-rows').children[0].querySelector('details');
  assert.equal(details.children.length, 1);
  await bars[0].fire('click');
  const opened = ui.get('duplicates-rows').children[0].querySelector('details');
  assert.equal(opened.open, true);
  assert.equal(opened.querySelector('summary').focused, true);
  assert.match(opened.textContent, /C:\\Copies\\copy-15575/);
  assert.equal(ui.calls(), 1);
});

test('fresh duplicate inventory does not claim it reused the last drive scan', async () => {
  const ui = loadDuplicateUI({ ...duplicateResult(1), inventoryReused: false });
  await ui.run();
  assert.doesNotMatch(ui.get('duplicates-status').textContent, /last drive scan|Rescan for newer files/);
});

test('pagination, path search and sorting reuse the results without rescanning; chart opens the right page', async () => {
  const ui = loadDuplicateUI(duplicateResult(121));
  await ui.run();
  await ui.get('duplicates-next').fire('click');
  assert.match(ui.get('duplicates-page').textContent, /51.*100/);
  await ui.get('duplicates-next').fire('click');
  assert.equal(ui.get('duplicates-rows').children.length, 21);
  assert.equal(ui.get('duplicates-next').disabled, true);
  await ui.get('duplicates-prev').fire('click');
  assert.equal(ui.get('duplicates-rows').children.length, 50);
  ui.get('duplicates-sort').value = 'copies';
  await ui.get('duplicates-sort').fire('change');
  assert.equal(ui.get('duplicates-rows').children[0].children[0].textContent, '5');
  ui.get('duplicates-sort').value = 'name';
  await ui.get('duplicates-sort').fire('change');
  await ui.get('duplicates-chart').children[0].fire('click');
  assert.match(ui.get('duplicates-page').textContent, /101.*121/);
  assert.ok(ui.get('duplicates-rows').children.some(row => row.querySelector('details').open));
  ui.get('duplicates-query').value = 'COPIES\\COPY-119.TXT';
  await ui.get('duplicates-query').fire('input');
  assert.equal(ui.get('duplicates-rows').children.length, 1);
  assert.match(ui.get('duplicates-rows').textContent, /file-00119/);
  ui.get('duplicates-query').value = 'no such file';
  await ui.get('duplicates-query').fire('input');
  assert.equal(ui.get('duplicates-chart').children.length, 0);
  assert.match(ui.get('duplicates-page').textContent, /No matching/);
  assert.equal(ui.calls(), 1);
  ui.events['diskoryx:files-changed']();
  assert.equal(ui.get('duplicates-results').hidden, true);
  assert.equal(ui.get('duplicates-rows').children.length, 0);
});

test('zero-byte groups have finite zero-width bars and filenames remain literal text', async () => {
  const result = duplicateResult(1);
  result.groups[0].paths = ['C:\\<img onerror=bad>.txt', 'C:\\copy.txt'];
  const ui = loadDuplicateUI(result);
  await ui.run();
  const bar = ui.get('duplicates-chart').children[0];
  assert.equal(bar.children[1].children[0].style.width, '0%');
  assert.match(bar.children[0].textContent, /<img onerror=bad>/);
  assert.equal(ui.get('duplicates-prev').disabled, true);
  assert.equal(ui.get('duplicates-next').disabled, true);
});

test('an analysis with no duplicate groups keeps summary visible with an empty list', async () => {
  const ui = loadDuplicateUI(duplicateResult(0));
  await ui.run();
  assert.equal(ui.get('duplicates-results').hidden, false);
  assert.equal(ui.get('duplicates-groups').textContent, '0');
  assert.equal(ui.get('duplicates-bytes').textContent, '0 B');
  assert.equal(ui.get('duplicates-chart').children.length, 0);
  assert.equal(ui.get('duplicates-rows').children.length, 0);
  assert.equal(ui.get('duplicates-next').disabled, true);
});
