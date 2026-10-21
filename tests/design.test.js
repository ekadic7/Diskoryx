const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const root = path.join(__dirname, '..');
const rendererRoot = path.join(root, 'src', 'renderer');
const mainRoot = path.join(root, 'src', 'main');
const preloadPath = path.join(root, 'src', 'preload', 'preload.js');
const baselineRoot = path.join(__dirname, 'fixtures', 'baseline');

test('preview retains original DOM hooks except the intentionally removed quick type filter', () => {
  const original = fs.readFileSync(path.join(baselineRoot, 'index.html'), 'utf8');
  const preview = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
  const ids = [...preview.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size, 'Duplicate element IDs');
  for (const match of original.matchAll(/\bid="([^"]+)"/g)) {
    if (['filter-select', 'live-status'].includes(match[1]) || match[1].startsWith('rename-')) continue;
    assert(ids.includes(match[1]), `Missing original integration hook: ${match[1]}`);
  }
  assert(!ids.includes('filter-select'));
  assert(!ids.includes('live-status'));
  assert(!preview.includes('class="preview-label"'));
});

test('explorer offers only name, size and date sorting with no quick type filter wiring', () => {
  const html = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
  const sort = /<select id="sort-select"[^>]*>([\s\S]*?)<\/select>/.exec(html)[1];
  assert.deepEqual([...sort.matchAll(/value="([^"]+)"/g)].map(match => match[1]), ['name', 'size', 'date']);
  const app = fs.readFileSync(path.join(rendererRoot, 'app.js'), 'utf8');
  assert(!app.includes('filter-select'));
  assert(!app.includes('filterByExtension('));
  assert(/data-view="largest"/.test(html));
  assert(/data-view="types"/.test(html));
  assert(html.includes('id="analysis-panel"'));
  assert(!app.includes('renderExtensionGroups'));
  assert(!app.includes('result.largestFiles'));
});

test('preview CSV and sorting stay byte-identical to working app', () => {
  for (const file of ['csv-export.js', 'tree-sort.js']) {
    assert(fs.readFileSync(path.join(mainRoot, file)).equals(fs.readFileSync(path.join(baselineRoot, file))), `Changed original behavior: ${file}`);
  }
});

test('preview bridge preserves original APIs with preview and scan cancellation additions', () => {
  const original = fs.readFileSync(path.join(baselineRoot, 'preload.js'), 'utf8');
  const preview = fs.readFileSync(preloadPath, 'utf8');
  const withoutConfirmation = preview.replace(/\ton(?:RecycleConfirmation(?:Closed)?|CopyProgress|LiveUpdate): \(callback\) => \{[\s\S]*?\n\t\},\r?\n/g, '');
  assert.equal(withoutConfirmation.replace(/\r\n/g, '\n')
    .replace(/^[ \t]*confirmRecycle:.*\n/gm, '')
    .replace(/^[ \t]*(?:analysisPage|actionHistory|restoreName):.*\n/gm, '')
    .replace(/^[ \t]*(?:listSavedScans|activateSavedScan):.*\n/gm, '')
    .replace(/^[ \t]*volumeCapacity:.*\n/gm, '')
    .replace(/^[ \t]*openSupportPage:.*\n/gm, '')
    .replace(/^[ \t]*moveHistoryAction:.*\n/gm, '')
    .replace(/^[ \t]*clearCopySelection:.*\n/gm, '')
    .replace(/^[ \t]*createFolder:.*\n/gm, '')
    .replace(/^[ \t]*(?:copyItem|pasteItem|cancelCopy|copyHistoryAction|restoreRecycledItem):.*\n/gm, '')
    .replace(/^[ \t]*(?:readTextPreview|cancelScan|renameFile|deleteFile):.*\n/gm, '')
    .replace(/, requestId/g, ''), original.replace(/\r\n/g, '\n')
    .replace(/^[ \t]*(?:renameFile|deleteFile):.*\n/gm, ''));
});

test('modifying file actions are restored with scan identity in the preload bridge', () => {
  const html = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(rendererRoot, 'app.js'), 'utf8');
  const preload = fs.readFileSync(preloadPath, 'utf8');
  assert(/data-file-action="rename"/.test(html));
  assert(/data-file-action="delete"/.test(html));
  assert(html.includes('id="rename-dialog"'));
  assert.match(preload, /rename-file', filePath, newName, scanId/);
  assert.match(preload, /delete-file', filePath, scanId/);
  assert.match(app, /deleteFile\(file.path, contextScanId\)/);
  assert.match(app, /data-file-action="copy-path"/);
});

test('Diskoryx has separate user data and a Windows installer build', () => {
  const main = fs.readFileSync(path.join(mainRoot, 'main.js'), 'utf8');
  assert.match(main, /Diskoryx V1/);
  const pkg = require('../package.json');
  assert.match(pkg.scripts['build:installer:win'], /scripts\/build-installer\.cjs/);
  assert.equal(pkg.build.productName, 'Diskoryx');
  assert.equal(pkg.build.nsis.perMachine, false);
  assert.equal(pkg.build.nsis.allowElevation, false);
  assert.equal(pkg.build.extraResources.length, 3);
});

test('preview icon classes resolve from local Font Awesome without a CDN', () => {
  const html = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
  assert(!/https?:\/\//.test(html));
  const css = fs.readFileSync(path.join(root, 'node_modules', '@fortawesome', 'fontawesome-free', 'css', 'all.min.css'), 'utf8');
  for (const icon of new Set(html.match(/\bfa-[a-z-]+/g))) {
    assert(css.includes(`.${icon}:before`), `Missing local icon: ${icon}`);
  }
});

function element() {
  return {
    style: {}, children: [], attributes: {},
    classList: { toggle() {} },
    append(...children) { this.children.push(...children); },
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener() {},
    replaceChildren() { this.children = []; },
    querySelector() { return this.children[0]; }
  };
}

test('file table retains row geometry and renders true sizes and bounded relative bars', () => {
  const context = { window: {}, document: { createElement: element } };
  vm.runInNewContext(fs.readFileSync(path.join(rendererRoot, 'virtual-tree.js'), 'utf8') + '\nglobalThis.Tree = VirtualTree;', context);
  const tree = {
    selectedPath: null, onFileSelect() {}, onFileContext() {},
    toggleFolder() {}, scheduleRender() {}
  };
  const row = context.Tree.prototype.renderRow.call(tree, {
    kind: 'item', level: 1,
    item: { type: 'file', name: 'report.csv', path: 'C:\\test\\report.csv', size: '2 KB', percentOfParent: 25 }
  }, 3);
  assert.equal(row.style.top, '96px');
  assert.equal(row.children[1].textContent, '2 KB');
  assert.equal(row.children[2].children[0].children[0].style.width, '25%');
  assert.equal(row.children[2].children[1].textContent, '25.0%');
});

test('preview empty treemap can resize safely before any scan', () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(rendererRoot, 'treemap.js'), 'utf8') + '\nglobalThis.Map = DiskTreemap;', context);
  const breadcrumb = element();
  assert.doesNotThrow(() => context.Map.prototype.renderBreadcrumb.call({ breadcrumb, page: undefined }));
  assert.equal(breadcrumb.children.length, 0);
});

