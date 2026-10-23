const { app, BrowserWindow, Menu, ipcMain, dialog, shell, clipboard } = require('electron');
const fsStream = require('node:fs');
const fs = require('node:fs/promises');
const path = require('path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { formatFileSize, normalizeScanFilters, scanFolder } = require('./scanner');
const { iterateScanTree, serializeCsvHeader, serializeCsvRow } = require('./csv-export');
const { getMftScannerPath, isDriveRoot, scanMftVolume } = require('./mft-scanner');
const { requireStandardUser, closeScanBroker } = require('./mft-broker');
const { getAnalysisPage } = require('./analysis-views');
const { copyWithHandles } = require('./windows-copy');
const { insertCopiedItem } = require('./scan-insertion');
const { inspectCopyTree, verifyCopyTree } = require('./copy-receipt');
const { ActionHistory } = require('./action-history');
const { sortItemList } = require('./tree-sort');
const { readTextPage } = require('./text-preview');
const { inspectFileAction, validateNewName } = require('./file-action-guard');
const { prepareScanMutation } = require('./scan-mutations');
const { createRecycleConfirmation } = require('./recycle-confirmation');
const {
  renameWithHandles, createFolderWithHandles, recycleWithPinnedAncestors, restoreWithHandles
} = require('./windows-rename');
const { findRecycledEntry, readMetadata } = require('./recycle-restore');
const { createLiveMonitor } = require('./live-updates');
const { reconcilePaths } = require('./live-reconcile');
const { migrateUserData } = require('./user-data-migration');
const { ARCHIVE_EXTENSION, readScanArchive, saveScanArchive } = require('./scan-archive');
const { parseSearchQuery } = require('./search-query');
const { checkSourceIdentity, compareScans, filtersMatch, pageChanges } = require('./scan-compare');
const { findDuplicates, isUserFilePath } = require('./duplicates');
const requestRecycleConfirmation = createRecycleConfirmation(ipcMain);

const APP_ICON = path.join(__dirname, '..', 'assets', 'diskoryx.ico');
const PAGE_SIZE = 200;
const MAX_SORT_CACHE_PER_FOLDER = 3;
let cachedScan = null;
let cachedScanId = 0;
const savedScans = new Map();
const scanViewStates = new WeakMap();
// Saved scan archives are read-only views of a historical result. They are never
// stored as a live location snapshot, so they cannot answer a later Scan request
// and cannot collide with a fresh scan of the same root.
const ARCHIVE_READ_ONLY = 'This is a saved scan file: file actions, file previews and Explorer access are disabled. Rescan the original location to work with live files.';
const ARCHIVE_PREVIEW = 'File previews read live files, so they are unavailable for a saved scan file. Rescan the original location to preview its contents.';
function archiveReadOnly() {
  return cachedScan?.readOnly ? { error: ARCHIVE_READ_ONLY, readOnly: true } : null;
}
const scanKey = folder => path.resolve(folder).toLowerCase();
function retainCurrentScan() {
  if (cachedScan && !cachedScan.readOnly) savedScans.set(scanKey(cachedScan.folderPath), cachedScan);
}
let folderSortCache = new WeakMap();
let analysisCache = {};
let activeScanJob = null;
let activeExports = 0;
let copySelection = null;
let activeCopy = null;
// The native Copy helper stages items as .diskoryx-copy-<guid> inside the destination before publishing them.
const COPY_STAGING_PREFIX = '.diskoryx-copy-';
function isCopyStaging(target, root) {
  const relative = path.relative(root, path.resolve(target));
  return relative.split(path.sep).some(part => part.toLowerCase().startsWith(COPY_STAGING_PREFIX));
}
let liveOwner = null;
let liveIndex = {};
let liveStatus = { state: 'inactive', message: 'Scan a location to start live notifications.' };
function sendLive(update = {}) {
  if (liveOwner && !liveOwner.isDestroyed()) liveOwner.send('live-update', { status: liveStatus, ...update });
}
const liveMonitor = createLiveMonitor({
  isBusy: () => Boolean(activeScanJob || fileActionInProgress || activeExports),
  onStale(message) {
    console.warn('Live snapshot is stale:', message);
    liveStatus = { state: 'stale', message: `${message} Browsing the last saved snapshot; external changes may be missing. Use Rescan to update it. No automatic scan was started.` };
    folderSortCache = new WeakMap(); analysisCache = {};
    liveIndex = {};
    sendLive(cachedScan ? { scanId: cachedScanId, folderPath: cachedScan.folderPath, snapshotChanged: true } : {});
  },
  async onBatch(paths, isCurrent) {
    if (!cachedScan) return;
    const scan = cachedScan;
    fileActionInProgress = true;
    try {
      // Actions and reconciliation are serialized. Reconcile their final events
      // too: unchanged members are idempotent, but later external edits are not.
      const changed = await reconcilePaths(scan, paths.filter(target => !isCopyStaging(target, scan.folderPath)), liveIndex, cachedScanId, isCurrent);
      if (changed && isCurrent() && cachedScan === scan) {
        cachedScanId++; folderSortCache = new WeakMap(); analysisCache = {};
        liveIndex.revision = cachedScanId;
        sendLive({ scanId: cachedScanId, folderPath: scan.folderPath, snapshotChanged: true });
      }
    } finally { fileActionInProgress = false; }
  }
});

const ownsInstance = typeof app.requestSingleInstanceLock !== 'function' || app.requestSingleInstanceLock();
if (process.platform === 'win32') app.setAppUserModelId('com.diskoryx.desktop');
if (!ownsInstance) app.quit();
const appDataPath = app.getPath('appData');
const userDataPath = path.join(appDataPath, 'Diskoryx V1');
let userDataMigrationError = null;
if (ownsInstance) {
  try {
    migrateUserData(path.join(appDataPath, 'FileVisor V1'), userDataPath);
  } catch (error) {
    userDataMigrationError = error;
  }
}
app.setPath('userData', userDataPath);
const actionHistory = new ActionHistory(path.join(app.getPath('userData'), 'action-history.json'));
app.on('second-instance', () => {
  const window = BrowserWindow.getAllWindows().find(win => !win.isDestroyed());
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.focus();
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1100,
    minHeight: 600,
    icon: APP_ICON,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'preload', 'preload.js')
    },
    titleBarStyle: 'default',
    backgroundColor: '#101116'
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function showStartupError(message) {
  const win = new BrowserWindow({
    width: 680, height: 420, minWidth: 480, minHeight: 320,
    resizable: true, backgroundColor: '#101116', icon: APP_ICON,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'startup-error.html'), {
    query: { message }
  });
}

app.whenReady().then(() => {
  if (!ownsInstance) return;
  if (userDataMigrationError) {
    showStartupError(userDataMigrationError.message);
    return;
  }
  Menu.setApplicationMenu(null);
  try {
    requireStandardUser();
  } catch (error) {
    showStartupError(error.message);
    return;
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  activeScanJob?.controller.abort();
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
  liveMonitor.stop();
  activeCopy?.controller.abort();
  activeScanJob?.controller.abort();
  void closeScanBroker().catch(error => console.error('Scanner shutdown failed:', error));
});

function normalizeExtensions(extensionList) {
  return [...new Set((Array.isArray(extensionList) ? extensionList : [extensionList])
    .flatMap((value) => String(value || '').split(','))
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean)
    .map((extension) => extension.startsWith('.') ? extension : `.${extension}`))].sort();
}

function scanFolderRules(scanFilters = {}) {
  return { excludeFolderNames: normalizeScanFilters(scanFilters).excludeFolderNames };
}

function extensionIsVisible(extension, viewExtensions, scanFilters) {
  const normalizedExtension = `.${extension}`;
  if (viewExtensions.length && !viewExtensions.includes(normalizedExtension)) return false;
  if (scanFilters.includeExtensions.length && !scanFilters.includeExtensions.includes(normalizedExtension)) return false;
  return !scanFilters.excludeExtensions.includes(normalizedExtension);
}

function getFilteredFolderStats(folder, viewExtensions, scanFilters) {
  const stats = { fileCount: 0, totalSizeBytes: 0, oldFilesCount: 0 };
  for (const [extension, value] of Object.entries(folder.extensionStats)) {
    if (!extensionIsVisible(extension, viewExtensions, scanFilters)) continue;
    stats.fileCount += value.fileCount;
    stats.totalSizeBytes += value.totalSizeBytes;
    stats.oldFilesCount += value.oldFilesCount;
  }
  return stats;
}

function folderHasVisibleFiles(folder, viewExtensions, scanFilters) {
  return getFilteredFolderStats(folder, viewExtensions, scanFilters).fileCount > 0;
}

function getFolderChildren(folder, viewExtensions, scanFilters) {
  const hasExtensionFilter = viewExtensions.length
    || scanFilters.includeExtensions.length
    || scanFilters.excludeExtensions.length;
  const excludedFolders = new Set(scanFilters.excludeFolderNames);
  return folder.children.filter((item) => {
    if (item.type === 'folder') {
      if (excludedFolders.has(item.name.toLowerCase())) return false;
      return !hasExtensionFilter || folderHasVisibleFiles(item, viewExtensions, scanFilters);
    }
    return extensionIsVisible(item.extension, viewExtensions, scanFilters);
  });
}

function getFolderSortCache(folder, sortType, viewExtensions, scanFilters) {
  let cache = folderSortCache.get(folder);
  if (!cache) {
    cache = new Map();
    folderSortCache.set(folder, cache);
  }

  const key = `${sortType}|${viewExtensions.join(',')}|${JSON.stringify(scanFilters)}`;
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return { cache, key, items: cached };
  }
  return { cache, key, items: null };
}

