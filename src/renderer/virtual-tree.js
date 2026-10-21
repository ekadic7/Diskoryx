const TREE_ROW_HEIGHT = 32;
const TREE_OVERSCAN = 8;
const TREE_PAGE_SIZE = 200;

function getVisibleRange(rowCount, scrollTop, viewportHeight) {
  const start = Math.max(0, Math.floor(scrollTop / TREE_ROW_HEIGHT) - TREE_OVERSCAN);
  const end = Math.min(rowCount, Math.ceil((scrollTop + viewportHeight) / TREE_ROW_HEIGHT) + TREE_OVERSCAN);
  return { start, end };
}

function buildVisibleRows(root) {
  if (!root) return [];
  const rows = [];
  const stack = [];
  for (let index = root.children.length - 1; index >= 0; index--) {
    stack.push({ kind: 'item', item: root.children[index], level: 0 });
  }

  while (stack.length) {
    const row = stack.pop();
    rows.push(row);
    if (row.kind !== 'item' || row.item.type !== 'folder' || !row.item.expanded) continue;

    if (row.item.childrenLoading) {
      stack.push({ kind: 'loading', item: row.item, level: row.level + 1 });
    } else if (row.item.loadError) {
      stack.push({ kind: 'error', item: row.item, level: row.level + 1 });
    } else if (row.item.childrenLoaded) {
      if (row.item.loadedCount < row.item.totalCount) {
        stack.push({ kind: 'more', item: row.item, level: row.level + 1 });
      }
      for (let index = row.item.children.length - 1; index >= 0; index--) {
        stack.push({ kind: 'item', item: row.item.children[index], level: row.level + 1 });
      }
    }
  }

  if (root.loadedCount < root.totalCount) rows.push({ kind: 'root-more', item: root, level: 0 });
  return rows;
}

class VirtualTree {
  constructor(container, api, onFileSelect, onFileContext = () => {}, onFolderToggle = () => {}, onAutoExpandProgress = () => {}) {
    this.container = container;
    this.api = api;
    this.onFileSelect = onFileSelect;
    this.onFileContext = onFileContext;
    this.onFolderToggle = onFolderToggle;
    this.onAutoExpandProgress = onAutoExpandProgress;
    this.scanId = null;
    this.sortType = 'name';
    this.extensions = [];
    this.rows = [];
    this.root = null;
    this.selectedPath = null;
    this.frameRequested = false;
    this.expandRequestId = 0;
    this.spacer = document.createElement('div');
    this.spacer.className = 'virtual-tree-spacer';
    this.container.addEventListener('scroll', () => this.scheduleRender(), { passive: true });
    this.container.classList.add('virtual-tree-container');
  }

  createNode(item) {
    return {
      ...item,
      children: item.type === 'folder' ? [] : undefined,
      childrenLoaded: false,
      childrenLoading: false,
      loadedCount: 0,
      totalCount: 0,
      expanded: false
    };
  }

  showRoot(result) {
    this.expandRequestId++;
    this.container.classList.add('virtual-tree-container');
    this.scanId = result.scanId;
    this.sortType = result.sortType || 'name';
    this.extensions = result.extensions || [];
    this.scanFilters = result.scanFilters || {};
    this.root = {
      folderId: 0,
      type: 'root',
      children: result.structure.map((item) => this.createNode(item)),
      childrenLoaded: true,
      childrenLoading: false,
      loadedCount: result.structure.length,
      totalCount: result.structureTotalCount,
      expanded: true
    };
    this.container.replaceChildren(this.spacer);
    this.container.scrollTop = 0;
    this.rebuildRows();
    if (this.extensions.length || this.scanFilters.includeExtensions.length) {
      this.expandMatchingFolders(this.onAutoExpandProgress);
    }
  }

  clear() {
    this.expandRequestId++;
    this.scanId = null;
    this.root = null;
    this.rows = [];
    this.container.classList.remove('virtual-tree-container');
    this.container.replaceChildren();
  }