test('sidebar navigation requests independent views without changing explorer sorting', () => {
  function node() {
    const listeners = new Map();
    return {
      ...element(), dataset: {}, value: '', textContent: '',
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      fire(type, event) { for (const fn of listeners.get(type) || []) fn(event); }
    };
  }
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, node());
    return nodes.get(id);
  };
  const buttons = [node()];
  buttons[0].dataset.view = 'explorer';
  const events = [];
  const document = {
    ...node(), getElementById: get, querySelector: get,
    querySelectorAll: () => buttons,
    dispatchEvent: event => events.push(event)
  };
  vm.runInNewContext(fs.readFileSync(path.join(rendererRoot, 'design.js'), 'utf8'), {
    window: { electronAPI: { volumeCapacity: async () => ({ success: true, totalBytes: 1024, availableBytes: 512, volumePath: 'C:\\' }) } },
    document,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    formatDuration: () => '1 s', formatRate: () => '100 items/s'
  });
  get('sort-select').value = 'size';
  buttons[0].fire('click');
  assert.equal(events[0].type, 'diskoryx:view');
  assert.equal(events[0].detail, 'explorer');
  assert.equal(get('sort-select').value, 'size');
  const result = {
    folderPath: 'C:\\', sortType: 'size', fileCount: 10, folderCount: 2,
    totalSizeFormatted: '1 KB', scanDurationMs: 10
  };
  document.fire('diskoryx:result', { detail: result });
  buttons[0].fire('click');
  assert.equal(events[1].detail, 'explorer');
  document.fire('diskoryx:result', { detail: { ...result, sortType: 'date' } });
  assert.equal(get('sort-select').value, 'size');
});

test('drive-capacity display uses actual volume data and ignores stale replies', async () => {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, {
      ...element(), textContent: '', hidden: false,
      setAttribute(key, value) { this.attributes[key] = value; }
    });
    return nodes.get(id);
  };
  const listeners = new Map();
  const document = {
    getElementById: get,
    querySelector: () => ({ style: { setProperty() {} }, addEventListener() {}, setAttribute() {} }),
    querySelectorAll: () => [],
    addEventListener(type, listener) { listeners.set(type, listener); }
  };
  const replies = [];
  const context = {
    window: { electronAPI: { volumeCapacity(scanId) {
      return new Promise(resolve => replies.push({ scanId, resolve }));
    } } },
    document,
    formatDuration: () => '1 s',
    formatRate: () => '100 items/s'
  };
  vm.runInNewContext(fs.readFileSync(path.join(rendererRoot, 'design.js'), 'utf8'), context);
  const dispatchResult = scanId => listeners.get('diskoryx:result')({ detail: {
    scanId, folderPath: 'C:\\', fileCount: 1, folderCount: 0, totalSizeFormatted: '1 KB',
    scanDurationMs: 10, totalSizeBytes: 1024
  } });

  dispatchResult(1);
  dispatchResult(2);
  replies[1].resolve({ success: true, volumePath: 'D:\\', totalBytes: 100 * 1024 ** 3, availableBytes: 25 * 1024 ** 3 });
  await new Promise(resolve => setImmediate(resolve));
  replies[0].resolve({ success: true, volumePath: 'C:\\', totalBytes: 200 * 1024 ** 3, availableBytes: 150 * 1024 ** 3 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(get('disk-capacity-card').hidden, false);
  assert.equal(get('capacity-volume').textContent, 'D:');
  assert.equal(get('capacity-free').textContent, '25 GB');
  assert.equal(get('capacity-total').textContent, 'free of 100 GB total');
  assert.equal(get('capacity-track').attributes['aria-valuenow'], '75');
  assert.equal(get('capacity-fill').style.width, '75%');
});