function projectItem(item, viewExtensions, scanFilters, parentRawSize) {
  if (item.type === 'file') {
    const aggregateSize = item.aggregateSize ?? item.rawSize;
    return {
      name: item.name,
      path: item.path,
      type: item.type,
      parentFolderId: item.parentFolderId,
      rawSize: aggregateSize,
      size: item.size,
      percentOfParent: parentRawSize > 0 ? aggregateSize / parentRawSize * 100 : 0,
      itemCount: 1,
      date: item.date,
      humanDate: item.humanDate,
      isOld: item.isOld,
      extension: item.extension,
      hardLinkCount: item.hardLinkCount || 1,
      isHardLinkAlias: item.sizeOwner === false,
      typeLabel: item.extension === 'unknown' ? 'File' : `.${item.extension}`
    };
  }

  const itemStats = getFilteredFolderStats(item, viewExtensions, scanFilters);
  const rawSize = viewExtensions.length || scanFilters.includeExtensions.length || scanFilters.excludeExtensions.length
    ? itemStats.totalSizeBytes
    : item.rawSize;
  return {
    name: item.name,
    path: item.path,
    type: item.type,
    folderId: item.folderId,
    parentFolderId: item.parentFolderId,
    percentOfParent: parentRawSize > 0 ? rawSize / parentRawSize * 100 : 0,
    itemCount: itemStats.fileCount + item.folderCount,
    fileCount: itemStats.fileCount,
    folderCount: item.folderCount,
    typeLabel: 'Folder',
    rawSize,
    size: formatFileSize(rawSize),
    date: null,
    humanDate: '—'
  };
}

async function getFolderPage(scan, folderId, offset, limit, sortType, viewExtensions, scanFilters) {
  if (!Number.isInteger(folderId) || folderId < 0 || !scan.folderNodes[folderId]) {
    return { error: 'Folder is no longer available in this scan.' };
  }

  const folder = scan.folderNodes[folderId];
  const cached = getFolderSortCache(folder, sortType, viewExtensions, scanFilters);
  let items = cached.items;
  if (!items) {
    items = await sortItemList(getFolderChildren(folder, viewExtensions, scanFilters), sortType);
    cached.cache.set(cached.key, items);
    if (cached.cache.size > MAX_SORT_CACHE_PER_FOLDER) {
      cached.cache.delete(cached.cache.keys().next().value);
    }
  }

  const safeOffset = Math.max(0, Number.isFinite(offset) ? Math.floor(offset) : 0);
  const safeLimit = Math.min(PAGE_SIZE, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : PAGE_SIZE));
  const parentRawSize = viewExtensions.length || scanFilters.includeExtensions.length || scanFilters.excludeExtensions.length
    ? getFilteredFolderStats(folder, viewExtensions, scanFilters).totalSizeBytes
    : folder.rawSize;
  return {
    success: true,
    folderId,
    offset: safeOffset,
    totalCount: items.length,
    items: items.slice(safeOffset, safeOffset + safeLimit)
      .map((item) => projectItem(item, viewExtensions, scanFilters, parentRawSize))
  };
}

function getStats(scan, viewExtensions, scanFilters) {
  const stats = { fileCount: 0, totalSizeBytes: 0, oldFilesCount: 0, filesByType: {} };
  for (const [extension, extensionStats] of Object.entries(scan.folderNodes[0].extensionStats)) {
    if (!extensionIsVisible(extension, viewExtensions, scanFilters)) continue;
    stats.fileCount += extensionStats.fileCount;
    stats.totalSizeBytes += extensionStats.totalSizeBytes;
    stats.oldFilesCount += extensionStats.oldFilesCount;
    stats.filesByType[extension] = extensionStats.fileCount;
  }
  return stats;
}

async function createView(scan, scanId, sortType = 'name', extensionList = [], scanFilterOptions = scan.scanFilters) {
  if (!['name', 'size', 'date'].includes(sortType)) return { error: 'Unsupported sort order.' };
  const viewExtensions = normalizeExtensions(extensionList);
  const activeScanFilters = normalizeScanFilters(scanFilterOptions);
  const stats = getStats(scan, viewExtensions, activeScanFilters);
  const result = {
    success: true,
    folderPath: scan.folderPath,
    scanId,
    sortType,
    extensions: viewExtensions,
    scanFilters: activeScanFilters,
    fileCount: stats.fileCount,
    folderCount: scan.folderCount,
    reparsePointCount: scan.reparsePointCount || 0,
    oldFilesCount: stats.oldFilesCount,
    skippedCount: scan.skippedCount,
    filteredCount: scan.fileCount - stats.fileCount,
    excludedFolderCount: scan.excludedFolderCount,
    totalSizeBytes: stats.totalSizeBytes,
    totalSizeFormatted: formatFileSize(stats.totalSizeBytes),
    filesByType: stats.filesByType,
    scanDurationMs: scan.scanDurationMs,
    entriesPerSecond: scan.entriesPerSecond,
    scanMode: scan.scanMode,
    scanModeReason: scan.scanModeReason,
    scanStartedAt: scan.scanStartedAt ?? null,
    readOnly: scan.readOnly === true,
    archive: scan.archive || null,
    capacity: scan.capacity || null
  };
  result.liveStatus = liveStatus;

  const rootPage = await getFolderPage(scan, 0, 0, PAGE_SIZE, sortType, viewExtensions, activeScanFilters);
  if (!rootPage.success) return rootPage;
  result.structure = rootPage.items;
  result.structureTotalCount = rootPage.totalCount;
  scanViewStates.set(scan, { sortType, scanFilters: activeScanFilters });
  return result;
}

async function scanLocation(folderPath, event, folderFilters, job) {
  const signal = job.controller.signal;
  const initialVolumeId = await volumeIdentity(folderPath);
  let scanMode = 'standard';
  let scanModeReason = 'Folder scans use filesystem traversal.';
  const reportProgress = (progress) => {
    if (activeScanJob === job && !signal.aborted && !event.sender.isDestroyed()) {
      if (job.operation === 'duplicates') {
        event.sender.send('duplicate-progress', {
          stage: 'inventory',
          filesScanned: progress.scannedEntries || 0,
          scopePath: folderPath,
          scanMode,
          scanModeReason,
          requestId: job.requestId
        });
      } else {
        event.sender.send('scan-progress', { ...progress, requestId: job.requestId, scanMode, scanModeReason });
      }
    }
  };
  let result = null;

  if (isDriveRoot(folderPath)) {
    const mftScannerPath = getMftScannerPath(app.isPackaged);
    if (mftScannerPath) {
      scanMode = 'mft';
      scanModeReason = '';
      try {
        result = await scanMftVolume(folderPath, reportProgress, folderFilters, app.isPackaged, signal);
        if (!result) scanModeReason = 'The MFT scanner was unavailable when starting this scan.';
      } catch (error) {
        signal.throwIfAborted();
        if (error.noFallback) throw error;
        scanModeReason = 'MFT unavailable; filesystem traversal used.';
        console.warn(`MFT scan failed; falling back to filesystem traversal: ${error.message}`);
      }
    } else {
      scanModeReason = 'The MFT scanner executable is missing.';
      console.warn('MFT scanner executable is missing; falling back to filesystem traversal.');
    }
  }

  signal.throwIfAborted();
  if (!result) {
    scanMode = 'standard';
    result = await scanFolder(folderPath, reportProgress, folderFilters, signal);
  }
  signal.throwIfAborted();
  const finalVolumeId = result.success ? await volumeIdentity(folderPath) : null;
  signal.throwIfAborted();
  if (initialVolumeId !== null && finalVolumeId !== null && initialVolumeId !== finalVolumeId) {
    throw new Error('The source volume changed during the scan. Scan the location again.');
  }
  return { ...result, scanMode, scanModeReason,
    volumeId: initialVolumeId === finalVolumeId ? initialVolumeId : null };
}

