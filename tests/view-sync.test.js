const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function load(name, symbol) {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', name), 'utf8') + `\nglobalThis.Component = ${symbol};`, context);
  return context.Component;
}
const Tree = load('virtual-tree.js', 'VirtualTree');
const MapView = load('treemap.js', 'DiskTreemap');
const folder = (id, path) => ({ type: 'folder', folderId: id, path, name: path.split('\\').at(-1) });
const a = folder(1, 'C:\\a');
const b = folder(2, 'C:\\a\\b');
const file = { type: 'file', parentFolderId: 2, path: 'C:\\a\\b\\test.txt', name: 'test.txt' };

function tree(api) {
  const instance = Object.create(Tree.prototype);
  Object.assign(instance, {
    api, scanId: 1, sortType: 'size', extensions: [], scanFilters: {},
    expandRequestId: 0, selectedPath: null,
    container: { scrollTop: 0, clientHeight: 32 },
    root: {
      folderId: 0, children: [], childrenLoaded: true, loadedCount: 0, totalCount: 1, expanded: true
    },
    rows: [], scheduleRender() {}, rebuildRows() {
      this.rows = [];
      const visit = node => {
        for (const child of node.children || []) {
          this.rows.push({ kind: 'item', item: child });
          if (child.expanded) visit(child);
        }
      };
      visit(this.root);
    }
  });
  return instance;
}

test('map selection reveals deep files through ancestor and sibling pages without navigation callbacks', async () => {
  const calls = [];
  const instance = tree({
    async getFolderAncestors() { return { success: true, ancestors: [a, b] }; },
    async getFolderPage(scanId, id, offset, limit, sort) {
      calls.push({ scanId, id, offset, limit, sort });
      if (id === 0) return { success: true, items: [a], totalCount: 1 };
      if (id === 1) return { success: true, items: [b], totalCount: 1 };
      if (offset === 0) return {
        success: true, items: [{ ...file, path: 'C:\\a\\b\\other.txt' }], totalCount: 2
      };
      return { success: true, items: [file], totalCount: 2 };
    }
  });
  instance.onFolderToggle = () => assert.fail('must not navigate back to the map');
  await instance.revealItem(file);
  assert.equal(instance.selectedPath, file.path);
  assert.equal(instance.root.children[0].expanded, true);
  assert.equal(instance.root.children[0].children[0].expanded, true);
  assert.deepEqual(calls.map(call => [call.id, call.offset]), [[0, 0], [1, 0], [2, 0], [2, 1]]);
  assert(calls.every(call => call.sort === 'size' && call.scanId === 1 && call.limit === 200));
  assert(instance.container.scrollTop > 0);
});

test('folder reveal expands its children and root breadcrumb returns table to the top', async () => {
  const instance = tree({
    async getFolderAncestors() { return { success: true, ancestors: [a] }; },
    async getFolderPage(_scanId, id) {
      return { success: true, items: id === 0 ? [a] : [b], totalCount: 1 };
    }
  });
  await instance.revealItem(a);
  assert.equal(instance.selectedPath, a.path);
  assert.equal(instance.root.children[0].childrenLoaded, true);
  assert.equal(instance.root.children[0].children[0].folderId, 2);
  await instance.revealItem({ type: 'folder', folderId: 0 });
  assert.equal(instance.selectedPath, null);
  assert.equal(instance.container.scrollTop, 0);
});

test('late reveals cannot overwrite a newer selection or a new scan', async () => {
  let release;
  const instance = tree({
    getFolderAncestors: () => new Promise(resolve => { release = resolve; })
  });

  const old = instance.revealItem(a);
  await instance.revealItem({ type: 'folder', folderId: 0 });
  release({ success: true, ancestors: [a] });
  await old;
  assert.equal(instance.selectedPath, null);
  assert.equal(instance.root.children.length, 0);
  const next = instance.revealItem(a);
  instance.scanId = 2;
  release({ success: true, ancestors: [a] });
  await next;
  assert.equal(instance.root.children.length, 0);
});

