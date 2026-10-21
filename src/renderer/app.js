const treeContainer = document.getElementById('file-tree');
const statsBadge = document.getElementById('stats-badge');
const filesLoaded = document.getElementById('files-loaded');
const lastUpdated = document.getElementById('last-updated');
const actionToast = document.getElementById('action-toast');
const treeTitle = document.querySelector('#tree-title span');
const driveSelect = document.getElementById('drive-select');
const scanDriveButton = document.getElementById('scan-drive-btn');
const stopScanButton = document.getElementById('stop-scan-btn');
const exportCsvButton = document.getElementById('export-csv-btn');
const detailsPanel = document.getElementById('file-details');
const emptyDetails = detailsPanel.querySelector('.empty-state');
const treemapCanvas = document.getElementById('treemap-canvas');
const treemapBreadcrumb = document.getElementById('treemap-breadcrumb');
const treemapSmallItemsButton = document.getElementById('treemap-small-items-btn');
const fileContextMenu = document.getElementById('file-context-menu');
const renameDialog = document.getElementById('rename-dialog');
const createFolderDialog = document.getElementById('create-folder-dialog');
const createFolderForm = document.getElementById('create-folder-form');
const createFolderName = document.getElementById('create-folder-name');
const createFolderError = document.getElementById('create-folder-error');
const renameForm = document.getElementById('rename-form');
const renameInput = document.getElementById('rename-input');
const renameError = document.getElementById('rename-error');
const messageDialog = document.getElementById('message-dialog');
const scanFiltersDialog = document.getElementById('scan-filters-dialog');
const scanFiltersForm = document.getElementById('scan-filters-form');
const includeExtensionsInput = document.getElementById('include-extensions');
const excludeExtensionsInput = document.getElementById('exclude-extensions');
const excludeFoldersInput = document.getElementById('exclude-folders');
const scanFiltersError = document.getElementById('scan-filters-error');

let currentFolderPath = null;
let currentResult = null;
let currentScanId = null;
let currentSortType = 'name';
let currentExtensions = [];
let currentSearchQuery = '';
let currentScanFilters = loadSavedScanFilters();
let sortRequestId = 0;
let virtualTree = null;
let diskTreemap = null;

let contextFile = null;
let contextScanId = null;
let fileActionInProgress = false;
let actionToastTimeout = null;
let resolveFolderName = null;

function requestNewFolderName(parentPath) {
  if (createFolderDialog.open || resolveFolderName) return Promise.resolve(null);
  document.getElementById('create-folder-parent').textContent = `Create inside: ${parentPath}`;
  createFolderError.hidden = true;
  createFolderName.value = '';
  createFolderDialog.showModal();
  createFolderName.focus();
  return new Promise(resolve => { resolveFolderName = resolve; });
}

function finishFolderName(value) {
  const resolve = resolveFolderName;
  resolveFolderName = null;
  if (createFolderDialog.open) createFolderDialog.close();
  resolve?.(value);
}

createFolderForm.addEventListener('submit', event => {
  event.preventDefault();
  if (!resolveFolderName) return;
  finishFolderName(createFolderName.value);
});
document.getElementById('create-folder-cancel').addEventListener('click', () => finishFolderName(null));
createFolderDialog.addEventListener('cancel', event => {
  event.preventDefault();
  finishFolderName(null);
});
createFolderDialog.addEventListener('close', () => {
  if (resolveFolderName) finishFolderName(null);
});

async function createFolderInScan(folderId, onError, expectedScanId = currentScanId, parentPath) {
  const reportError = onError || (error => showAppMessage(error, 'Folder not created'));
  if (!expectedScanId || scanInProgress || fileActionInProgress) return null;
  const scanId = expectedScanId;
  const folder = currentResult?.folderPath;
  const targetPath = parentPath || diskTreemap?.frames?.find(frame => frame.folderId === folderId)?.path || folder;
  const name = await requestNewFolderName(targetPath);
  if (name === null) return null;
  if (scanId !== currentScanId || scanInProgress || fileActionInProgress) {
    reportError('The scan changed. Choose the folder again before creating a new folder.');
    return null;
  }
  setFileActionBusy(true);
  try {
    const result = await window.electronAPI.createFolder(scanId, folderId, name);
    if (!result.success) throw new Error(result.error || 'Unable to create the folder.');
    if (result.refreshRequired) invalidateFileActionView();
    else if (result.snapshotChanged) await refreshAfterFileAction(result);
    if (result.warning) reportError(result.warning);
    else if (result.hiddenByFilters && !onError) reportError('Folder created, but the active scan filters hide it. Adjust the filters and rescan to browse it.');
    else if (!result.snapshotChanged) showActionToast(result.actionLabel || 'Folder created');
    return result;
  } catch (failure) {
    reportError(failure.message);
    return null;
  } finally {
    setFileActionBusy(false);
  }
}