async function getScanView(folderPath, event, activeScanFilters, sortType = 'name', extensions = [],
  expectedScanId = null, force = false, requestId = null, allowArchiveView = false) {
  if (activeScanJob) return { error: 'A scan is already running. Stop it or wait for it to finish.' };
  if (fileActionInProgress) return { error: 'Wait for the current file action to finish.' };
  const normalizedFilters = scanFolderRules(activeScanFilters);
  // Only a view change may reuse a saved scan archive. Scan/Rescan must always
  // perform a real scan so a historical result is never presented as current.
  if (!force && cachedScan && (allowArchiveView || !cachedScan.readOnly)
    && path.resolve(folderPath) === cachedScan.folderPath
    && JSON.stringify(scanFolderRules(cachedScan.scanFilters)) === JSON.stringify(normalizedFilters)) {
    if (expectedScanId !== null && expectedScanId !== cachedScanId) return { error: 'This scan has expired. Please scan the folder again.' };
    const scanId = cachedScanId;
    const view = await createView(cachedScan, scanId, sortType, extensions, activeScanFilters);
    return scanId === cachedScanId ? view : { error: 'This scan changed. Try again.' };
  }

  const job = { controller: new AbortController(), sender: event.sender, requestId };
  const abort = () => job.controller.abort();
  activeScanJob = job;
  event.sender.once('destroyed', abort);
  try {
    const scan = await scanLocation(folderPath, event, normalizedFilters, job);
    if (!scan.success) return scan;
    if (!scan.readOnly) scan.capacity = await captureVolumeCapacity(scan.folderPath);
    const nextScanId = cachedScanId + 1;
    const view = await createView(scan, nextScanId, sortType, extensions, activeScanFilters);
    job.controller.signal.throwIfAborted();
    if (!view.success) return view;
    retainCurrentScan();
    savedScans.delete(scanKey(scan.folderPath));
    cachedScan = scan;
    cachedScanId = nextScanId;
    folderSortCache = new WeakMap();
    analysisCache = {};
    liveOwner = event.sender;
    liveIndex = {};
    if (liveMonitor.start(scan.folderPath)) {
      liveStatus = { state: 'watching', message: 'Watching Windows change notifications; updates are bounded and best effort.' };
      sendLive();
    } else {
      liveStatus = { state: 'stale', message: 'Live monitoring could not start. See the paused notification for details.' };
    }
    view.liveStatus = liveStatus;
    if (expectedScanId !== null && expectedScanId !== cachedScanId) return { error: 'This scan has expired. Please scan the folder again.' };
    return view;
  } catch (error) {
    if (job.controller.signal.aborted) return { cancelled: true };
    console.error('Scan failed:', error);
    return { error: `Scan failed: ${error.message}` };
  } finally {
    event.sender.removeListener('destroyed', abort);
    if (activeScanJob === job) activeScanJob = null;
  }
}