test('folder pages started before a mutation cannot populate the new snapshot', async () => {
  let release;
  const instance = tree({
    getFolderPage: () => new Promise(resolve => { release = resolve; })
  });
  const oldFolder = instance.createNode(a);
  instance.root.children = [oldFolder];
  const loading = instance.loadPage(oldFolder, false);
  instance.scanId = 2;
  instance.root = { folderId: 0, children: [], loadedCount: 0, totalCount: 0 };
  release({ success: true, items: [file], totalCount: 1 });
  assert.equal(await loading, false);
  assert.equal(oldFolder.children.length, 0);
  assert.equal(instance.root.children.length, 0);
});

test('reveal reports unavailable items explicitly instead of selecting another row', async () => {
  const instance = tree({
    async getFolderAncestors() { return { success: true, ancestors: [a] }; },
    async getFolderPage() { return { success: false, error: 'Scan expired' }; }
  });
  await assert.rejects(instance.revealItem(a), /Scan expired/);
  assert.equal(instance.selectedPath, null);
});

test('only user folder activation notifies reverse synchronization, not automatic map navigation', () => {
  const selected = [];
  let loads = 0;
  const instance = {
    frames: [], onFolderSelect: item => selected.push(item),
    onFileSelect: item => selected.push(item), loadCurrentPage() { loads++; }
  };
  MapView.prototype.activateTile.call(instance, { kind: 'folder', item: a, name: a.name });
  assert.equal(selected[0], a);
  assert.equal(loads, 1);
  MapView.prototype.activateTile.call(instance, { kind: 'file', item: file });
  assert.equal(selected[1], file);
});

test('treemap regroups until no visible tile is below the minimum size', () => {
  // A squeezed layout: each tile's width shrinks as more items are laid out, like a narrow column.
  const squeeze = (items, width) => {
    const total = items.reduce((sum, node) => sum + node.value, 0);
    let x = 0;
    return items.map((node) => {
      const w = Math.max(1, Math.round(width * node.value / total));
      const out = { data: node.data, value: node.value, x0: x, x1: x + w, y0: 0, y1: 300 };
      x += w;
      return out;
    });
  };
  const context = { window: { d3: {
    hierarchy: (data) => {
      const root = { children: data.children.map((item) => ({ data: item, value: item.layoutValue ?? item.value })) };
      root.sum = () => root;
      return root;
    },
    treemap: () => {
      let size = [0, 0];
      const api = (root) => {
        const children = squeeze(root.children.map((child) => ({ data: child.data, value: child.value })), size[0]);
        root.children = children;
        return root;
      };
      api.tile = () => api;
      api.size = (s) => { size = s; return api; };
      api.paddingOuter = () => api; api.paddingInner = () => api; api.paddingTop = () => api; api.round = () => api;
      return api;
    },
    treemapSquarify: () => {}
  } } };
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'treemap.js'), 'utf8');
  vm.runInNewContext(source + '\nglobalThis.Map = DiskTreemap;', context);
  const Map = context.Map;
  const sizes = [60, 30, 8, 1, 1, 1, 1];
  const page = { items: sizes.map((rawSize, i) => ({ type: 'folder', name: `d${i}`, rawSize })), otherSize: 0 };
  const instance = Object.create(Map.prototype);
  Object.assign(instance, {
    frames: [{ rawSize: 101, pages: [page] }], smallItemsMode: false, groupedItems: [],
    container: { clientWidth: 500, clientHeight: 300, replaceChildren() {}, append() {} },
    smallItemsButton: {}, formatSize: (value) => String(value), colorForExtension: () => '#000',
    updateSmallItemsButton() {}, drawLayout(root) { this.drawn = root; }
  });
  instance.renderTiles();
  assert.ok(instance.drawn, 'layout should be drawn');
  for (const node of instance.drawn.children) {
    if (node.data.kind === 'small-group') continue;
    assert.ok(node.x1 - node.x0 >= 72, `tile ${node.data.name} is narrower than the minimum`);
  }
});
