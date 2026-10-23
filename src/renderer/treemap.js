const TREEMAP_PAGE_SIZE = 100;
const MIN_TILE_WIDTH = 72;
const MIN_TILE_HEIGHT = 48;
const SMALL_GROUP_MIN_SHARE = 0.12;
const TREEMAP_COLORS = ['#a799e5', '#8b9ec6', '#9986d0', '#699e9c', '#b59bc1', '#809ac6', '#7aaea0', '#c0a67e', '#ab8fa6', '#91a5c0', '#a2a786', '#bc9d8f'];

class DiskTreemap {
  constructor(container, breadcrumb, api, onFileSelect, smallItemsButton, onFileContext = () => {}, onFolderSelect = () => {}) {
    this.container = container;
    this.breadcrumb = breadcrumb;
    this.api = api;
    this.onFileSelect = onFileSelect;
    this.onFileContext = onFileContext;
    this.onFolderSelect = onFolderSelect;
    this.smallItemsButton = smallItemsButton;
    this.scanId = null;
    this.rootPath = '';
    this.rootSize = 0;
    this.extensions = [];
    this.frames = [];
    this.requestId = 0;
    this.groupedItems = [];
    this.smallItemsMode = false;
    this.resizeObserver = new ResizeObserver(() => {
      this.renderTiles();
      this.renderBreadcrumb();
    });
    this.resizeObserver.observe(container);
    this.smallItemsButton.addEventListener('click', () => {
      if (this.smallItemsMode) {
        this.smallItemsMode = false;
        this.renderBreadcrumb();
        this.renderTiles();
      } else {
        this.showSmallItems();
      }
    });
  }

  showRoot(result) {
    this.scanId = result.scanId;
    this.extensions = result.extensions || [];
    this.scanFilters = result.scanFilters || {};
    this.rootPath = result.folderPath;
    this.rootSize = result.totalSizeBytes;
    this.frames = [{
      folderId: 0,
      name: result.folderPath,
      path: result.folderPath,
      rawSize: result.totalSizeBytes,
      totalCount: result.fileCount + result.folderCount,
      pages: [{ offset: 0, rawSize: result.totalSizeBytes }]
    }];
    this.loadCurrentPage();
  }

  clear() {
    this.requestId++;
    this.scanId = null;
    this.frames = [];
    this.breadcrumb.replaceChildren();
    this.container.replaceChildren();
    this.groupedItems = [];
    this.smallItemsMode = false;
    this.updateSmallItemsButton();
  }

  get frame() {
    return this.frames[this.frames.length - 1];
  }

  get page() {
    return this.frame?.pages[this.frame.pages.length - 1];
  }

  async navigateToFolder(folder) {
    if (!this.scanId || !folder.folderId) return;
    const requestId = ++this.requestId;
    try {
      const result = await this.api.getFolderAncestors(
        this.scanId, folder.folderId, this.extensions, this.scanFilters
      );
      if (requestId !== this.requestId || !result.success) return;
      this.frames = [{
        folderId: 0,
        name: this.rootPath,
        path: this.rootPath,
        rawSize: this.rootSize,
        pages: [{ offset: 0, rawSize: this.rootSize }]
      }, ...result.ancestors.map((ancestor) => ({
        folderId: ancestor.folderId,
        name: ancestor.name,
        path: ancestor.path,
        rawSize: ancestor.rawSize,
        pages: [{ offset: 0, rawSize: ancestor.rawSize }]
      }))];
      await this.loadCurrentPage();
    } catch (error) {
      if (requestId === this.requestId) {
        this.container.replaceChildren();
        const message = document.createElement('p');
        message.className = 'treemap-message';
        message.textContent = `Unable to sync folder view: ${error.message}`;
        this.container.append(message);
      }
    }
  }

  returnToParent(folderId) {
    const frameIndex = this.frames.findIndex((frame) => frame.folderId === folderId);
    if (frameIndex <= 0) return;
    this.frames = this.frames.slice(0, frameIndex);
    this.loadCurrentPage();
  }