// Snapshot of the volume's capacity taken when a live scan completes. The
// timestamp marks it as historical, so it is never shown as current disk state.
async function captureVolumeCapacity(folderPath) {
  try {
    const volumePath = path.parse(folderPath).root;
    const stats = await fs.statfs(volumePath, { bigint: true });
    const totalBytes = stats.blocks * stats.bsize;
    const availableBytes = stats.bavail * stats.bsize;
    if (totalBytes > BigInt(Number.MAX_SAFE_INTEGER) || availableBytes > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return {
      totalBytes: Number(totalBytes),
      availableBytes: Number(availableBytes),
      capturedAt: Date.now(),
      volumePath
    };
  } catch (error) {
    console.warn('Unable to read volume capacity:', error.message);
    return null;
  }
}

let compareState = null;
async function volumeIdentity(folderPath) {
  try {
    const stats = await fs.stat(folderPath);
    return Number.isSafeInteger(stats.dev) ? stats.dev : null;
  } catch {
    return null;
  }
}

ipcMain.handle('compare-with-current', async (event, requestId) => {
  if (activeScanJob || fileActionInProgress || activeExports) {
    return { error: 'Wait for the current scan, export or file action.' };
  }
  if (!cachedScan?.readOnly) return { error: 'Open a saved scan first, then compare it with the current state.' };
  const before = cachedScan;
  const root = before.folderPath;
  const job = { controller: new AbortController(), sender: event.sender, requestId };
  activeScanJob = job;
  const abort = () => job.controller.abort();
  event.sender.once('destroyed', abort);
  try {
    const after = await scanLocation(root, event, scanFolderRules(before.scanFilters), job);
    if (!after.success) return { error: after.error || 'The current state could not be scanned.' };
    if (!filtersMatch(before.scanFilters, after.scanFilters)) {
      return { error: 'The saved scan used different filters. Compare is refused so the results stay accurate.' };
    }
    const identity = checkSourceIdentity(before.archive?.volumeId ?? null, after.volumeId);
    if (!identity.ok) return { error: identity.error };
    const diff = await compareScans(before, after, { signal: job.controller.signal });
    job.controller.signal.throwIfAborted();
    if (cachedScan !== before) return { error: 'The saved scan changed. Compare again.' };
    compareState = { diff, beforeId: cachedScanId, verified: identity.verified, root };
    return { success: true, verified: identity.verified, summary: { ...diff, lists: undefined } };
  } catch (error) {
    if (job.controller.signal.aborted) return { cancelled: true };
    console.error('Compare failed:', error);
    return { error: `Compare failed: ${error.message}` };
  } finally {
    event.sender.removeListener('destroyed', abort);
    if (activeScanJob === job) activeScanJob = null;
  }
});

ipcMain.handle('compare-page', (_event, kind, options) => {
  if (!compareState || compareState.beforeId !== cachedScanId) return { error: 'Run Compare again.' };
  try {
    return { success: true, ...pageChanges(compareState.diff, kind, options) };
  } catch (error) {
    return { error: error.message };
  }
});

ipcMain.handle('cancel-scan', (event, requestId) => {
  if (!activeScanJob || activeScanJob.sender !== event.sender || activeScanJob.requestId !== requestId) {
    return { error: 'This scan is no longer running.' };
  }
  activeScanJob.controller.abort();
  return { success: true };
});

ipcMain.handle('scan-folder', async (event, folderPath, scanFilters, requestId) => {
  const activeScanFilters = normalizeScanFilters(scanFilters);
  return getScanView(folderPath, event, activeScanFilters, 'name', [], null, false, requestId);
});

ipcMain.handle('list-saved-scans', () => {
  const active = cachedScan;
  const activeKey = active ? scanKey(active.folderPath) : null;
  // While a saved scan file is active, a live snapshot of the same root would
  // resolve to the same switch key; list only the result being shown.
  const scans = [...savedScans.values(), ...(active ? [active] : [])].filter(scan =>
    !active?.readOnly || scan === active || scanKey(scan.folderPath) !== activeKey);
  return {
    success: true,
    scans: scans.map(scan => ({
      folderPath: scan.folderPath, fileCount: scan.fileCount,
      totalSizeFormatted: scan.totalSizeFormatted, active: scan === cachedScan,
      readOnly: scan.readOnly === true, savedAt: scan.archive?.savedAt || null
    }))
  };
});

ipcMain.handle('activate-saved-scan', async (event, folderPath) => {
  if (activeScanJob || fileActionInProgress || activeExports) {
    return { error: 'Wait for the current scan, export or file action.' };
  }
  if (typeof folderPath !== 'string') return { error: 'Choose an available saved scan.' };
  const key = scanKey(folderPath);
  const isActive = cachedScan && scanKey(cachedScan.folderPath) === key;
  const scan = isActive ? cachedScan : savedScans.get(key);
  if (!scan) return { error: 'This saved scan is no longer available. Scan the location first.' };
  fileActionInProgress = true;
  try {
    const state = scanViewStates.get(scan);
    const viewFor = id => createView(scan, id, state?.sortType, [], state?.scanFilters);
    if (isActive) return await viewFor(cachedScanId);
    const nextId = cachedScanId + 1;
    const view = await viewFor(nextId);
    if (!view.success) return view;
    if (event.sender.isDestroyed()) return { error: 'The requesting window was closed.' };
    liveMonitor.stop();
    retainCurrentScan();
    savedScans.delete(key);
    cachedScan = scan;
    cachedScanId = nextId;
    folderSortCache = new WeakMap();
    analysisCache = {};
    liveIndex = {};
    liveOwner = event.sender;
    liveStatus = {
      state: 'stale',
      message: 'This saved result was not monitored while another location was active. External changes may be missing. Use Rescan to refresh this location and restart live monitoring.'
    };
    view.liveStatus = liveStatus;
    return view;
  } catch (error) {
    console.warn('Saved scan could not be opened:', error.message);
    return { error: `Unable to open the saved scan: ${error.message}` };
  } finally {
    fileActionInProgress = false;
  }
});

ipcMain.handle('save-scan-archive', async (event, scanId) => {
  if (fileActionInProgress || activeScanJob || activeExports) {
    return { error: 'Wait for the current scan, export or file action.' };
  }
  if (!cachedScan || scanId !== cachedScanId) return { error: 'This scan has expired. Please scan the folder again.' };
  const scan = cachedScan;
  const rootName = path.basename(scan.folderPath)
    || scan.folderPath.replace(/[\\/:]/g, '').toLowerCase()
    || 'scan';
  const saveOptions = {
    title: 'Save this scan to a file',
    defaultPath: path.join(app.getPath('downloads'), `${rootName}-diskoryx-scan${ARCHIVE_EXTENSION}`),
    filters: [{ name: 'Diskoryx saved scan', extensions: [ARCHIVE_EXTENSION.slice(1)] }]
  };
  const parentWindow = BrowserWindow.fromWebContents(event.sender);
  const saveResult = parentWindow
    ? await dialog.showSaveDialog(parentWindow, saveOptions)
    : await dialog.showSaveDialog(saveOptions);
  if (saveResult.canceled || !saveResult.filePath) return { success: false, cancelled: true };
  if (cachedScan !== scan || scanId !== cachedScanId) return { error: 'This scan changed while saving. Try again.' };
  if (fileActionInProgress || activeScanJob) return { error: 'Wait for the current scan, export or file action.' };

  // Counts as an export so live reconciliation and file actions wait, but the
  // active scan stays usable for navigation.
  activeExports++;
  try {
    const saved = await saveScanArchive(scan, saveResult.filePath, {
      appVersion: typeof app.getVersion === 'function' ? app.getVersion() : '',
      volumeId: scan.readOnly ? scan.archive?.volumeId : scan.volumeId
    });
    return { success: true, ...saved };
  } catch (error) {
    console.warn('Saved scan could not be written:', error.message);
    return { error: `Unable to save the scan file: ${error.message}` };
  } finally {
    activeExports--;
  }
});

ipcMain.handle('open-scan-archive', async (event, requestId) => {
  if (activeScanJob || fileActionInProgress || activeExports) {
    return { error: 'Wait for the current scan, export or file action.' };
  }
  const openOptions = {
    title: 'Open a saved scan',
    defaultPath: app.getPath('downloads'),
    properties: ['openFile'],
    filters: [
      { name: 'Diskoryx saved scan', extensions: [ARCHIVE_EXTENSION.slice(1)] },
      { name: 'All files', extensions: ['*'] }
    ]
  };
  const parentWindow = BrowserWindow.fromWebContents(event.sender);
  const picked = parentWindow
    ? await dialog.showOpenDialog(parentWindow, openOptions)
    : await dialog.showOpenDialog(openOptions);
  if (picked.canceled || !picked.filePaths?.length) return { success: false, cancelled: true };

  const job = { controller: new AbortController(), sender: event.sender, requestId };
  const abort = () => job.controller.abort();
  activeScanJob = job;
  event.sender.once('destroyed', abort);
  try {
    // The archive is untrusted input: reading it never touches the filesystem
    // beyond this one file and never starts a scan.
    const archive = await readScanArchive(picked.filePaths[0], {
      signal: job.controller.signal,
      onProgress: progress => {
        if (activeScanJob === job && !job.controller.signal.aborted && !event.sender.isDestroyed()) {
          event.sender.send('scan-progress', {
            requestId: job.requestId, phase: 'archive',
            scannedEntries: progress.processed, fileCount: progress.files, folderCount: progress.folders,
            skippedCount: 0, filteredCount: 0, excludedFolderCount: 0,
            elapsedMs: progress.elapsedMs, entriesPerSecond: 0
          });
        }
      }
    });
    job.controller.signal.throwIfAborted();
    const nextScanId = cachedScanId + 1;
    const view = await createView(archive, nextScanId, 'name', [], archive.scanFilters);
    if (!view.success) return view;
    job.controller.signal.throwIfAborted();
    if (event.sender.isDestroyed()) return { error: 'The requesting window was closed.' };

    liveMonitor.stop();
    retainCurrentScan();
    cachedScan = archive;
    cachedScanId = nextScanId;
    folderSortCache = new WeakMap();
    analysisCache = {};
    liveIndex = {};
    liveOwner = event.sender;
    liveStatus = {
      state: 'archive',
      message: `Saved scan from ${new Date(archive.archive.savedAt).toLocaleString()}. This result is read-only and not monitored; Rescan the original location to work with live files.`
    };
    view.liveStatus = liveStatus;
    return view;
  } catch (error) {
    if (job.controller.signal.aborted) return { cancelled: true };
    console.warn('Saved scan could not be opened:', error.message);
    return { error: `Unable to open the saved scan: ${error.message}` };
  } finally {
    event.sender.removeListener('destroyed', abort);
    if (activeScanJob === job) activeScanJob = null;
  }
});

async function listLocalDrives() {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const drives = await Promise.all([...letters].map(async (letter) => {
    const drivePath = `${letter}:\\`;
    try {
      const driveStats = await fs.stat(drivePath);
      if (driveStats.isDirectory()) return { path: drivePath, label: `${letter}:` };
    } catch {}
    return null;
  }));

  return drives.filter(Boolean);
}

ipcMain.handle('list-drives', async () => ({ drives: await listLocalDrives() }));

ipcMain.handle('volume-capacity', async (_event, scanId) => {
  if (!cachedScan || cachedScanId !== scanId) return { error: 'This scan has expired. Please scan the location again.' };
  if (cachedScan.readOnly) {
    return { error: 'Free space is only reported for a live scan. Rescan the original location to read current capacity.' };
  }
  const scan = cachedScan;
  try {
    const volumePath = path.parse(scan.folderPath).root;
    const stats = await fs.statfs(volumePath, { bigint: true });
    if (cachedScan !== scan || cachedScanId !== scanId) return { error: 'This scan changed. Try again.' };
    const totalBytes = stats.blocks * stats.bsize;
    const availableBytes = stats.bavail * stats.bsize;
    if (totalBytes > BigInt(Number.MAX_SAFE_INTEGER) || availableBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('Volume capacity exceeds the supported display range.');
    }
    return {
      success: true, volumePath,
      totalBytes: Number(totalBytes), availableBytes: Number(availableBytes)
    };
  } catch (error) {
    console.warn('Unable to read volume capacity:', error.message);
    return { error: `Unable to read free space: ${error.message}` };
  }
});

ipcMain.handle('show-folder-dialog', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Select a folder to scan'
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('refresh-tree', async (event, folderPath, scanFilters, requestId) => {
  const activeScanFilters = normalizeScanFilters(scanFilters);
  return getScanView(folderPath, event, activeScanFilters, 'name', [], null, true, requestId);
});

ipcMain.handle('get-folder-page', async (_event, scanId, folderId, offset, limit, sortType, extensions, scanFilters) => {
  if (!cachedScan || scanId !== cachedScanId) return { error: 'This scan has expired. Please scan the folder again.' };
  const page = await getFolderPage(
    cachedScan,
    folderId,
    offset,
    limit,
    sortType,
    normalizeExtensions(extensions),
    normalizeScanFilters(scanFilters)
  );
  return scanId === cachedScanId ? page : { error: 'This scan changed. Try again.' };
});

ipcMain.handle('get-folder-ancestors', (_event, scanId, folderId, extensions, scanFilters) => {
  if (!cachedScan || scanId !== cachedScanId) return { error: 'This scan has expired. Please scan the folder again.' };
  if (!Number.isInteger(folderId) || folderId <= 0 || !cachedScan.folderNodes[folderId]) {
    return { error: 'Folder is no longer available in this scan.' };
  }

  const ancestors = [];
  const viewExtensions = normalizeExtensions(extensions);
  const activeScanFilters = normalizeScanFilters(scanFilters);
  let folder = cachedScan.folderNodes[folderId];
  while (folder && folder.folderId !== 0) {
    const parentFolder = cachedScan.folderNodes[folder.parentFolderId] || cachedScan.folderNodes[0];
    const parentSize = getFilteredFolderStats(parentFolder, viewExtensions, activeScanFilters).totalSizeBytes;
    ancestors.push(projectItem(folder, viewExtensions, activeScanFilters, parentSize));
    folder = cachedScan.folderNodes[folder.parentFolderId];
  }

  return { success: true, ancestors: ancestors.reverse() };
});

ipcMain.handle('sort-tree', async (event, folderPath, sortType, scanId, extensions, scanFilters) => {
  const activeScanFilters = normalizeScanFilters(scanFilters);
  return getScanView(folderPath, event, activeScanFilters, sortType, extensions, scanId, false, null, true);
});

ipcMain.handle('filter-by-extension', async (event, folderPath, extensions, scanId, sortType, scanFilters) => {
  const activeScanFilters = normalizeScanFilters(scanFilters);
  return getScanView(folderPath, event, activeScanFilters, sortType, extensions, scanId, false, null, true);
});

ipcMain.handle('search-files', async (_event, scanId, query, extensionList, offset = 0, limit = PAGE_SIZE, scanFilters) => {
  if (!cachedScan || scanId !== cachedScanId) return { error: 'This scan has expired. Please scan the folder again.' };
  const parsed = parseSearchQuery(query);
  if (parsed.error) return { error: parsed.error };
  const extensions = normalizeExtensions(extensionList);
  const activeScanFilters = normalizeScanFilters(scanFilters);
  if (parsed.empty) return { success: true, results: [], totalCount: 0, offset: 0 };

  const safeOffset = Math.max(0, Number.isFinite(offset) ? Math.floor(offset) : 0);
  const safeLimit = Math.min(PAGE_SIZE, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : PAGE_SIZE));
  const results = [];
  let totalCount = 0;
  const scan = cachedScan;
  for (let index = 0; index < scan.fileNodes.length; index++) {
    const file = scan.fileNodes[index];
    if (parsed.matches(file)
      && extensionIsVisible(file.extension, extensions, activeScanFilters)) {
      if (totalCount >= safeOffset && results.length < safeLimit) results.push(projectItem(file, []));
      totalCount++;
    }
    if (index > 0 && index % 16384 === 0) await new Promise((resolve) => setImmediate(resolve));
  }

  if (scanId !== cachedScanId) return { error: 'This scan changed. Try again.' };
  return { success: true, results, totalCount, offset: safeOffset, scanId };
});

ipcMain.handle('analysis-page', async (_event, scanId, options) => {
  if (!cachedScan || scanId !== cachedScanId) return { error: 'Scan again before opening analysis.' };
  const scan = cachedScan;
  try {
    const page = await getAnalysisPage(scan, options, analysisCache);
    if (scan !== cachedScan || scanId !== cachedScanId) return { error: 'The scan changed. Reopen this view.' };
    return { ...page, scanId };
  } catch (error) {
    console.warn('Analysis request failed:', error.message);
    return { error: error.message };
  }
});

ipcMain.handle('find-duplicates', async (event, drivePath, requestId, scope = 'user') => {
  if (activeScanJob || fileActionInProgress || activeExports) {
    return { error: 'Wait for the current scan, export or file action.' };
  }
  if (typeof drivePath !== 'string' || !Number.isSafeInteger(requestId)) {
    return { error: 'Select an available drive before finding duplicates.' };
  }
  if (scope !== 'user' && scope !== 'all') return { error: 'Choose a valid duplicate analysis scope.' };
  const job = { controller: new AbortController(), sender: event.sender, requestId, operation: 'duplicates' };
  const abort = () => job.controller.abort();
  activeScanJob = job;
  event.sender.once('destroyed', abort);
  try {
    const selectedDrive = (await listLocalDrives())
      .find(drive => drive.path.toLowerCase() === drivePath.toLowerCase());
    if (!selectedDrive) return { error: 'The selected drive is not available.' };
    const volumeRoot = selectedDrive.path;
    const existingInventory = [cachedScan, savedScans.get(scanKey(volumeRoot))].find(scan =>
      scan?.success && !scan.readOnly && scanKey(scan.folderPath) === scanKey(volumeRoot)
      && scanFolderRules(scan.scanFilters).excludeFolderNames.length === 0);
    const inventory = existingInventory
      || await scanLocation(volumeRoot, event, normalizeScanFilters({}), job);
    job.controller.signal.throwIfAborted();
    if (!inventory.success) {
      return { error: `Unable to enumerate ${volumeRoot} for duplicate analysis: ${inventory.error || 'scan failed'}` };
    }
    const candidateFiles = scope === 'user'
      ? inventory.fileNodes.filter(file => isUserFilePath(volumeRoot, file.path))
      : inventory.fileNodes;
    const excludedFileCount = inventory.fileNodes.length - candidateFiles.length;
    const result = await findDuplicates(volumeRoot, {
      signal: job.controller.signal,
      candidateFiles,
      onProgress(progress) {
        if (activeScanJob === job && !job.controller.signal.aborted && !event.sender.isDestroyed()) {
          event.sender.send('duplicate-progress', {
            ...progress,
            scopePath: volumeRoot,
            scanMode: inventory.scanMode,
            requestId
          });
        }
      }
    });
    job.controller.signal.throwIfAborted();
    return { ...result, scopePath: volumeRoot, scope, excludedFileCount,
      scanMode: inventory.scanMode, inventoryReused: Boolean(existingInventory) };
  } catch (error) {
    if (job.controller.signal.aborted || error.name === 'AbortError') return { cancelled: true };
    console.error('Duplicate analysis failed:', error);
    return { error: `Duplicate analysis failed: ${error.message}` };
  } finally {
    event.sender.removeListener('destroyed', abort);
    if (activeScanJob === job) activeScanJob = null;
  }
});

ipcMain.handle('export-csv', async (event, scanId) => {
  if (fileActionInProgress) return { error: 'Wait for the current file action to finish.' };
  if (!cachedScan || scanId !== cachedScanId) return { error: 'This scan has expired. Please scan the folder again.' };

  const scan = cachedScan;
  const rootName = path.basename(scan.folderPath)
    || scan.folderPath.replace(/[\\/:]/g, '').toLowerCase()
    || 'scan';
  const parentWindow = BrowserWindow.fromWebContents(event.sender);
  const saveOptions = {
    title: 'Export scan to CSV',
    defaultPath: path.join(app.getPath('downloads'), `${rootName}-diskoryx.csv`),
    filters: [{ name: 'CSV files', extensions: ['csv'] }]
  };
  const saveResult = parentWindow
    ? await dialog.showSaveDialog(parentWindow, saveOptions)
    : await dialog.showSaveDialog(saveOptions);
  if (saveResult.canceled || !saveResult.filePath) return { success: false, cancelled: true };
  if (cachedScan !== scan || scanId !== cachedScanId) return { error: 'This scan has expired. Please scan the folder again.' };
  if (fileActionInProgress) return { error: 'Wait for the current file action to finish.' };

  const outputPath = path.extname(saveResult.filePath).toLowerCase() === '.csv'
    ? saveResult.filePath
    : `${saveResult.filePath}.csv`;
  let rowCount = 0;

  activeExports++;
  try {
    const output = fsStream.createWriteStream(outputPath, { encoding: 'utf8' });
    const csvContent = async function* () {
      yield `\uFEFF${serializeCsvHeader()}`;
      for (const item of iterateScanTree(scan)) {
        rowCount++;
        yield serializeCsvRow(item);
        if (rowCount % 8192 === 0) await new Promise((resolve) => setImmediate(resolve));
      }
    };
    await pipeline(Readable.from(csvContent()), output);
    return { success: true, filePath: outputPath, rowCount };
  } catch (error) {
    return { error: `Unable to export CSV: ${error.message}` };
  } finally {
    activeExports--;
  }
});

function resolveScannedFile(filePath) {
  if (!cachedScan || typeof filePath !== 'string' || !filePath.trim()) {
    return { error: 'Scan the folder again before using file actions.' };
  }

  const resolvedPath = path.resolve(filePath);
  const relativePath = path.relative(cachedScan.folderPath, resolvedPath);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    return { error: 'This file is outside the current scanned folder.' };
  }

  return { path: resolvedPath };
}