function showAppMessage(message, title = 'Unable to complete action') {
  document.getElementById('message-title').textContent = title;
  document.getElementById('message-text').textContent = message;
  if (!messageDialog.open) messageDialog.showModal();
  document.getElementById('message-close').focus();
}

function showActionToast(message) {
  actionToast.textContent = message;
  actionToast.hidden = false;
  clearTimeout(actionToastTimeout);
  actionToastTimeout = setTimeout(() => {
    actionToast.hidden = true;
  }, 2200);
}

function loadSavedScanFilters() {
  const emptyFilters = { includeExtensions: [], excludeExtensions: [], excludeFolderNames: [] };
  try {
    const saved = JSON.parse(
      window.localStorage.getItem('diskoryx.scanFilters')
      ?? window.localStorage.getItem('filevisor.scanFilters')
      ?? 'null'
    );
    if (!saved || typeof saved !== 'object') return emptyFilters;
    return {
      includeExtensions: Array.isArray(saved.includeExtensions) ? saved.includeExtensions : [],
      excludeExtensions: Array.isArray(saved.excludeExtensions) ? saved.excludeExtensions : [],
      excludeFolderNames: Array.isArray(saved.excludeFolderNames) ? saved.excludeFolderNames : []
    };
  } catch {
    return emptyFilters;
  }
}

function parseFilterList(value) {
  return [...new Set(String(value || '').split(',').map((item) => item.trim()).filter(Boolean))];
}

function populateScanFiltersForm() {
  includeExtensionsInput.value = currentScanFilters.includeExtensions.join(', ');
  excludeExtensionsInput.value = currentScanFilters.excludeExtensions.join(', ');
  excludeFoldersInput.value = currentScanFilters.excludeFolderNames.join(', ');
  scanFiltersError.hidden = true;
}

function showMessage(message, isLoading = false) {
  treeContainer.replaceChildren();
  const paragraph = document.createElement('p');
  paragraph.className = isLoading ? 'tree-message is-loading' : 'tree-message';
  paragraph.textContent = message;
  treeContainer.append(paragraph);
}