  async revealItem(item) {
    if (!this.scanId || !this.root) return;
    const scanId = this.scanId;
    const root = this.root;
    const requestId = ++this.expandRequestId;
    const isCurrent = () => this.scanId === scanId && this.root === root && this.expandRequestId === requestId;
    const folderId = item.type === 'folder' ? item.folderId : item.parentFolderId;
    let ancestors = [];
    if (folderId > 0) {
      const result = await this.api.getFolderAncestors(scanId, folderId, this.extensions, this.scanFilters);
      if (!isCurrent()) return;
      if (!result.success) throw new Error(result.error || 'Unable to locate this folder.');
      ancestors = result.ancestors;
    }
    const targets = item.type === 'file' ? [...ancestors, item] : ancestors;
    let parent = root;
    let selected = null;
    for (const target of targets) {
      let child = parent.children.find(node => node.path === target.path);
      while (!child && (!parent.childrenLoaded || parent.loadedCount < parent.totalCount)) {
        const offset = parent.childrenLoaded ? parent.loadedCount : 0;
        const page = await this.api.getFolderPage(
          scanId, parent.folderId, offset, TREE_PAGE_SIZE, this.sortType, this.extensions, this.scanFilters
        );
        if (!isCurrent()) return;
        if (!page.success) throw new Error(page.error || 'Unable to load this folder.');
        if (!page.items.length) throw new Error('The selected item is no longer visible in this scan.');
        const nodes = page.items.map(value => this.createNode(value));
        parent.children = offset ? parent.children.concat(nodes) : nodes;
        parent.loadedCount = offset + nodes.length;
        parent.totalCount = page.totalCount;
        parent.childrenLoaded = true;
        parent.loadError = null;
        child = parent.children.find(node => node.path === target.path);
      }
      if (!child) throw new Error('The selected item is hidden by the current filters or no longer available.');
      parent.expanded = true;
      selected = child;
      parent = child;
    }
    if (!isCurrent()) return;
    if (selected?.type === 'folder') {
      selected.expanded = true;
      if (!selected.childrenLoaded) {
        await this.loadPage(selected, false, false);
        if (!isCurrent()) return;
        if (selected.loadError) throw new Error(selected.loadError);
      }
    }
    this.selectedPath = selected?.path || null;
    this.rebuildRows();
    const index = this.rows.findIndex(row => row.kind === 'item' && row.item.path === this.selectedPath);
    this.container.scrollTop = Math.max(0, index * TREE_ROW_HEIGHT - this.container.clientHeight / 2);
    this.scheduleRender();
  }

  rebuildRows() {
    if (!this.root) return;
    this.rows = buildVisibleRows(this.root);
    this.scheduleRender();
  }

  scheduleRender(reset = false) {
    if (this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame(() => {
      this.frameRequested = false;
      this.renderWindow(reset);
    });
  }

  renderWindow(reset) {
    if (!this.root) return;
    const viewportHeight = this.container.clientHeight || 600;
    const { start, end } = getVisibleRange(this.rows.length, this.container.scrollTop, viewportHeight);
    const fragment = document.createDocumentFragment();
    this.spacer.style.height = `${Math.max(this.rows.length * TREE_ROW_HEIGHT, viewportHeight)}px`;

    for (let index = start; index < end; index++) {
      fragment.append(this.renderRow(this.rows[index], index));
    }
    this.spacer.replaceChildren(fragment);
    if (reset) this.container.scrollTop = 0;
  }

  renderRow(row, index) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = row.kind === 'item' ? `virtual-tree-row is-${row.item.type}` : 'virtual-tree-row is-action';
    if (row.flat) button.classList.add('result-file-row');
    else button.style.top = `${index * TREE_ROW_HEIGHT}px`;
    button.style.paddingLeft = `${12 + row.level * 18}px`;

    if (row.kind === 'loading') {
      button.textContent = 'Loading folder...';
      button.disabled = true;
    } else if (row.kind === 'error') {
      button.textContent = `Could not load ${row.item.name}. Click to retry.`;
      button.addEventListener('click', () => this.loadPage(row.item, false));
    } else if (row.kind === 'more' || row.kind === 'root-more') {
      const remaining = row.item.totalCount - row.item.loadedCount;
      button.textContent = `Load next ${Math.min(TREE_PAGE_SIZE, remaining)} items`;
      button.addEventListener('click', () => this.loadPage(row.item, true));
    } else if (row.item.type === 'folder') {
      button.setAttribute('aria-expanded', String(row.item.expanded));
      const icon = document.createElement('i');
      icon.className = row.item.expanded ? 'fas fa-folder-open' : 'fas fa-folder';
      icon.setAttribute('aria-hidden', 'true');
      const nameCell = document.createElement('span');
      nameCell.className = 'tree-cell tree-cell-name';
      const label = document.createElement('span');
      label.textContent = row.item.name;
      const chevron = document.createElement('i');
      chevron.className = 'fas fa-chevron-right tree-chevron';
      chevron.setAttribute('aria-hidden', 'true');
      nameCell.append(chevron, icon, label);
      button.append(nameCell);
      button.addEventListener('click', () => this.toggleFolder(row.item));
      button.addEventListener('contextmenu', (event) => this.onFileContext(row.item, event));
    } else {
      const icon = document.createElement('i');
      icon.className = 'far fa-file';
      icon.setAttribute('aria-hidden', 'true');
      const nameCell = document.createElement('span');
      nameCell.className = 'tree-cell tree-cell-name';
      const label = document.createElement('span');
      label.textContent = row.item.name;
      if (row.flat) {
        const description = document.createElement('span');
        description.className = 'result-file-description';
        const location = document.createElement('small');
        location.textContent = row.item.path;
        description.append(label, location);
        nameCell.append(icon, description);
      } else {
        nameCell.append(icon, label);
      }
      button.append(nameCell);
      button.addEventListener('click', () => this.onFileSelect(row.item));
      button.addEventListener('contextmenu', (event) => this.onFileContext(row.item, event));
    }

    if (row.kind === 'item') {
      button.style.paddingLeft = '12px';
      button.querySelector('.tree-cell-name').style.paddingLeft = `${row.level * 18 + (row.item.type === 'file' ? 14 : 0)}px`;
      button.title = row.item.path;
      button.classList.toggle('is-selected', row.item.path === this.selectedPath);
      button.addEventListener('click', () => {
        this.selectedPath = row.item.path;
        if (row.flat) {
          for (const sibling of button.parentElement.querySelectorAll('.result-file-row')) {
            sibling.classList.toggle('is-selected', sibling === button);
          }
        } else {
          this.scheduleRender();
        }
      });
      const sizeCell = document.createElement('span');
      sizeCell.className = 'tree-cell-size';
      sizeCell.textContent = row.item.size;
      const shareCell = document.createElement('span');
      shareCell.className = 'tree-cell-share';
      const percentage = Math.max(0, Math.min(100, row.item.percentOfParent || 0));
      const track = document.createElement('span');
      track.className = 'share-track';
      const fill = document.createElement('span');
      fill.className = 'share-fill';
      fill.style.width = `${percentage}%`;
      track.append(fill);
      const value = document.createElement('span');
      value.className = 'share-value';
      value.textContent = `${percentage.toFixed(1)}%`;
      shareCell.append(track, value);
      button.append(sizeCell, shareCell);
    }

    return button;
  }