ipcMain.handle('read-text-preview', async (_event, scanId, filePath, page, revision) => {
  if (!cachedScan || scanId !== cachedScanId) return { error: 'This scan has expired. Scan the folder again before previewing files.' };
  if (cachedScan.readOnly) return { error: ARCHIVE_PREVIEW, readOnly: true };
  const scan = cachedScan;
  const target = resolveScannedFile(filePath);
  if (target.error) return target;
  const targetKey = target.path.toLowerCase();
  let scannedFile = false;
  for (let index = 0; index < scan.fileNodes.length; index++) {
    if (path.resolve(scan.fileNodes[index].path).toLowerCase() === targetKey) {
      scannedFile = true;
      break;
    }
    if (index % 4096 === 4095) await new Promise(resolve => setImmediate(resolve));
  }
  if (cachedScan !== scan || scanId !== cachedScanId) return { error: 'This scan expired while loading the preview.' };
  if (!scannedFile) {
    return { error: 'This file is not part of the current scan.' };
  }
  try {
    const result = await readTextPage(target.path, scan.folderPath, page, revision);
    if (cachedScan !== scan || scanId !== cachedScanId) return { error: 'This scan expired while loading the preview.' };
    return result;
  } catch (error) {
    return { error: `Unable to preview file: ${error.message}` };
  }
});