  async loadCurrentPage() {
    const requestId = ++this.requestId;
    const frame = this.frame;
    const page = this.page;
    this.container.replaceChildren();
    const loading = document.createElement('p');
    loading.className = 'treemap-message';
    loading.textContent = 'Building treemap...';
    this.container.append(loading);

    try {
      const result = await this.api.getFolderPage(
        this.scanId,
        frame.folderId,
        page.offset,
        TREEMAP_PAGE_SIZE,
        'size',
        this.extensions,
        this.scanFilters
      );
      if (requestId !== this.requestId || !this.scanId) return;
      if (!result.success) throw new Error(result.error || 'Unable to load this folder.');

      frame.totalCount = result.totalCount;
      page.items = result.items;
      page.otherSize = Math.max(0, page.rawSize - result.items.reduce((sum, item) => sum + item.rawSize, 0));
      this.smallItemsMode = false;
      this.renderTiles();
      this.renderBreadcrumb();
    } catch (error) {
      if (requestId !== this.requestId) return;
      this.container.replaceChildren();
      const message = document.createElement('p');
      message.className = 'treemap-message';
      message.textContent = `Treemap unavailable: ${error.message}`;
      this.container.append(message);
    }
  }

  renderBreadcrumb() {
    this.breadcrumb.replaceChildren();
    if (!this.page) return;
    this.frames.forEach((frame, index) => {
      if (index) {
        const separator = document.createElement('span');
        separator.className = 'treemap-breadcrumb-separator';
        separator.textContent = '/';
        this.breadcrumb.append(separator);
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'treemap-breadcrumb-item';
      button.textContent = frame.name;
      button.disabled = index === this.frames.length - 1 && this.page.offset === 0;
      button.addEventListener('click', () => {
        this.frames = this.frames.slice(0, index + 1);
        this.loadCurrentPage();
        this.onFolderSelect({ type: 'folder', folderId: frame.folderId });
      });
      this.breadcrumb.append(button);
    });

    if (this.page.offset > 0) {
      const previous = document.createElement('button');
      previous.type = 'button';
      previous.className = 'treemap-page-back';
      previous.textContent = 'Previous group';
      previous.addEventListener('click', () => {
        this.frame.pages.pop();
        this.loadCurrentPage();
      });
      this.breadcrumb.append(previous);
    }
  }

  updateSmallItemsButton() {
    this.smallItemsButton.hidden = !this.smallItemsMode && this.groupedItems.length === 0;
    this.smallItemsButton.textContent = this.smallItemsMode
      ? 'Back to map'
      : `Select small items (${this.groupedItems.length})`;
    this.smallItemsButton.title = this.smallItemsMode
      ? 'Return to the treemap'
      : 'Open a selectable list of items whose tiles are too small to click';
  }

  renderTiles() {
    if (!this.page?.items || !this.container.clientWidth || !this.container.clientHeight) return;
    if (this.smallItemsMode) {
      this.renderSmallItems();
      this.updateSmallItemsButton();
      return;
    }
    const visibleItems = this.page.items.map((item) => ({
      kind: item.type,
      name: item.name,
      value: item.rawSize,
      item
    }));
    if (this.page.otherSize > 0) {
      visibleItems.push({
        kind: 'other',
        name: 'Other items',
        value: this.page.otherSize
      });
    }

    if (!visibleItems.length) {
      this.groupedItems = [];
      this.updateSmallItemsButton();
      this.container.replaceChildren();
      const empty = document.createElement('p');
      empty.className = 'treemap-message';
      empty.textContent = 'This folder has no items to visualize.';
      this.container.append(empty);
      return;
    }

    // Grouping one pass can shrink the remaining tiles (the Small items tile takes space),
    // so repeat until every ungrouped tile meets the minimum size.
    this.groupedItems = [];
    let layoutRoot = this.layoutItems(visibleItems);
    for (;;) {
      const tooSmall = (layoutRoot.children || []).filter((node) => node.data.kind !== 'small-group' &&
        (node.x1 - node.x0 < MIN_TILE_WIDTH || node.y1 - node.y0 < MIN_TILE_HEIGHT));
      if (!tooSmall.length) break;
      this.groupedItems.push(...tooSmall.map((node) => node.data));
      const groupedData = visibleItems.filter((item) => !this.groupedItems.includes(item));
      const groupValue = this.groupedItems.reduce((total, item) => total + item.value, 0);
      const visibleTotal = visibleItems.reduce((total, item) => total + item.value, 0);
      const minimumLayoutValue = visibleTotal * SMALL_GROUP_MIN_SHARE / (1 - SMALL_GROUP_MIN_SHARE);
      groupedData.push({
        kind: 'small-group',
        name: 'Small items',
        value: groupValue,
        layoutValue: Math.max(groupValue, minimumLayoutValue),
        items: this.groupedItems
      });
      layoutRoot = this.layoutItems(groupedData);
    }

    this.drawLayout(layoutRoot);
    this.updateSmallItemsButton();
  }

  layoutItems(items) {
    const root = window.d3.hierarchy({ children: items }).sum((item) => item.layoutValue ?? item.value ?? 0);
    window.d3.treemap()
      .tile(window.d3.treemapSquarify)
      .size([this.container.clientWidth, this.container.clientHeight])
      .paddingOuter(5)
      .paddingInner(3)
      .paddingTop((node) => node.depth === 1 ? 24 : 0)
      .round(true)(root);
    return root;
  }

  drawLayout(root) {
    const fragment = document.createDocumentFragment();
    for (const node of root.children || []) fragment.append(this.createTile(node));
    this.container.replaceChildren(fragment);
  }

  showSmallItems() {
    this.smallItemsMode = true;
    this.renderBreadcrumb();
    this.updateSmallItemsButton();
    this.renderSmallItems();
  }

  renderSmallItems() {
    this.container.replaceChildren();
    const list = document.createElement('div');
    list.className = 'treemap-small-list';
    for (const item of this.groupedItems) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `treemap-small-item is-${item.kind}`;
      button.title = `${item.name} (${this.formatSize(item.value)})`;
      const name = document.createElement('span');
      name.textContent = item.name;
      const size = document.createElement('span');
      size.textContent = this.formatSize(item.value);
      button.append(name, size);
      button.addEventListener('click', () => this.activateTile(item));
      if (item.kind === 'file' || item.kind === 'folder') {
        button.addEventListener('contextmenu', (event) => this.onFileContext(item.item, event));
      }
      list.append(button);
    }
    this.container.append(list);
  }