function formatDuration(milliseconds) {
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.floor(seconds % 60)}s`;
}

function formatRate(entriesPerSecond) {
  return `${Math.round(entriesPerSecond).toLocaleString()} items/s`;
}

const SEARCH_PAGE_SIZE = 200;

function appendLoadMore(parent, label, onClick) {
  const moreButton = document.createElement('button');
  moreButton.type = 'button';
  moreButton.className = 'tree-load-more';
  moreButton.textContent = label;
  moreButton.addEventListener('click', () => {
    moreButton.remove();
    onClick();
  }, { once: true });
  parent.append(moreButton);
}

function renderFiles(items, parent) {
  document.getElementById('share-column-label').textContent = 'Of scan';
  const totalSize = currentResult?.totalSizeBytes || 0;
  for (const item of items) {
    const fileButton = virtualTree.renderRow({
      kind: 'item', level: 0, flat: true,
      item: { ...item, percentOfParent: totalSize > 0 ? item.rawSize / totalSize * 100 : 0 }
    }, 0);
    parent.append(fileButton);
  }
}

function showFileContextMenu(file, event) {
  event.preventDefault();
  if (scanInProgress || fileActionInProgress) return;
  contextFile = file;
  contextScanId = currentScanId;
  for (const button of fileContextMenu.querySelectorAll('[data-file-action]')) {
    button.hidden = (button.dataset.fileAction === 'paste' || button.dataset.fileAction === 'create-folder')
      && file.type !== 'folder';
  }
  updatePasteAvailability();
  showFileDetails(file);
  fileContextMenu.hidden = false;
  const bounds = fileContextMenu.getBoundingClientRect();
  fileContextMenu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - bounds.width - 8))}px`;
  fileContextMenu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - bounds.height - 8))}px`;
  fileContextMenu.querySelector('[data-file-action="copy-path"]').focus();
}

fileContextMenu.addEventListener('click', async (event) => {
  const actionButton = event.target.closest('[data-file-action]');
  if (!actionButton || !contextFile || scanInProgress) return;
  const file = contextFile;
  fileContextMenu.hidden = true;
  const action = actionButton.dataset.fileAction;

  if (action === 'create-folder') {
    void createFolderInScan(file.folderId, undefined, contextScanId, file.path);
    return;
  }

  if (action === 'paste') {
    await pasteIntoFolder(file.folderId, contextScanId);
    return;
  }
  if (action === 'copy-path') {
    try {
      const result = await window.electronAPI.copyPath(file.path);
      if (result.success) showActionToast('Path copied to clipboard');
      else showAppMessage(result.error || 'Unable to copy path.');
    } catch (error) {
      showAppMessage(error.message);
    }
    return;
  }
  if (action === 'copy' || action === 'move') {
    try {
      const result = await window.electronAPI.copyItem(file.path, contextScanId, action);
      if (!result.success) throw new Error(result.error || 'Unable to copy selection.');
      copiedItemName = result.name;
      copiedItemPath = file.path;
      transferMode = action;
      updatePasteAvailability();
      showActionToast(`${result.name} selected. Use "Choose where to ${action}..." beside the file tree.`);
    } catch (error) { showAppMessage(error.message); }
    return;
  }

  if (action === 'reveal') {
    try {
      const result = await window.electronAPI.revealInExplorer(file.path);
      if (result.success) showActionToast(file.type === 'folder' ? 'Folder opened in Explorer' : 'File revealed in Explorer');
      else showAppMessage(result.error || 'Unable to open Explorer.');
    } catch (error) {
      showAppMessage(error.message);
    }
    return;
  }

  if (action === 'rename') {
    renameInput.value = file.name;
    renameError.hidden = true;
    renameDialog.showModal();
    renameInput.focus();
    renameInput.select();
    return;
  }
  if (action !== 'delete' || fileActionInProgress) return;
  setFileActionBusy(true);
  try {
    const result = await window.electronAPI.deleteFile(file.path, contextScanId);
    if (result.cancelled) return;
    if (result.refreshRequired) invalidateFileActionView();
    if (!result.success) throw new Error(result.error || 'Unable to recycle item.');
    await refreshAfterFileAction(result);
  } catch (error) {
    showAppMessage(error.message);
  } finally {
    setFileActionBusy(false);
  }
});

async function refreshAfterFileAction(action) {
  const mapFolderId = diskTreemap?.frame?.folderId || 0;
  const query = currentSearchQuery;
  ++sortRequestId;
  currentScanId = action.scanId;
  currentResult = null;
  document.dispatchEvent(new Event('diskoryx:files-changed'));
  emptyDetails.hidden = true;
  detailsPanel.querySelector('.file-details-content')?.remove();
  contextFile = null;
  contextScanId = null;
  try {
    const result = await window.electronAPI.sortTree(
      currentFolderPath, currentSortType, currentScanId, currentExtensions, currentScanFilters
    );
    if (!result.success) throw new Error(result.error || 'Unable to update the cached view.');
    renderResult(result);
    if (mapFolderId) {
      const ancestors = await window.electronAPI.getFolderAncestors(
        currentScanId, mapFolderId, currentExtensions, currentScanFilters
      );
      const folderId = ancestors.success ? mapFolderId : action.parentFolderId;
      if (folderId) await diskTreemap.navigateToFolder({ folderId });
    }
    if (query) {
      await loadSearchPage(0, false);
    } else {
      const selection = action.item || { type: 'folder', folderId: action.parentFolderId };
      await virtualTree.revealItem(selection);
    }
    if (action.item) showFileDetails(action.item);
    showActionToast(action.actionLabel || (action.item ? 'Item renamed' : 'Item moved to Recycle Bin'));
  } catch (error) {
    showActionToast(`File action completed, but the view could not be updated: ${error.message}`);
    if (!currentResult) {
      virtualTree?.clear();
      diskTreemap?.clear();
      exportCsvButton.disabled = true;
      showMessage('File action completed. Use Rescan to reload the view.');
    }
  }
  if (action.historyWarning) showAppMessage(action.historyWarning, 'Action completed; history not saved');
}

document.getElementById('rename-cancel').addEventListener('click', () => renameDialog.close());
function invalidateFileActionView() {
  currentScanId = null;
  currentResult = null;
  ++sortRequestId;
  virtualTree?.clear();
  diskTreemap?.clear();
  document.dispatchEvent(new Event('diskoryx:files-changed'));
  emptyDetails.hidden = true;
  detailsPanel.querySelector('.file-details-content')?.remove();
  showMessage('File action completion could not be confirmed. Use Rescan before another file action.');
}

renameForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!contextFile || scanInProgress || fileActionInProgress) return;
  setFileActionBusy(true);
  const submit = renameForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const result = await window.electronAPI.renameFile(contextFile.path, renameInput.value, contextScanId);
    if (result.refreshRequired) invalidateFileActionView();
    if (!result.success) throw new Error(result.error || 'Unable to rename item.');
    renameDialog.close();
    if (!result.unchanged) await refreshAfterFileAction(result);
  } catch (error) {
    renameError.textContent = error.message;
    renameError.hidden = false;
  } finally {
    setFileActionBusy(false);
    submit.disabled = false;
  }
});

document.addEventListener('pointerdown', (event) => {
  if (!fileContextMenu.hidden && !fileContextMenu.contains(event.target)) fileContextMenu.hidden = true;
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') fileContextMenu.hidden = true;
});

async function loadSearchPage(offset, append) {
  const scanId = currentScanId;
  const query = currentSearchQuery;
  const requestId = sortRequestId;
  try {
    const result = await window.electronAPI.searchFiles(
      scanId, query, currentExtensions, offset, SEARCH_PAGE_SIZE, currentScanFilters
    );
    if (scanInProgress || requestId !== sortRequestId || scanId !== currentScanId || query !== currentSearchQuery) return;
    if (!result.success) {
      showMessage(result.error || 'Search failed.');
      return;
    }
    if (!append) {
      virtualTree.clear();
      treeContainer.replaceChildren();
    }
    renderFiles(result.results, treeContainer);
    const nextOffset = offset + result.results.length;
    if (nextOffset < result.totalCount) {
      appendLoadMore(treeContainer, `Load next ${Math.min(SEARCH_PAGE_SIZE, result.totalCount - nextOffset)} matches`, () => {
        loadSearchPage(nextOffset, true);
      });
    }
    treeTitle.textContent = `${result.totalCount.toLocaleString()} search results`;
    if (!result.totalCount) showMessage('No matching files.');
  } catch (error) {
    if (!scanInProgress && requestId === sortRequestId && scanId === currentScanId) showMessage(`Search failed: ${error.message}`);
  }
}

function showFileDetails(file) {
  emptyDetails.hidden = true;
  let content = detailsPanel.querySelector('.file-details-content');
  if (!content) {
    content = document.createElement('div');
    content.className = 'file-details-content';
    detailsPanel.append(content);
  }
  content.replaceChildren();
  const rows = Object.entries({
    Name: file.name,
    Path: file.path,
    Size: file.size,
      Modified: file.humanDate || (file.date ? new Date(file.date).toLocaleString() : '—'),
    Old: file.isOld ? 'Yes' : 'No'
  });
  if (file.hardLinkCount > 1) {
    rows.push([
      'Hard links',
      `${file.hardLinkCount} | ${file.isHardLinkAlias ? 'space counted at another path' : 'space counted here'}`
    ]);
  }
  for (const [label, value] of rows) {
    const row = document.createElement('p');
    const key = document.createElement('span');
    key.className = 'property-label';
    key.textContent = label;
    const text = document.createElement('span');
    text.className = 'property-value';
    text.textContent = value;
    row.append(key, text);
    content.append(row);
  }
  document.dispatchEvent(new CustomEvent('diskoryx:selection', { detail: { file, scanId: currentScanId } }));
}

async function syncTreemapToTreeFolder(folder, expanded) {
  if (expanded) await diskTreemap?.navigateToFolder(folder);
  else diskTreemap?.returnToParent(folder.folderId);
}

function updateMatchExpansionProgress(progress) {
  treeTitle.textContent = progress.active
    ? `File Structure · expanding matches (${progress.expandedCount})`
    : 'File Structure';
}

function updateScanMode(result) {
  const badge = document.getElementById('scan-mode');
  badge.hidden = !result?.scanMode;
  if (badge.hidden) {
    badge.textContent = '';
    badge.title = '';
    return;
  }
  const fast = result.scanMode === 'mft';
  const label = fast ? 'Fast \u00b7 MFT' : 'Standard \u00b7 Filesystem';
  badge.textContent = result.scanModeReason ? `${label} \u2014 ${result.scanModeReason}` : label;
  badge.title = badge.textContent;
}

async function syncTreeToMapItem(item) {
  if (scanInProgress || fileActionInProgress || !currentScanId) return;
  const scanId = currentScanId;
  const requestId = ++sortRequestId;
  try {
    if (!virtualTree.root) {
      const result = await window.electronAPI.sortTree(
        currentFolderPath, 'name', scanId, [], currentScanFilters
      );
      if (scanInProgress || requestId !== sortRequestId || scanId !== currentScanId) return;
      if (!result.success) throw new Error(result.error || 'Unable to open the file tree.');
      currentSearchQuery = '';
      document.getElementById('search-input').value = '';
      renderResult(result, false);
    }
    await virtualTree.revealItem(item);
  } catch (error) {
    if (!scanInProgress && requestId === sortRequestId && scanId === currentScanId) {
      showActionToast(`Unable to sync file tree: ${error.message}`);
    }
  }
}

function renderResult(result, updateMap = true) {
  if (!result || !result.success) {
    updateScanMode(null);
    exportCsvButton.disabled = true;
    showMessage(result?.error || 'Unable to scan this folder.');
    return;
  }

  exportCsvButton.disabled = false;
  updateScanMode(result);
  currentResult = result;
  currentFolderPath = result.folderPath;
  currentScanId = result.scanId;
  currentSortType = result.sortType || 'name';
  currentExtensions = [];
  document.getElementById('sort-select').value = currentSortType;
  if (result.scanFilters) currentScanFilters = result.scanFilters;
  document.getElementById('share-column-label').textContent = 'Of parent';
  treeTitle.textContent = 'File Structure';
  if (result.structure?.length) {
    virtualTree.showRoot(result);
  } else {
    virtualTree.clear();
    showMessage('No files found in this folder.');
  }

  const skippedText = result.skippedCount ? ` | ${result.skippedCount} skipped entries` : '';
  const filteredText = result.filteredCount || result.excludedFolderCount
    ? ` | Filtered ${result.filteredCount || 0} files / ${result.excludedFolderCount || 0} folders`
    : '';
  statsBadge.textContent = `${result.fileCount} files | ${result.totalSizeFormatted}${skippedText}${filteredText}`;
  filesLoaded.textContent = `Files loaded: ${result.fileCount}`;
  filesLoaded.textContent += ` | ${formatDuration(result.scanDurationMs)} | ${formatRate(result.entriesPerSecond)}`;
  lastUpdated.textContent = `Last updated: ${new Date().toLocaleTimeString()}`;
  if (updateMap) diskTreemap?.showRoot(result);
  document.dispatchEvent(new CustomEvent('diskoryx:result', { detail: result }));
}

let scanInProgress = false;
let scanRequestId = 0;
let cancellationRequested = false;
let folderDialogOpen = false;
const scanControls = [
  'scan-drive-btn', 'drive-select', 'folder-picker-btn', 'refresh-btn',
  'scan-filters-btn', 'sort-select', 'search-input',
  'search-btn', 'export-csv-btn', 'expand-all-btn', 'collapse-all-btn',
  'collapse-tree-folders-btn', 'choose-drives-btn', 'saved-scans-select'
].map(id => document.getElementById(id));
const disabledBeforeScan = new Map();
const disabledBeforeFileAction = new Map();

function setFileActionBusy(busy) {
  fileActionInProgress = busy;
  for (const control of scanControls) {
    if (busy) {
      disabledBeforeFileAction.set(control, control.disabled);
      control.disabled = true;
    } else {
      control.disabled = disabledBeforeFileAction.get(control);
    }
  }
  if (!busy) {
    disabledBeforeFileAction.clear();
    exportCsvButton.disabled = !currentScanId || !currentResult;
  }
  if (typeof updatePasteAvailability === 'function') updatePasteAvailability();
}

function setScanControls(busy) {
  for (const control of scanControls) {
    if (busy) {
      disabledBeforeScan.set(control, control.disabled);
      control.disabled = true;
    } else {
      control.disabled = disabledBeforeScan.get(control);
    }
  }
  if (!busy) {
    disabledBeforeScan.clear();
    scanDriveButton.disabled = typeof hasChosenDrives === 'function' ? !hasChosenDrives() : !driveSelect.value;
    exportCsvButton.disabled = !currentScanId;
  }
  stopScanButton.hidden = !busy;
  stopScanButton.disabled = false;
  stopScanButton.textContent = 'Stop scan';
  if (typeof updatePasteAvailability === 'function') updatePasteAvailability();
}

if (window.electronAPI?.onScanProgress) {
  window.electronAPI.onScanProgress((progress) => {
    if (!scanInProgress || cancellationRequested || progress.requestId !== scanRequestId) return;
    updateScanMode(progress);
    showMessage(
      `Scanning... ${progress.scannedEntries.toLocaleString()} items | ${formatRate(progress.entriesPerSecond)} | ${formatDuration(progress.elapsedMs)} elapsed | ${progress.filteredCount.toLocaleString()} filtered | ${progress.skippedCount.toLocaleString()} skipped`,
      true
    );
  });
}

async function runScan(request) {
  if (scanInProgress || fileActionInProgress || folderDialogOpen) return;
  const requestId = ++scanRequestId;
  scanInProgress = true;
  cancellationRequested = false;
  setScanControls(true);
  document.dispatchEvent(new Event('diskoryx:scan-start'));
  sortRequestId++;
  virtualTree?.clear();
  fileContextMenu.hidden = true;
  updateScanMode(null);
  showMessage('Preparing scan...', true);
  try {
    const result = await request(requestId);
    if (result.cancelled) {
      if (currentResult) renderResult(currentResult);
      else {
        updateScanMode(null);
        showMessage('Scan stopped. Select a folder or drive to scan.');
      }
      showActionToast('Scan stopped. Incomplete results discarded.');
    } else {
      renderResult(result);
    }
  } catch (error) {
    updateScanMode(null);
    showMessage(`Scan failed: ${error.message}`);
  } finally {
    scanInProgress = false;
    cancellationRequested = false;
    setScanControls(false);
  }
}

stopScanButton.addEventListener('click', async () => {
  if (!scanInProgress || cancellationRequested) return;
  const requestId = scanRequestId;
  cancellationRequested = true;
  stopScanButton.disabled = true;
  stopScanButton.textContent = 'Stopping...';
  showMessage('Stopping scan...', true);
  try {
    const result = await window.electronAPI.cancelScan(requestId);
    if (!result.success) throw new Error(result.error || 'Unable to stop scan.');
  } catch (error) {
    if (scanInProgress && requestId === scanRequestId) {
      cancellationRequested = false;
      stopScanButton.disabled = false;
      stopScanButton.textContent = 'Stop scan';
      showActionToast(`Unable to stop scan: ${error.message}`);
    }
  }
});

exportCsvButton.addEventListener('click', async () => {
  if (!currentScanId || scanInProgress) return;
  exportCsvButton.disabled = true;
  try {
    const result = await window.electronAPI.exportCsv(currentScanId);
    if (result.cancelled) return;
    if (!result.success) {
      showAppMessage(result.error || 'Unable to export this scan.');
      return;
    }
    showAppMessage(`Exported ${result.rowCount.toLocaleString()} tree items to:\n${result.filePath}`, 'Export complete');
  } catch (error) {
    showAppMessage(`Unable to export this scan: ${error.message}`);
  } finally {
    exportCsvButton.disabled = scanInProgress || !currentScanId;
  }
});

async function populateDriveSelect() {
  try {
    const result = await window.electronAPI.listDrives();
    driveSelect.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = result.drives.length ? 'Select a drive...' : 'No drives found';
    placeholder.selected = true;
    driveSelect.append(placeholder);
    for (const drive of result.drives) {
      const option = document.createElement('option');
      option.value = drive.path;
      option.textContent = drive.label;
      driveSelect.append(option);
    }
    scanDriveButton.disabled = true;
  } catch (error) {
    driveSelect.replaceChildren();
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Drives unavailable';
    driveSelect.append(option);
    statsBadge.textContent = `Unable to list drives: ${error.message}`;
  }
}

driveSelect.addEventListener('change', () => {
  scanDriveButton.disabled = scanInProgress || !driveSelect.value;
});

function selectDriveContaining(folderPath) {
  const driveRoot = /^([a-z]:\\)/i.exec(folderPath)?.[1];
  if (driveRoot && [...driveSelect.options].some((option) => option.value.toLowerCase() === driveRoot.toLowerCase())) {
    driveSelect.value = driveRoot;
    scanDriveButton.disabled = false;
  }
}

document.getElementById('folder-picker-btn').addEventListener('click', async () => {
  if (scanInProgress || fileActionInProgress || folderDialogOpen) return;
  folderDialogOpen = true;
  document.getElementById('folder-picker-btn').disabled = true;
  let folderPath;
  try {
    folderPath = await window.electronAPI.showFolderDialog();
  } catch (error) {
    showActionToast(`Unable to choose folder: ${error.message}`);
  } finally {
    folderDialogOpen = false;
    document.getElementById('folder-picker-btn').disabled = scanInProgress;
  }
  if (folderPath) {
    selectDriveContaining(folderPath);
    await runScan(requestId => window.electronAPI.scanFolder(folderPath, currentScanFilters, requestId));
  }
});

document.getElementById('scan-drive-btn').addEventListener('click', async () => {
  if (typeof scanChosenDrives === 'function') {
    await scanChosenDrives();
    return;
  }
  const drivePath = driveSelect.value;
  if (drivePath) await runScan(requestId => window.electronAPI.scanFolder(drivePath, currentScanFilters, requestId));
});

document.getElementById('scan-filters-btn').addEventListener('click', () => {
  if (scanInProgress) return;
  populateScanFiltersForm();
  scanFiltersDialog.showModal();
});

document.getElementById('cancel-scan-filters').addEventListener('click', () => scanFiltersDialog.close());

document.getElementById('reset-scan-filters').addEventListener('click', () => {
  includeExtensionsInput.value = '';
  excludeExtensionsInput.value = '';
  excludeFoldersInput.value = '';
  scanFiltersError.hidden = true;
});

scanFiltersForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (scanInProgress) return;
  const nextFilters = {
    includeExtensions: parseFilterList(includeExtensionsInput.value),
    excludeExtensions: parseFilterList(excludeExtensionsInput.value),
    excludeFolderNames: parseFilterList(excludeFoldersInput.value)
  };
  try {
    window.localStorage.setItem('diskoryx.scanFilters', JSON.stringify(nextFilters));
  } catch (error) {
    scanFiltersError.textContent = `Unable to save scan filters: ${error.message}`;
    scanFiltersError.hidden = false;
    return;
  }

  const normalizeFolderNames = (names) => names.map((name) => name.toLowerCase()).sort().join('|');
  const folderRulesChanged = normalizeFolderNames(currentScanFilters.excludeFolderNames)
    !== normalizeFolderNames(nextFilters.excludeFolderNames);
  currentScanFilters = nextFilters;
  scanFiltersDialog.close();
  const folderPath = currentFolderPath || driveSelect.value;
  if (!folderPath) {
    showMessage('Filters saved. Select a folder or drive to scan.');
  } else if (currentScanId && !folderRulesChanged) {
    const requestId = ++sortRequestId;
    showMessage('Applying filters to the cached scan...', true);
    try {
      const result = await window.electronAPI.sortTree(
        folderPath, currentSortType, currentScanId, currentExtensions, currentScanFilters
      );
      if (requestId === sortRequestId) renderResult(result);
    } catch (error) {
      if (requestId === sortRequestId) showMessage(`Unable to apply filters: ${error.message}`);
    }
  } else {
    await runScan(requestId => window.electronAPI.scanFolder(folderPath, currentScanFilters, requestId));
  }
});

document.getElementById('refresh-btn').addEventListener('click', async () => {
  if (scanInProgress) return;
  if (currentFolderPath) await runScan(requestId => window.electronAPI.refreshTree(currentFolderPath, currentScanFilters, requestId));
  else showMessage('Select a folder or drive to scan.');
});

async function changeSort(sortType) {
  if (!['name', 'size', 'date'].includes(sortType)) return;
  if (!currentFolderPath || scanInProgress || fileActionInProgress) return;
  const requestId = ++sortRequestId;
  showMessage('Sorting folder entries...', true);
  try {
    const result = await window.electronAPI.sortTree(
      currentFolderPath, sortType, currentScanId, currentExtensions, currentScanFilters
    );
    if (requestId === sortRequestId) renderResult(result);
  } catch (error) {
    if (requestId === sortRequestId) showMessage(`Sort failed: ${error.message}`);
  }
}

document.getElementById('sort-select').addEventListener('change', event => changeSort(event.target.value));
document.addEventListener('diskoryx:sort', event => changeSort(event.detail));

document.getElementById('search-btn').addEventListener('click', async () => {
  if (scanInProgress || fileActionInProgress) return;
  currentSearchQuery = document.getElementById('search-input').value.trim();
  if (!currentScanId) return;
  if (!currentSearchQuery) {
    renderResult(currentResult);
    return;
  }
  virtualTree.clear();
  treeTitle.textContent = 'Searching...';
  showMessage('Searching scanned files...', true);
  await loadSearchPage(0, false);
});

document.getElementById('search-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') document.getElementById('search-btn').click();
});

const expandAllButton = document.getElementById('expand-all-btn');
const collapseAllButton = document.getElementById('collapse-all-btn');

async function setVisibleFoldersExpanded(expanded) {
  if (scanInProgress) return;
  const actionButton = expanded ? expandAllButton : collapseAllButton;

  expandAllButton.disabled = true;
  collapseAllButton.disabled = true;
  actionButton.title = `${expanded ? 'Expanding' : 'Collapsing'} loaded folders`;

  try {
    await virtualTree.setLoadedFoldersExpanded(expanded, (completed, total) => {
      actionButton.title = `${expanded ? 'Expanding' : 'Collapsing'} ${completed} of ${total} folders`;
    });
  } finally {
    expandAllButton.disabled = false;
    collapseAllButton.disabled = false;
    expandAllButton.title = 'Expand loaded folders';
    collapseAllButton.title = 'Collapse loaded folders';
  }
}

expandAllButton.addEventListener('click', () => setVisibleFoldersExpanded(true));
collapseAllButton.addEventListener('click', () => setVisibleFoldersExpanded(false));
document.getElementById('collapse-tree-folders-btn').addEventListener('click', () => setVisibleFoldersExpanded(false));

document.getElementById('close-details').addEventListener('click', () => {
  emptyDetails.hidden = false;
  detailsPanel.querySelector('.file-details-content')?.remove();
});

if (typeof window.VirtualTree !== 'function') {
  showMessage('Tree component failed to load. Check virtual-tree.js.');
} else if (typeof window.DiskTreemap !== 'function' || !window.d3?.treemap) {
  showMessage('Treemap component failed to load. Check the local D3 and treemap scripts.');
} else if (!window.electronAPI?.scanFolder) {
  showMessage('Electron preload API is unavailable. Check preload.js.');
} else {
  virtualTree = new window.VirtualTree(
    treeContainer,
    window.electronAPI,
    showFileDetails,
    showFileContextMenu,
    syncTreemapToTreeFolder,
    updateMatchExpansionProgress
  );
  diskTreemap = new window.DiskTreemap(
    treemapCanvas,
    treemapBreadcrumb,
    window.electronAPI,
    file => {
      showFileDetails(file);
      void syncTreeToMapItem(file);
    },
    treemapSmallItemsButton,
    showFileContextMenu,
    folder => { void syncTreeToMapItem(folder); }
  );
  populateDriveSelect();
  populateScanFiltersForm();
  statsBadge.textContent = 'Select a folder or drive';
  filesLoaded.textContent = 'Files loaded: —';
  lastUpdated.textContent = 'Last updated: —';
  showMessage('Select a folder or drive to scan.');
}