async function validateScannedEntry(filePath) {
  try {
    const entryStats = await fs.lstat(filePath);
    if (entryStats.isSymbolicLink() || (!entryStats.isFile() && !entryStats.isDirectory())) {
      return { error: 'Only regular files and folders are supported.' };
    }
    return { success: true, isDirectory: entryStats.isDirectory() };
  } catch (error) {
    return { error: `Unable to access file: ${error.message}` };
  }
}

ipcMain.handle('open-support-page', async () => {
  try {
    await shell.openExternal('https://ko-fi.com/edi969247');
    return { success: true };
  } catch (error) {
    return { error: `Unable to open the support page: ${error.message}` };
  }
});

ipcMain.handle('copy-path', async (_event, filePath) => {
  const readOnly = archiveReadOnly();
  if (readOnly) return readOnly;
  const target = resolveScannedFile(filePath);
  if (target.error) return target;
  const entryCheck = await validateScannedEntry(target.path);
  if (!entryCheck.success) return entryCheck;

  clipboard.writeText(target.path);
  return { success: true };
});

ipcMain.handle('reveal-in-explorer', async (_event, filePath) => {
  const readOnly = archiveReadOnly();
  if (readOnly) return readOnly;
  const target = resolveScannedFile(filePath);
  if (target.error) return target;
  const entryCheck = await validateScannedEntry(target.path);
  if (!entryCheck.success) return entryCheck;

  try {
    if (entryCheck.isDirectory) {
      const error = await shell.openPath(target.path);
      if (error) return { error: `Unable to open folder: ${error}` };
    } else {
      shell.showItemInFolder(target.path);
    }
    return { success: true };
  } catch (error) {
    return { error: `Unable to open Explorer: ${error.message}` };
  }
});

let fileActionInProgress = false;