  createTile(node) {
    const data = node.data;
    const tile = document.createElement('button');
    const width = Math.max(0, node.x1 - node.x0);
    const height = Math.max(0, node.y1 - node.y0);
    tile.type = 'button';
    tile.className = `treemap-tile is-${data.kind}${width < 90 || height < 56 ? ' is-compact' : ''}`;
    tile.style.left = `${node.x0}px`;
    tile.style.top = `${node.y0}px`;
    tile.style.width = `${width}px`;
    tile.style.height = `${height}px`;
    if (data.kind === 'folder') tile.style.setProperty('--tile-color', TREEMAP_COLORS[0]);
    else if (data.kind === 'other') tile.style.setProperty('--tile-color', '#56636a');
    else if (data.kind === 'small-group') tile.style.setProperty('--tile-color', '#526d82');
    else tile.style.setProperty('--tile-color', this.colorForExtension(data.item.extension));

    const size = this.formatSize(data.value);
    const percent = this.frame.rawSize ? `${(data.value / this.frame.rawSize * 100).toFixed(1)}%` : '0%';
    tile.title = data.kind === 'small-group'
      ? `${data.items.length} small items\nActual size: ${size} (${percent})\nTile enlarged for accessibility`
      : `${data.name}\n${size} (${percent})`;
    const title = document.createElement('span');
    title.className = 'treemap-tile-name';
    title.textContent = data.kind === 'small-group' ? `Small items (${data.items.length})` : data.name;
    tile.append(title);
    if (!tile.classList.contains('is-compact')) {
      const metadata = document.createElement('span');
      metadata.className = 'treemap-tile-size';
      metadata.textContent = data.kind === 'small-group' ? size : `${size} · ${percent}`;
      tile.append(metadata);
    }

    tile.addEventListener('click', () => this.activateTile(data));
    if (data.kind === 'file' || data.kind === 'folder') {
      tile.addEventListener('contextmenu', (event) => this.onFileContext(data.item, event));
    }
    return tile;
  }

  activateTile(data) {
    if (data.kind === 'folder') {
      this.frames.push({
        folderId: data.item.folderId,
        name: data.name,
        rawSize: data.item.rawSize,
        totalCount: 0,
        pages: [{ offset: 0, rawSize: data.item.rawSize }]
      });
      this.loadCurrentPage();
      this.onFolderSelect(data.item);
    } else if (data.kind === 'other') {
      const previousPage = this.page;
      this.frame.pages.push({
        offset: previousPage.offset + previousPage.items.length,
        rawSize: previousPage.otherSize
      });
      this.loadCurrentPage();
    } else if (data.kind === 'small-group') {
      this.showSmallItems();
    } else {
      this.onFileSelect(data.item);
    }
  }

  colorForExtension(extension) {
    let hash = 0;
    for (const character of extension || '') hash = (hash * 31 + character.charCodeAt(0)) | 0;
    return TREEMAP_COLORS[Math.abs(hash) % (TREEMAP_COLORS.length - 1) + 1];
  }

  formatSize(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / (1024 ** index)).toFixed(1)} ${units[index]}`;
  }
}

window.DiskTreemap = DiskTreemap;