  async toggleFolder(folder) {
    folder.expanded = !folder.expanded;
    this.rebuildRows();
    const treemapNavigation = this.onFolderToggle(folder, folder.expanded);
    if (folder.expanded && !folder.childrenLoaded) await this.loadPage(folder, false);
    await treemapNavigation;
  }

  async loadPage(folder, append, render = true) {
    if (folder.childrenLoading) return false;
    const scanId = this.scanId;
    const root = this.root;
    folder.childrenLoading = true;
    if (render) this.rebuildRows();
    const offset = append ? folder.loadedCount : 0;
    let loaded = false;

    try {
      const result = await this.api.getFolderPage(
        scanId,
        folder.folderId,
        offset,
        TREE_PAGE_SIZE,
        this.sortType,
        this.extensions,
        this.scanFilters
      );
      if (this.scanId !== scanId || this.root !== root) return false;
      if (result.scanId && result.scanId !== this.scanId) return false;
      if (!result.success) throw new Error(result.error || 'Unable to load folder.');
      const newChildren = result.items.map((item) => this.createNode(item));
      folder.children = append ? folder.children.concat(newChildren) : newChildren;
      folder.loadedCount = offset + newChildren.length;
      folder.totalCount = result.totalCount;
      folder.childrenLoaded = true;
      folder.loadError = null;
      loaded = true;
    } catch (error) {
      folder.childrenLoaded = false;
      folder.loadError = error.message;
    } finally {
      folder.childrenLoading = false;
      if (render) this.rebuildRows();
    }
    return loaded;
  }

  async expandMatchingFolders(onProgress = () => {}) {
    if (!this.root) return;
    const requestId = ++this.expandRequestId;
    let expandedCount = 0;
    onProgress({ active: true, expandedCount, pendingCount: this.root.children.length });

    while (this.root.loadedCount < this.root.totalCount) {
      if (requestId !== this.expandRequestId) return;
      const loaded = await this.loadPage(this.root, true, false);
      if (!loaded || !this.root.loadedCount) break;
    }

    const pendingFolders = [...this.root.children].filter((item) => item.type === 'folder').reverse();
    while (pendingFolders.length) {
      if (requestId !== this.expandRequestId) return;
      const batch = pendingFolders.splice(0, 3);
      await Promise.all(batch.map(async (folder) => {
        folder.expanded = true;
        if (!folder.childrenLoaded) await this.loadPage(folder, false, false);
        while (folder.childrenLoaded && folder.loadedCount < folder.totalCount) {
          const loaded = await this.loadPage(folder, true, false);
          if (!loaded) break;
        }
        if (folder.childrenLoaded) {
          for (let index = folder.children.length - 1; index >= 0; index--) {
            const child = folder.children[index];
            if (child.type === 'folder') pendingFolders.push(child);
          }
        }
        expandedCount++;
      }));
      this.rebuildRows();
      onProgress({ active: true, expandedCount, pendingCount: pendingFolders.length });
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    if (requestId === this.expandRequestId) {
      this.rebuildRows();
      onProgress({ active: false, expandedCount, pendingCount: 0 });
    }
  }

  async setLoadedFoldersExpanded(expanded, onProgress = () => {}) {
    if (!this.root) return;
    const folders = [];
    const pending = [...this.root.children];
    while (pending.length) {
      const item = pending.pop();
      if (item.type !== 'folder') continue;
      folders.push(item);
      if (item.childrenLoaded) pending.push(...item.children);
    }

    for (let offset = 0; offset < folders.length; offset += 3) {
      const batch = folders.slice(offset, offset + 3);
      await Promise.all(batch.map(async (folder) => {
        folder.expanded = expanded;
        if (expanded && !folder.childrenLoaded) await this.loadPage(folder, false);
      }));
      this.rebuildRows();
      onProgress(Math.min(offset + batch.length, folders.length), folders.length);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TREE_PAGE_SIZE, TREE_ROW_HEIGHT, VirtualTree, buildVisibleRows, getVisibleRange };
} else {
  window.VirtualTree = VirtualTree;
}