async function modifyScannedItem(event, scanId, filePath, newName, recycle, historyEntry = null) {
  if (fileActionInProgress || activeScanJob || activeExports) return { error: 'Wait for the current scan, CSV export or file action to finish.' };
  if (!cachedScan || scanId !== cachedScanId) return { error: 'This scan has expired. Scan again before modifying files.' };
  const readOnly = archiveReadOnly();
  if (readOnly) return readOnly;
  const scan = cachedScan;
  const target = resolveScannedFile(filePath);
  if (target.error) return target;
  fileActionInProgress = true;
  try {
    await actionHistory.load();
    let member = null;
    const targetKey = target.path.toLowerCase();
    for (const entries of [scan.fileNodes, scan.folderNodes]) {
      for (let index = 0; index < entries.length; index++) {
        if (entries[index]?.path?.toLowerCase() === targetKey) {
          member = entries[index];
          break;
        }
        if (index % 4096 === 4095) await new Promise(resolve => setImmediate(resolve));
      }
      if (member) break;
    }
    if (!member) throw new Error('The selected item is not part of this scan.');
    const snapshot = await inspectFileAction(scan.folderPath, target.path, historyEntry?.chain);
    let destination;
    if (recycle) {
      if (!await requestRecycleConfirmation(event.sender, target.path)) return { cancelled: true };
    } else {
      destination = path.join(path.dirname(target.path), validateNewName(newName));
      if (destination === target.path) return { success: true, unchanged: true };
      try {
        await fs.lstat(destination);
        throw new Error('A file or folder with that name already exists.');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (cachedScan !== scan || cachedScanId !== scanId || activeScanJob || event.sender.isDestroyed()) {
      throw new Error('The scan changed before the file action. Try again after scanning.');
    }
    const applyMutation = await prepareScanMutation(scan, member, destination);
    await inspectFileAction(scan.folderPath, target.path, snapshot);
    if (cachedScan !== scan || cachedScanId !== scanId || activeScanJob) throw new Error('The scan changed before the file action.');
    if (recycle) await recycleWithPinnedAncestors(scan.folderPath, target.path, snapshot, async markIssued => {
      if (cachedScan !== scan || cachedScanId !== scanId || activeScanJob || event.sender.isDestroyed()) {
        throw new Error('The scan or window changed before recycling.');
      }
      await inspectFileAction(scan.folderPath, target.path, snapshot);
      markIssued();
      await shell.trashItem(target.path);
    });
    else await renameWithHandles(scan.folderPath, target.path, newName, snapshot, () => {
      if (cachedScan !== scan || cachedScanId !== scanId || activeScanJob || event.sender.isDestroyed()) {
        throw new Error('The scan or window changed before committing rename.');
      }
    });
    applyMutation();
    if (historyEntry) actionHistory.restored(historyEntry, destination);
    else actionHistory.record(scan.folderPath, target.path, destination, snapshot);
    cachedScanId++;
    folderSortCache = new WeakMap();
    analysisCache = {};
    let historyWarning;
    try { await actionHistory.save(); }
    catch (error) {
      console.warn('File action completed but history was not saved:', error.message);
      historyWarning = `The file action completed, but history could not be saved for the next app session: ${error.message}`;
    }
    return {
      success: true, path: destination || target.path, scanId: cachedScanId,
      historyWarning,
      parentFolderId: member.parentFolderId,
      item: recycle ? null : projectItem(member, [], normalizeScanFilters(scan.scanFilters), 0)
    };
  } catch (error) {
    if (error.outcomeUncertain) {
      cachedScan = null;
      cachedScanId++;
      folderSortCache = new WeakMap();
      analysisCache = {};
    }
    console.warn('File action refused or failed:', error.message);
    return {
      error: `Unable to ${recycle ? 'recycle' : 'rename'} item: ${error.message}`,
      refreshRequired: error.outcomeUncertain === true
    };
  } finally {
    fileActionInProgress = false;
  }
}

ipcMain.handle('rename-file', (event, filePath, newName, scanId) =>
  modifyScannedItem(event, scanId, filePath, newName, false));
ipcMain.handle('delete-file', (event, filePath, scanId) =>
  modifyScannedItem(event, scanId, filePath, null, true));

ipcMain.handle('create-folder', async (event, scanId, folderId, name) => {
  if (fileActionInProgress || activeScanJob || activeExports || !cachedScan || cachedScanId !== scanId) {
    return { error: 'Wait for the current scan, export or file action and choose a folder from the current scan.' };
  }
  const readOnly = archiveReadOnly();
  if (readOnly) return readOnly;
  fileActionInProgress = true;
  const scan = cachedScan;
  try {
    validateNewName(name);
    if (!Number.isInteger(folderId) || folderId < 0 || !scan.folderNodes[folderId]) {
      throw new Error('Choose an available folder from the current scan.');
    }
    const parentPath = scan.folderNodes[folderId].path || scan.folderPath;
    const volumeRoot = path.parse(parentPath).root;
    const entries = parentPath.toLowerCase() === volumeRoot.toLowerCase()
      ? [] : await inspectFileAction(volumeRoot, parentPath);
    if (cachedScan !== scan || cachedScanId !== scanId || event.sender.isDestroyed()) {
      throw new Error('The scan changed before the folder could be created.');
    }
    const created = await createFolderWithHandles(scan.folderPath, parentPath, name, entries, () => {
      if (event.sender.isDestroyed() || cachedScan !== scan || cachedScanId !== scanId) {
        throw new Error('The scan or window changed before Create folder.');
      }
    });
    const folderPath = created.path;
    let item = null;
    let activeChanged = false;
    try {
      for (const snapshot of new Set([...savedScans.values(), scan])) {
        const inserted = await insertCopiedItem(snapshot, folderPath);
        if (snapshot === scan && inserted) { item = inserted; activeChanged = true; }
      }
      if (activeChanged) {
        cachedScanId++;
        folderSortCache = new WeakMap();
        analysisCache = {};
      }
    } catch (error) {
      console.warn('Folder created but saved snapshots could not be updated:', error.message);
      cachedScan = null;
      savedScans.clear();
      cachedScanId++;
      folderSortCache = new WeakMap();
      analysisCache = {};
      return {
        success: true, path: folderPath, scanId: cachedScanId,
        refreshRequired: true,
        warning: `Folder was created, but the saved view needs Rescan: ${error.message}`,
        actionLabel: 'Folder created; Rescan to refresh the view'
      };
    }
    return {
      success: true, path: folderPath, scanId: cachedScanId,
      item: item ? projectItem(item, [], normalizeScanFilters(scan.scanFilters), 0) : null,
      parentFolderId: item?.parentFolderId ?? folderId,
      snapshotChanged: activeChanged,
      hiddenByFilters: !item && scan.scanFilters?.excludeFolderNames?.includes(name.toLowerCase()),
      actionLabel: item ? 'Folder created' : 'Folder created outside this snapshot'
    };
  } catch (error) {
    if (error.outcomeUncertain) {
      cachedScan = null;
      savedScans.clear();
      cachedScanId++;
      folderSortCache = new WeakMap();
      analysisCache = {};
    }
    console.warn('Create folder refused or failed:', error.message);
    return { error: error.message, refreshRequired: error.outcomeUncertain === true };
  } finally {
    fileActionInProgress = false;
  }
});

ipcMain.handle('action-history', async () => {
  try {
    await actionHistory.load();
    return { success: true, entries: actionHistory.list(cachedScan?.folderPath) };
  } catch (error) {
    console.warn('Unable to load action history:', error.message);
    return { error: error.message };
  }
});
ipcMain.handle('restore-name', async (event, id, scanId) => {
  try {
    await actionHistory.load();
    const entry = actionHistory.get(id, cachedScan?.folderPath);
    const target = actionHistory.target(entry);
    return await modifyScannedItem(event, scanId, target.source, target.name, false, entry);
  } catch (error) {
    console.warn('History restore refused:', error.message);
    return { error: error.message };
  }
});

async function findScannedMember(scan, target) {
  const key = target.toLowerCase();
  for (const entries of [scan.fileNodes, scan.folderNodes]) {
    for (let index = 0; index < entries.length; index++) {
      if (entries[index]?.path?.toLowerCase() === key) return entries[index];
      if (index % 4096 === 4095) await new Promise(resolve => setImmediate(resolve));
    }
  }
  return null;
}

ipcMain.handle('copy-item', async (event, filePath, scanId, mode = 'copy') => {
  if (fileActionInProgress || activeScanJob || !cachedScan || cachedScanId !== scanId) {
    return { error: 'Wait for file actions/scanning and select an item from the current scan.' };
  }
  const readOnly = archiveReadOnly();
  if (readOnly) return readOnly;
  try {
    if (!['copy', 'move'].includes(mode)) throw new Error('Unsupported transfer selection.');
    const scan = cachedScan;
    const target = resolveScannedFile(filePath);
    if (target.error) return target;
    const member = await findScannedMember(scan, target.path);
    if (!member) throw new Error('The item is not part of this scan.');
    if (mode === 'move') {
      const pending = [member];
      let checked = 0;
      while (pending.length) {
        const item = pending.pop();
        if (item.hardLinkCount > 1) throw new Error('Move currently refuses hard-link aliases to preserve snapshot byte ownership.');
        if (item.type === 'folder') for (const child of item.children) pending.push(child);
        if (++checked > 4096) throw new Error('Move supports at most 4096 entries. Move smaller folders separately.');
        if (checked % 4096 === 0) await new Promise(resolve => setImmediate(resolve));
      }
    }
    const chain = await inspectFileAction(scan.folderPath, target.path);
    if (cachedScan !== scan || cachedScanId !== scanId || fileActionInProgress || activeScanJob) throw new Error('The scan changed. Copy the selection again.');
    copySelection = { source: target.path, root: scan.folderPath, chain, sender: event.sender, mode };
    return { success: true, name: path.basename(target.path), mode };
  } catch (error) {
    console.warn('Copy selection refused:', error.message);
    return { error: error.message };
  }
});

async function pasteSelection(event, selection, destination, previous = null) {
  if (!/^[A-Za-z]:\\/.test(destination)) throw new Error('Copy supports local drive folders only, not network or device paths.');
  const scan = cachedScan;
  const operation = selection.mode === 'move' ? 'Move' : 'Copy';
  const copy = { controller: new AbortController(), sender: event.sender };
  activeCopy = copy;
  const abort = () => copy.controller.abort();
  event.sender.once('destroyed', abort);
  try {
    await actionHistory.load();
    const root = path.parse(destination).root;
    const destinationEntries = destination === root ? [] : await inspectFileAction(root, destination);
    await inspectFileAction(selection.root, selection.source, selection.chain);
    if (selection.mode === 'move' && path.dirname(selection.source).toLowerCase() === destination.toLowerCase()) {
      throw new Error('The item is already in this folder. Nothing was moved.');
    }
    if (selection.mode === 'move') await inspectCopyTree(selection.source, copy.controller.signal, false);
    let name = selection.name || (previous ? path.basename(previous.destination) : path.basename(selection.source));
    if (!previous && selection.mode !== 'move' && path.dirname(selection.source).toLowerCase() === destination.toLowerCase()) {
      const extension = selection.chain.at(-1).isDirectory ? '' : path.extname(name);
      const stem = extension ? name.slice(0, -extension.length) : name;
      for (let number = 1; number <= 1000; number++) {
        name = `${stem} - Copy${number === 1 ? '' : ` (${number})`}${extension}`;
        try { await fs.lstat(path.join(destination, name)); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          break;
        }
        if (number === 1000) throw new Error('All 1000 numbered copy names are occupied. Rename the source before copying again.');
      }
    }
    const result = await copyWithHandles({
      root: selection.root, target: selection.source, entries: selection.chain,
      destination, destinationEntries, name,
      move: selection.mode === 'move'
    }, {
      signal: copy.controller.signal,
      beforeCommit: () => { if (event.sender.isDestroyed()) throw new Error('The window was closed.'); },
      onProgress: progress => {
        if (!event.sender.isDestroyed()) event.sender.send('copy-progress', progress);
      }
    });
    if (!result.success) return result;
    let historyWarning;
    let entry = previous;
    try {
      const destinationChain = await inspectFileAction(root, result.path);
      const receipt = await inspectCopyTree(result.path);
      if (entry && selection.mode === 'move') {
        Object.assign(entry, { state: entry.state === 'done' ? 'undone' : 'done', destinationChain, receipt });
      } else if (entry) Object.assign(entry, { state: 'done', destinationChain, receipt });
      else if (selection.mode === 'move') entry = actionHistory.recordMove(selection.root, selection.source, result.path,
        selection.chain, destinationChain, receipt);
      else entry = actionHistory.recordCopy(selection.root, selection.source, result.path,
        selection.chain, destinationChain, receipt);
      await actionHistory.save();
    } catch (error) {
      console.warn(`${operation} completed but history verification/save failed:`, error.message);
      historyWarning = `${operation} completed, but its Undo record could not be verified or saved: ${error.message}`;
    }
    let item = null;
    let refreshRequired = false;
    let snapshotChanged = false;
    try {
      if (scan && scan === cachedScan) {
        let sourceRemoved = false;
        if (selection.mode === 'move') {
          for (const snapshot of new Set([...savedScans.values(), scan])) {
            const sourceKey = scanKey(selection.source);
            const snapshotKey = scanKey(snapshot.folderPath);
            if (snapshot !== scan && (snapshotKey === sourceKey || snapshotKey.startsWith(`${sourceKey}\\`))) {
              savedScans.delete(snapshotKey);
              continue;
            }
            const member = await findScannedMember(snapshot, selection.source);
            if (member) {
              (await prepareScanMutation(snapshot, member, null))();
              if (snapshot === scan) sourceRemoved = true;
            }
            if (snapshot !== scan) await insertCopiedItem(snapshot, result.path);
          }
        }
        item = await insertCopiedItem(scan, result.path);
        if (item || sourceRemoved) {
          snapshotChanged = true;
          cachedScanId++;
          folderSortCache = new WeakMap();
          analysisCache = {};
        }
      }
    } catch (error) {
      console.warn(`${operation} completed but cached insertion failed:`, error.message);
      cachedScan = null; savedScans.clear(); cachedScanId++; folderSortCache = new WeakMap(); analysisCache = {};
      refreshRequired = true;
      historyWarning = `${historyWarning || ''} ${operation} completed, but the cached view could not be updated: ${error.message}`;
    }
    return {
      ...result, item: item ? projectItem(item, [], normalizeScanFilters(scan.scanFilters), 0) : null,
      parentFolderId: item?.parentFolderId ?? 0, scanId: cachedScanId,
      snapshotChanged: snapshotChanged && !refreshRequired, refreshRequired, historyWarning,
      actionLabel: selection.mode === 'move' ? 'Item moved' : 'Item copied', moved: selection.mode === 'move'
    };
  } finally {
    event.sender.removeListener('destroyed', abort);
    activeCopy = null;
  }
}

ipcMain.handle('paste-item', async (event, scanId, folderId) => {
  if (fileActionInProgress || activeScanJob || activeExports) return { error: 'Wait for the current scan, export or file action.' };
  const readOnly = archiveReadOnly();
  if (readOnly) return readOnly;
  if (!copySelection || copySelection.sender !== event.sender) return { error: 'Use Copy on a scanned file or folder first.' };
  if (!cachedScan || cachedScanId !== scanId) return { error: 'The destination scan changed. Open its folder again before pasting.' };
  if (!Number.isInteger(folderId) || folderId < 0 || !cachedScan.folderNodes[folderId]) {
    return { error: 'Choose an available destination folder in Diskoryx.' };
  }
  const destination = cachedScan.folderNodes[folderId].path || cachedScan.folderPath;
  fileActionInProgress = true;
  try {
    const selection = copySelection;
    const result = await pasteSelection(event, selection, destination);
    if (result.success && copySelection === selection) copySelection = null;
    return result;
  } catch (error) {
    if (error.outcomeUncertain) {
      cachedScan = null; savedScans.clear(); cachedScanId++;
      folderSortCache = new WeakMap(); analysisCache = {};
    }
    console.warn('Copy failed:', error.message);
    return { error: `Unable to transfer: ${error.message}`, refreshRequired: error.outcomeUncertain === true };
  } finally { fileActionInProgress = false; }
});

ipcMain.handle('move-history-action', async (event, id) => {
  if (fileActionInProgress || activeScanJob || activeExports) return { error: 'Wait for the current operation.' };
  const readOnly = archiveReadOnly();
  if (readOnly) return readOnly;
  fileActionInProgress = true;
  try {
    await actionHistory.load();
    const entry = actionHistory.entries.find(item => item.id === id && item.kind === 'move');
    if (!entry) throw new Error('This Move record is unavailable.');
    const undo = entry.state === 'done';
    const source = undo ? entry.destination : entry.source;
    const destination = undo ? entry.source : entry.destination;
    await verifyCopyTree(source, entry.receipt);
    const targetParent = path.dirname(destination);
    const targetRoot = path.parse(destination).root;
    if (targetParent !== targetRoot) {
      await inspectFileAction(targetRoot, targetParent, undo ? entry.originalParents : entry.destinationParents);
    }
    const selection = {
      source, root: path.parse(source).root, chain: entry.destinationChain,
      sender: event.sender, mode: 'move', name: path.basename(destination)
    };
    return await pasteSelection(event, selection, path.dirname(destination), entry);
  } catch (error) {
    if (error.outcomeUncertain) {
      cachedScan = null; savedScans.clear(); cachedScanId++;
      folderSortCache = new WeakMap(); analysisCache = {};
    }
    console.warn('Move restore refused:', error.message);
    return { error: error.message, refreshRequired: error.outcomeUncertain === true };
  } finally {
    fileActionInProgress = false;
  }
});

ipcMain.handle('cancel-copy', event => {
  if (!activeCopy || activeCopy.sender !== event.sender) return { error: 'No owned copy is running.' };
  activeCopy.controller.abort();
  return { success: true };
});

ipcMain.handle('clear-copy-selection', event => {
  if (copySelection?.sender === event.sender) copySelection = null;
  return { success: true };
});

ipcMain.handle('copy-history-action', async (event, id) => {
  if (fileActionInProgress || activeScanJob || activeExports) return { error: 'Wait for the current scan, export or file action.' };
  const readOnly = archiveReadOnly();
  if (readOnly) return readOnly;
  fileActionInProgress = true;
  try {
    await actionHistory.load();
    const entry = actionHistory.getCopy(id);
    if (entry.state === 'undone') {
      return await pasteSelection(event, { root: entry.root, source: entry.source, chain: entry.chain },
        path.dirname(entry.destination), entry);
    }
    const scan = cachedScan;
    const scanId = cachedScanId;
    if (!await requestRecycleConfirmation(event.sender, entry.destination)) return { cancelled: true };
    await inspectFileAction(path.parse(entry.destination).root, entry.destination, entry.destinationChain);
    const member = scan ? await findScannedMember(scan, entry.destination) : null;
    const applyMutation = member ? await prepareScanMutation(scan, member, null) : null;
    await recycleWithPinnedAncestors(path.parse(entry.destination).root, entry.destination,
      entry.destinationChain, async markIssued => {
        if (cachedScan !== scan || cachedScanId !== scanId || event.sender.isDestroyed()) throw new Error('The scan or window changed.');
        await verifyCopyTree(entry.destination, entry.receipt);
        await inspectFileAction(path.parse(entry.destination).root, entry.destination, entry.destinationChain);
        markIssued();
        await shell.trashItem(entry.destination);
      });

    if (applyMutation) {
      applyMutation();
      cachedScanId++; folderSortCache = new WeakMap(); analysisCache = {};
    }
    entry.state = 'undone';
    let historyWarning;
    try { await actionHistory.save(); } catch (error) {
      console.warn('Copy undone but history could not be saved:', error.message);
      historyWarning = `Copy was moved to Recycle Bin, but history could not be saved: ${error.message}`;
    }
    return {
      success: true, scanId: cachedScanId, snapshotChanged: Boolean(member),
      parentFolderId: member?.parentFolderId, item: null, historyWarning,
      actionLabel: 'Copy moved to Recycle Bin; original unchanged'
    };
  } catch (error) {
    console.warn('Copy history action refused or failed:', error.message);
    if (error.outcomeUncertain) {
      cachedScan = null; cachedScanId++; folderSortCache = new WeakMap(); analysisCache = {};
    }
    return { error: error.message, refreshRequired: error.outcomeUncertain === true };
  } finally { fileActionInProgress = false; }
});

ipcMain.handle('restore-recycled-item', async (event, id) => {
  if (fileActionInProgress || activeScanJob || activeExports) return { error: 'Wait for the current scan, export or file action.' };
  const readOnly = archiveReadOnly();
  if (readOnly) return readOnly;
  fileActionInProgress = true;
  try {
    await actionHistory.load();
    const entry = actionHistory.getRecycle(id);
    const originalParent = path.dirname(entry.source);
    const volume = path.parse(entry.source).root;
    const expectedParents = entry.chain.slice(0, -1);
    const parentChain = originalParent === volume ? [] :
      await inspectFileAction(volume, originalParent, expectedParents);
    const request = await findRecycledEntry(entry);
    request.destinationEntries = parentChain;
    const restored = await restoreWithHandles(request, async () => {
      if (event.sender.isDestroyed()) throw new Error('The window closed before restore.');
      const metadata = await readMetadata(request.metadata);
      if (metadata.originalPath.toLowerCase() !== entry.source.toLowerCase()) throw new Error('Recycle Bin metadata changed before restore.');
      const leaf = (await inspectFileAction(volume, request.target, request.entries)).at(-1);
      if (leaf.identity !== entry.chain.at(-1).identity) throw new Error('Recycled item identity changed.');
    });
    entry.state = 'restored';
    let historyWarning = restored.warning;
    try { await actionHistory.save(); } catch (error) {
      console.warn('Item restored but history could not be saved:', error.message);
      historyWarning = `${historyWarning || ''} Item restored, but history could not be saved: ${error.message}`;
    }
    let item = null;
    let refreshRequired = false;
    try {
      if (cachedScan) item = await insertCopiedItem(cachedScan, entry.source);
      if (item) { cachedScanId++; folderSortCache = new WeakMap(); analysisCache = {}; }
    } catch (error) {
      console.warn('Item restored but cached insertion failed:', error.message);
      cachedScan = null; cachedScanId++; folderSortCache = new WeakMap(); analysisCache = {};
      refreshRequired = true;
      historyWarning = `${historyWarning || ''} Restore completed but the view needs Rescan: ${error.message}`;
    }
    return {
      success: true, scanId: cachedScanId, path: entry.source, snapshotChanged: Boolean(item),
      item: item ? projectItem(item, [], normalizeScanFilters(cachedScan.scanFilters), 0) : null,
      parentFolderId: item?.parentFolderId, historyWarning, refreshRequired,
      actionLabel: 'Item restored from Recycle Bin'
    };
  } catch (error) {
    console.warn('Recycle restore refused or failed:', error.message);
    if (error.outcomeUncertain) {
      cachedScan = null; cachedScanId++; folderSortCache = new WeakMap(); analysisCache = {};
    }
    return { error: `Unable to restore: ${error.message}`, refreshRequired: error.outcomeUncertain === true };
  } finally { fileActionInProgress = false; }
});
