const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const electron = require('electron');
electron.app.disableHardwareAcceleration();

const temporaryRoot = process.env.DISKORYX_SMOKE_ROOT;
const realRecycle = process.env.DISKORYX_SMOKE_REAL_RECYCLE === '1';
const multiDrive = process.env.DISKORYX_SMOKE_MULTI_DRIVE === '1';
// Saved-scan checks reuse the native save/open dialogs with owned fixture paths.
const archiveSaveTarget = process.env.DISKORYX_SMOKE_ARCHIVE_SAVE || null;
const archiveOpenTarget = process.env.DISKORYX_SMOKE_ARCHIVE_OPEN || null;
const archiveReopenOnly = process.env.DISKORYX_SMOKE_ARCHIVE_OPEN_ONLY === '1';
const duplicateUI = process.env.DISKORYX_SMOKE_DUPLICATES === '1';
if (!temporaryRoot) throw new Error('Run with npm run test:smoke, not directly.');
const instanceProfile = path.join(temporaryRoot, 'profile');
fsSync.mkdirSync(instanceProfile, { recursive: true });
electron.app.setPath('userData', instanceProfile);
electron.app.setPath('sessionData', temporaryRoot);
const mainRoot = path.join(__dirname, '..', 'src', 'main');
const mainRequire = createRequire(path.join(mainRoot, 'main.js'));
let window;
let scans = 0;
let volumeInventoryScans = 0;
let recycleCount = 0;
let initialCopyRecord;
const rendererErrors = [];
const requests = [];
const supportLinks = [];
let supportBrowserFailure = false;
const fixtureDrives = ['A', 'B', 'C'].map(letter => ({
  path: path.join(temporaryRoot, `drive-${letter}`), label: `Fixture ${letter}`
}));
let resolveLoaded;
let rejectLoaded;
const loaded = new Promise((resolve, reject) => { resolveLoaded = resolve; rejectLoaded = reject; });

class HiddenWindow extends electron.BrowserWindow {
  constructor(options) {
    super({ ...options, show: false, skipTaskbar: true });
    this.webContents.setBackgroundThrottling(false);
    window = this;
    this.webContents.on('preload-error', (_event, _file, error) => rendererErrors.push(error.message));
    this.webContents.on('console-message', event => {
      if (event.level === 'error') rendererErrors.push(event.message);
    });
    this.webContents.once('did-fail-load', (_event, code, description) => rejectLoaded(new Error(`${code}: ${description}`)));
    this.webContents.once('did-finish-load', resolveLoaded);
  }
}

const isolatedApp = new Proxy(electron.app, {
  get(target, key) {
    if (key === 'getPath') return name =>
      name === 'appData' ? path.join(temporaryRoot, 'settings') : target.getPath(name);
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  }
});

async function run() {
  await fs.mkdir(path.join(temporaryRoot, 'settings'), { recursive: true });
  await fs.mkdir(path.join(temporaryRoot, 'scan'), { recursive: true });
  await fs.mkdir(path.join(temporaryRoot, 'scan', 'copy-destination'), { recursive: true });
  await fs.writeFile(path.join(temporaryRoot, 'scan', 'example.log'), 'log line\n'.repeat(10000));
  await fs.writeFile(path.join(temporaryRoot, 'scan', 'settings.json'), '{"enabled":true}');
  if (multiDrive) {
    for (let index = 0; index < fixtureDrives.length; index++) {
      await fs.mkdir(fixtureDrives[index].path);
      await fs.writeFile(path.join(fixtureDrives[index].path, `disk-${index}.txt`), 'x'.repeat((index + 1) * 11));
    }
  }
  await electron.app.whenReady();
  electron.session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (/^https?:/i.test(details.url)) requests.push(details.url);
    callback({ cancel: /^https?:/i.test(details.url) });
  });
  vm.runInNewContext(fsSync.readFileSync(path.join(mainRoot, 'main.js'), 'utf8'), {
    __dirname: mainRoot, process, console, setImmediate, setTimeout, clearTimeout, AbortController,
    require(name) {
      if (name === 'electron') return {
        ...electron, app: isolatedApp, BrowserWindow: HiddenWindow,
        ipcMain: new Proxy(electron.ipcMain, {
          get(target, key) {
            if (key === 'handle') return (name, handler) => target.handle(name,
              multiDrive && name === 'list-drives' ? async () => ({ drives: fixtureDrives }) : handler);
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          }
        }),
        dialog: {
          ...electron.dialog,
          showSaveDialog: async (maybeWindow, maybeOptions) => archiveSaveTarget
            ? { canceled: false, filePath: archiveSaveTarget }
            : electron.dialog.showSaveDialog(maybeWindow, maybeOptions),
          showOpenDialog: async () => {
            if (archiveOpenTarget) return { canceled: false, filePaths: [archiveOpenTarget] };
            throw new Error('Copy/Paste must stay inside Diskoryx');
          }
        },
        shell: {
          ...electron.shell,
          openExternal: async url => {
            if (supportBrowserFailure) throw new Error('Browser unavailable for smoke check');
            supportLinks.push(url);
          },
          // Exercise UI/backend completion without touching the real Windows Recycle Bin.
          trashItem: target => realRecycle
            ? electron.shell.trashItem(target)
            : fs.rename(target, path.join(temporaryRoot, `recycled-${++recycleCount}.txt`))
        }
      };
      if (name === './scanner') return {
        ...mainRequire(name),
        scanFolder(folderPath, ...args) {
          if (duplicateUI && /^[a-z]:\\$/i.test(folderPath)) {
            volumeInventoryScans++;
            return mainRequire(name).scanFolder(path.join(temporaryRoot, 'scan'), ...args);
          }
          scans++;
          return mainRequire(name).scanFolder(folderPath, ...args);
        }
      };
      if (name === './mft-scanner' && duplicateUI) return {
        ...mainRequire(name),
        getMftScannerPath: () => null
      };
      if (name === './duplicates' && duplicateUI) return {
        ...mainRequire(name),
        findDuplicates: (_volumeRoot, options) =>
          mainRequire(name).findDuplicates(path.join(temporaryRoot, 'scan'), options)
      };
      if (name === './live-updates' && process.env.DISKORYX_SMOKE_LIVE !== '1') return {
        createLiveMonitor: () => ({ start: () => true, stop() {} })
      };
      if (name === './mft-broker' && process.env.DISKORYX_SMOKE_STARTUP_ERROR === '1') return {
        ...mainRequire(name),
        requireStandardUser() { throw new Error('Start Diskoryx normally, not as administrator. <literal test>'); }
      };
      return mainRequire(name);
    }
  });
  await loaded;
  const js = source => window.webContents.executeJavaScript(source);
  if (archiveReopenOnly) return runArchiveReopen(js);
  if (process.env.DISKORYX_SMOKE_STARTUP_ERROR === '1') {
    assert.equal(await js('document.getElementById("startup-message").textContent'),
      'Start Diskoryx normally, not as administrator. <literal test>');
    assert.equal(await js('document.getElementById("startup-message").children.length'), 0);
    assert.equal(await js('document.activeElement.id'), 'startup-close');
    assert.equal(await js('typeof window.electronAPI'), 'undefined');
    assert.equal(await js('typeof window.require'), 'undefined');
    assert.equal(await js('document.getElementById("scan-drive-btn")'), null);
    assert.equal(await js('getComputedStyle(document.querySelector(".startup-card")).backgroundColor'),
      'rgb(23, 24, 31)');
    assert.deepEqual(rendererErrors, []);
    assert.deepEqual(requests, []);
    console.log('PASS: isolated themed startup failure, literal message, close focus, no preload or scan UI.');
    await js('document.getElementById("startup-close").click()');
    return;
  }
  const waitFor = async expression => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await js(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const state = await js(`JSON.stringify({
      scanInProgress, fileActionInProgress, currentScanId, contextScanId,
      contextPath: contextFile?.path,
      message: document.getElementById('message-text').textContent,
      messageOpen: document.getElementById('message-dialog').open,
      toast: document.getElementById('action-toast').textContent,
      menuHidden: fileContextMenu.hidden
    })`);
    throw new Error(`Timed out: ${expression}; state: ${state}`);
  };
  const contextAction = async (name, action) => waitFor(`(() => {
    if (scanInProgress || fileActionInProgress) return false;
    const item = virtualTree.root.children.find(item => item.name === ${JSON.stringify(name)});
    if (!item) return false;
    showFileContextMenu(item, { preventDefault() {}, clientX: 20, clientY: 20 });
    document.querySelector('[data-file-action="${action}"]').click();
    return true;
  })()`);
  assert.equal(window.isVisible(), false);
  assert.equal(await js('typeof window.electronAPI.scanFolder'), 'function');
  assert.equal(await js('typeof window.require'), 'undefined');
  assert.equal(await js('typeof window.VirtualTree'), 'function');
  assert.equal(await js('typeof window.DiskTreemap'), 'function');
  assert.equal(await js('typeof window.d3.treemap'), 'function');
  assert.deepEqual(supportLinks, []);
  await js('document.getElementById("support-btn").click()');
  await waitFor('!document.getElementById("support-btn").disabled');
  assert.deepEqual(supportLinks, ['https://ko-fi.com/edi969247']);
  supportBrowserFailure = true;
  await js('document.getElementById("support-btn").click()');
  await waitFor('!document.getElementById("support-btn").disabled && messageDialog.open');
  assert.match(await js('document.getElementById("message-text").textContent'), /Browser unavailable/);
  await js('document.getElementById("message-close").click()');
  supportBrowserFailure = false;
  await js('document.fonts.ready');
  assert.equal(await js('document.fonts.check(\'900 14px "Font Awesome 6 Free"\')'), true);
  const folderPath = path.join(temporaryRoot, 'scan');
  await js(`runScan(id => window.electronAPI.scanFolder(${JSON.stringify(folderPath)}, currentScanFilters, id))`);
  await waitFor('currentResult?.fileCount === 2 && !scanInProgress');
  await waitFor('!document.getElementById("volume-capacity").hidden && !document.getElementById("volume-capacity").textContent.includes("Checking")');
  assert.doesNotMatch(await js('document.getElementById("volume-capacity").textContent'), /Unavailable/);
  assert.match(await js('document.getElementById("volume-capacity").textContent'), /Whole volume/);
  assert.doesNotMatch(await js('document.getElementById("volume-capacity").textContent'), /Volume/);
  assert.equal(await js('document.getElementById("location-label").textContent'), folderPath);
  const duration = await js('currentResult.scanDurationMs');
  if (duplicateUI) {
    const firstDuplicate = path.join(folderPath, 'duplicate-smoke-one.txt');
    const secondDuplicate = path.join(folderPath, 'duplicate-smoke-two.txt');
    await fs.writeFile(firstDuplicate, 'same duplicate smoke content');
    await fs.writeFile(secondDuplicate, 'same duplicate smoke content');
    await js('document.querySelector(\'[data-view="duplicates"]\').click()');
    const driveRoot = path.parse(folderPath).root;
    await waitFor(`Array.from(document.getElementById("duplicates-drive-select").options).some(option => option.value === ${JSON.stringify(driveRoot)})`);
    await js(`(() => { const select = document.getElementById("duplicates-drive-select"); select.value = ${JSON.stringify(driveRoot)}; select.dispatchEvent(new Event("change")); })()`);
    assert.equal(await js('document.getElementById("duplicates-scope-select").value'), 'user');
    // Disposable smoke files live in AppData, which User files deliberately excludes.
    await js('document.getElementById("duplicates-scope-select").value = "all"; document.getElementById("duplicates-scope-select").dispatchEvent(new Event("change"))');
    await js('document.getElementById("find-duplicates-btn").click()');
    await waitFor('!scanInProgress && !document.getElementById("duplicates-results").hidden && document.getElementById("duplicates-groups").textContent === "1"');
    assert.equal(await js('document.querySelectorAll("#duplicates-chart .duplicate-bar").length'), 1);
    assert.equal(await js('document.querySelectorAll("#duplicates-rows details[open]").length'), 0);
    await js('document.querySelector("#duplicates-chart button").click()');
    assert.equal(await js('document.querySelectorAll("#duplicates-rows details[open]").length'), 1);
    assert.match(await js('document.getElementById("duplicates-rows").textContent'), /duplicate-smoke-one\.txt/);
    assert.match(await js('document.getElementById("duplicates-rows").textContent'), /duplicate-smoke-two\.txt/);
    assert.match(await js('document.getElementById("duplicates-status").textContent'), /[A-Z]:\\/i);
    assert.match(await js('document.getElementById("duplicates-status").title'), /not an estimate of physical disk space freed/);
    await js('document.getElementById("duplicates-query").value = "no-match-smoke"; document.getElementById("duplicates-query").dispatchEvent(new Event("input"))');
    assert.equal(await js('document.getElementById("duplicates-rows").children.length'), 0);
    await js('document.getElementById("duplicates-query").value = ""; document.getElementById("duplicates-query").dispatchEvent(new Event("input"))');
    assert.equal(await js('document.getElementById("duplicates-rows").children.length'), 1);
    const duplicateCaptureDir = process.env.DISKORYX_SMOKE_DUPLICATES_CAPTURE_DIR;
    if (duplicateCaptureDir) {
      await fs.mkdir(duplicateCaptureDir, { recursive: true });
      await window.webContents.capturePage();
      await new Promise(resolve => setTimeout(resolve, 250));
      await fs.writeFile(path.join(duplicateCaptureDir, 'duplicates-dark.png'),
        (await window.webContents.capturePage()).toPNG());
    }
    assert.equal(volumeInventoryScans, 1, 'a subfolder scan must be expanded to a full-drive inventory');
    const darkDuplicates = await js('getComputedStyle(document.getElementById("duplicates-panel")).backgroundColor');
    await js('document.getElementById("theme-toggle").click()');
    const lightDuplicates = await js('getComputedStyle(document.getElementById("duplicates-panel")).backgroundColor');
    assert.notEqual(darkDuplicates, lightDuplicates);
    assert.equal(await js(`getComputedStyle(document.querySelector("#duplicates-panel > .section-header")).backgroundColor
      === getComputedStyle(document.querySelector(".duplicates-metrics > div")).backgroundColor`), true);
    if (duplicateCaptureDir) {
      await window.webContents.capturePage();
      await new Promise(resolve => setTimeout(resolve, 250));
      await fs.writeFile(path.join(duplicateCaptureDir, 'duplicates-light.png'),
        (await window.webContents.capturePage()).toPNG());
    }
    await js('document.getElementById("theme-toggle").click()');
    await js('document.querySelector(\'[data-view="explorer"]\').click()');
    await fs.rm(firstDuplicate, { force: true });
    await fs.rm(secondDuplicate, { force: true });
    console.log('PASS: live Duplicate Finder scans user-selected files, renders safe results, and follows both themes.');
  }
  await contextAction('settings.json', 'rename');
  await js(`renameInput.value = 'renamed.txt'; renameForm.requestSubmit();`);
  await waitFor('!fileActionInProgress && virtualTree.selectedPath?.endsWith("renamed.txt")');
  assert.equal(await fs.readFile(path.join(folderPath, 'renamed.txt'), 'utf8'), '{"enabled":true}');
  assert.equal(await js('currentResult.scanDurationMs'), duration);
  assert.equal(await js('currentResult.filesByType.txt'), 1);
  assert.equal(scans, 1);
  await js('document.getElementById("history-btn").click()');
  await waitFor('document.querySelectorAll("#history-rows tr").length === 1');
  assert.equal(await js('document.getElementById("history-dialog").open'), true);
  assert.equal(await js('document.querySelector("#history-rows button").textContent'), 'Restore name');
  await js('document.querySelector("#history-rows button").click()');
  await waitFor('!fileActionInProgress && document.querySelector("#history-rows button")?.textContent === "Redo rename"');
  assert.equal(await fs.readFile(path.join(folderPath, 'settings.json'), 'utf8'), '{"enabled":true}');
  await js('document.querySelector("#history-rows button").click()');
  await waitFor('!fileActionInProgress && document.querySelector("#history-rows button")?.textContent === "Restore name"');
  assert.equal(await fs.readFile(path.join(folderPath, 'renamed.txt'), 'utf8'), '{"enabled":true}');
  assert.equal(scans, 1, 'name restore and redo must update cached snapshot without scanning');
  await js('document.getElementById("history-close").click()');
  if (realRecycle) {
    await contextAction('renamed.txt', 'delete');
    await waitFor('document.getElementById("recycle-dialog").open');
    await js('document.getElementById("recycle-confirm").click()');
    await waitFor('!fileActionInProgress && currentResult?.fileCount === 1');
    await js('document.getElementById("history-btn").click()');
    await waitFor('document.querySelector("#history-rows tr button")?.textContent === "Restore from Recycle Bin"');
    await js('document.querySelector("#history-rows tr button").click()');
    await waitFor('!fileActionInProgress && currentResult?.fileCount === 2');
    assert.equal(await fs.readFile(path.join(folderPath, 'renamed.txt'), 'utf8'), '{"enabled":true}');
    await js('document.getElementById("history-close").click()');
    console.log('PASS: real Recycle Bin restore works before any Copy or Undo action.');
  }
  await js('document.querySelector(\'[data-view="largest"]\').click()');
  await waitFor('document.querySelectorAll("#analysis-rows tr").length === 2');
  assert.equal(await js('document.getElementById("analysis-panel").hidden'), false);
  assert.equal(await js('getComputedStyle(document.querySelector(".app-content")).display'), 'none');
  assert.match(await js('document.querySelector("#analysis-rows tr").textContent'), /example.log/);
  assert.equal(await js('document.getElementById("largest-chart").hidden'), false);
  assert.equal(await js('document.querySelectorAll(".largest-chart-row").length'), 2);
  assert.equal(await js('document.querySelector(".largest-chart-track > span").style.width'), '100%');
  await js('document.querySelector(\'[data-view="types"]\').click()');
  await waitFor('document.getElementById("analysis-title").textContent === "File types" && document.querySelectorAll("#analysis-rows tr").length === 2');
  assert.equal(await js('document.getElementById("largest-chart").hidden'), true);
  await js('document.querySelector("#analysis-rows button").click()');
  await waitFor('document.getElementById("analysis-title").textContent === "Largest files" && document.querySelectorAll("#analysis-rows tr").length === 1');
  await js('document.querySelector(\'[data-view="explorer"]\').click()');
  assert.equal(await js('document.getElementById("analysis-panel").hidden'), true);
  assert.equal(scans, 1, 'independent analysis must not scan again');
  await contextAction('renamed.txt', 'copy');
  await waitFor('document.getElementById("action-toast").textContent.includes("selected.")');
  await contextAction('copy-destination', 'paste');
  await waitFor('!fileActionInProgress && !document.getElementById("copy-dialog").open');
  await waitFor('document.getElementById("message-title").textContent === "Copied successfully" && messageDialog.open');
  assert.equal(await js('document.getElementById("message-text").textContent'), 'Item copied');
  await js('document.getElementById("message-close").click()');
  assert.equal(await js('messageDialog.open'), false);
  assert.equal(await fs.readFile(path.join(folderPath, 'copy-destination', 'renamed.txt'), 'utf8'), '{"enabled":true}');
  assert.equal(await fs.readFile(path.join(folderPath, 'renamed.txt'), 'utf8'), '{"enabled":true}');
  await js('document.getElementById("history-btn").click()');
  await waitFor(`document.querySelectorAll("#history-rows tr").length === ${realRecycle ? 3 : 2}`);
  assert.match(await js('document.querySelector("#history-rows tr").textContent'), /Undo copy/);
  assert.equal(await js(`Array.from(document.querySelectorAll('.history-table th')).every(cell =>
    getComputedStyle(cell).whiteSpace === 'nowrap')`), true);
  assert.equal(await js('document.querySelectorAll("#history-rows tr:first-child .history-location").length'), 2);
  if (process.env.DISKORYX_SMOKE_CAPTURE) {
    for (const theme of ['dark', 'light']) {
      await js(`document.body.dataset.theme = ${JSON.stringify(theme)}`);
      await window.webContents.capturePage();
      await new Promise(resolve => setTimeout(resolve, 250));
      const image = await window.webContents.capturePage();
      await fs.writeFile(path.join(process.env.DISKORYX_SMOKE_CAPTURE, `history-${theme}.png`), image.toPNG());
    }
    await js('document.body.dataset.theme = "dark"');
  }
  if (realRecycle) {
    initialCopyRecord = JSON.parse(await fs.readFile(path.join(electron.app.getPath('userData'), 'action-history.json'), 'utf8'))
      .entries.find(entry => entry.kind === 'copy');
  }
  await js('document.querySelector("#history-rows tr button").click()');
  await waitFor('document.getElementById("recycle-dialog").open');
  await js('document.getElementById("recycle-confirm").click()');
  await waitFor('!fileActionInProgress && document.querySelector("#history-rows tr button")?.textContent === "Redo copy"');
  await assert.rejects(fs.stat(path.join(folderPath, 'copy-destination', 'renamed.txt')), { code: 'ENOENT' });
  await js('document.querySelector("#history-rows tr button").click()');
  await waitFor('!fileActionInProgress && document.querySelector("#history-rows tr button")?.textContent === "Undo copy (Recycle Bin)"');
  assert.equal(await fs.readFile(path.join(folderPath, 'copy-destination', 'renamed.txt'), 'utf8'), '{"enabled":true}');
  assert.equal(scans, 1);
  await js('document.getElementById("history-close").click()');
  const filePath = path.join(folderPath, 'example.log');
  const preview = await js(`window.electronAPI.readTextPreview(currentScanId, ${JSON.stringify(filePath)}, 1, null)`);
  assert.equal(preview.success, true);
  assert.equal(preview.page, 1);
  await contextAction('renamed.txt', 'delete');
  await waitFor('document.getElementById("recycle-dialog").open');
  assert.equal(await js('document.activeElement.id'), 'recycle-cancel');
  const dark = await js('getComputedStyle(document.getElementById("recycle-dialog")).backgroundColor');
  await js('document.getElementById("recycle-cancel").click()');
  await waitFor('!fileActionInProgress');
  assert.equal(await js('currentResult.fileCount'), 3);
  await js('document.getElementById("theme-toggle").click()');
  await contextAction('renamed.txt', 'delete');
  await waitFor('document.getElementById("recycle-dialog").open');
  const light = await js('getComputedStyle(document.getElementById("recycle-dialog")).backgroundColor');
  assert.notEqual(dark, light);
  await js('document.getElementById("recycle-confirm").click()');
  await waitFor('!fileActionInProgress && currentResult?.fileCount === 2');
  assert.equal(scans, 1);
  assert.equal(await js('currentResult.folderCount'), 1);
  assert.equal(await js('document.getElementById("recycle-dialog").open'), false);
  await js(`window.alert = () => { throw new Error('Native alert must not be used'); };
    showAppMessage('<img src=x onerror=alert(1)>\\nRecycle completion is uncertain. Rescan.');`);
  assert.equal(await js('document.getElementById("message-dialog").open'), true);
  assert.equal(await js('document.activeElement.id'), 'message-close');
  assert.equal(await js('document.getElementById("message-text").children.length'), 0);
  assert.equal(await js('getComputedStyle(document.getElementById("message-dialog")).backgroundColor'), light);
  await js('document.getElementById("message-close").click()');
  assert.equal(await js('document.getElementById("message-dialog").open'), false);
  await js('document.getElementById("theme-toggle").click(); showAppMessage("Access denied");');
  assert.equal(await js('getComputedStyle(document.getElementById("message-dialog")).backgroundColor'), dark);
  await window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  await window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await waitFor('!document.getElementById("message-dialog").open');
  if (process.env.DISKORYX_SMOKE_LIVE === '1') {
    const beforeFiles = await js('currentResult.fileCount');
    const beforeBytes = await js('currentResult.totalSizeBytes');
    const added = path.join(folderPath, 'externally-added.txt');
    await fs.writeFile(added, '12345');
    await waitFor(`currentResult?.fileCount === ${beforeFiles + 1} && currentResult.totalSizeBytes === ${beforeBytes + 5}`);
    await fs.writeFile(added, '123456789');
    await waitFor(`currentResult?.totalSizeBytes === ${beforeBytes + 9}`);
    const externalRename = path.join(folderPath, 'external-rename.json');
    await fs.rename(added, externalRename);
    await waitFor('currentResult?.filesByType.json === 1 && !fileActionInProgress');
    await fs.unlink(externalRename);
    await waitFor(`currentResult?.fileCount === ${beforeFiles} && currentResult.totalSizeBytes === ${beforeBytes}`);
    const restoredOutside = path.join(temporaryRoot, 'external-restored-folder');
    await fs.mkdir(restoredOutside);
    await fs.writeFile(path.join(restoredOutside, 'restored.txt'), '123');
    const restoredInside = path.join(folderPath, 'external-restored-folder');
    await fs.rename(restoredOutside, restoredInside);
    await waitFor(`currentResult?.fileCount === ${beforeFiles + 1} && currentResult.totalSizeBytes === ${beforeBytes + 3}`);
    await fs.rm(restoredInside, { recursive: true });
    await waitFor(`currentResult?.fileCount === ${beforeFiles} && currentResult.totalSizeBytes === ${beforeBytes}`);
    assert.equal(await js('document.getElementById("live-status")'), null);
    assert.equal(scans, 1, 'external changes must not trigger a full scan');
    console.log('PASS: real Windows notifications updated external add/size/rename/delete and restored-folder arrival without rescanning.');
    if (process.env.DISKORYX_SMOKE_LIVE_PAUSE === '1') {
      const browseFolder = path.join(folderPath, 'live-browse-folder');
      await fs.mkdir(browseFolder);
      await fs.writeFile(path.join(browseFolder, 'child.txt'), 'saved snapshot child');
      await waitFor(`currentResult?.fileCount === ${beforeFiles + 1} && !fileActionInProgress`);
      const savedCount = await js('currentResult.fileCount');
      const alias = path.join(folderPath, 'unsupported-hard-link');
      await fs.link(filePath, alias);
      await new Promise(resolve => setTimeout(resolve, 500));
      assert.equal(await js('currentResult.fileCount'), savedCount);
      assert.equal(await js('document.getElementById("export-csv-btn").disabled'), false);
      const folderId = await js('virtualTree.root.children.find(item => item.name === "live-browse-folder").folderId');
      const page = await js(`window.electronAPI.getFolderPage(currentScanId, ${folderId}, 0, 200, "name", [], currentScanFilters)`);
      assert.equal(page.success, true);
      assert.match(JSON.stringify(page), /child.txt/);
      await js('document.querySelector(\'[data-view="largest"]\').click()');
      await waitFor(`document.querySelectorAll("#analysis-rows tr").length === ${savedCount}`);
      await js('document.querySelector(\'[data-view="explorer"]\').click()');
      await contextAction('live-browse-folder', 'rename');
      await js('renameInput.value = "renamed-live-folder"; renameForm.requestSubmit();');
      await waitFor('!fileActionInProgress && virtualTree.selectedPath?.endsWith("renamed-live-folder")');
      assert.equal(await fs.readFile(path.join(folderPath, 'renamed-live-folder', 'child.txt'), 'utf8'), 'saved snapshot child');
      await contextAction('renamed-live-folder', 'delete');
      await waitFor('document.getElementById("recycle-dialog").open');
      await js('document.getElementById("recycle-confirm").click()');
      await waitFor(`!fileActionInProgress && currentResult?.fileCount === ${beforeFiles}`);
      assert.equal(scans, 1, 'paused browsing and guarded mutations must not rescan');
      await fs.unlink(alias);
      console.log('PASS: real watcher pause preserved folder paging, analysis, export availability and guarded rename/recycle without rescanning.');
    }
  }
  if (process.env.DISKORYX_SMOKE_MFT === '1') {
    // Opt-in read-only drive scan, real UAC and real renderer/IPC/import path.
    const scanReadyStarted = await js('performance.now()');
    await js('runScan(id => window.electronAPI.scanFolder("C:\\\\", currentScanFilters, id))');
    assert.equal(await js('currentResult?.scanMode'), 'mft');
    assert.equal(await js('currentResult?.fileCount > 0 && !scanInProgress'), true);
    assert.equal(await js('document.getElementById("scan-mode").textContent.includes("Fast")'), true);
    const scanMeasurement = await js(`({
      files: currentResult.fileCount, scanMs: currentResult.scanDurationMs,
      requestToViewMs: performance.now() - ${scanReadyStarted}
    })`);
    console.log('PASS: normal-user hidden Electron completed real administrator MFT scan.',
      await js(`JSON.stringify({files:currentResult.fileCount,ms:currentResult.scanDurationMs,
        skipped:currentResult.skippedCount,
        requestToViewMs:performance.now()-${scanReadyStarted}})`));
    const benchmarkTarget = process.env.DISKORYX_SMOKE_MFT_TARGET;
    if (benchmarkTarget) {
      const targetName = path.basename(benchmarkTarget);
      const searchStarted = await js('performance.now()');
      await js(`document.getElementById("search-input").value = ${JSON.stringify(targetName)};
        document.getElementById("search-btn").click()`);
      await waitFor(`treeTitle.textContent.endsWith("search results") &&
        document.querySelector(".result-file-row small")`);
      const searchResult = JSON.parse(await js(`JSON.stringify({
        title: treeTitle.textContent,
        found: Array.from(document.querySelectorAll(".result-file-row small"))
          .some(item => item.textContent === ${JSON.stringify(path.resolve(benchmarkTarget))}),
        searchMs: performance.now() - ${searchStarted}
      })`));
      assert.equal(searchResult.found, true, `Diskoryx search did not find ${benchmarkTarget}`);
      console.log('PASS: Diskoryx in-app search found the exact benchmark target.',
        JSON.stringify(searchResult));
      if (process.env.DISKORYX_SMOKE_BENCHMARK_OUTPUT) {
        const output = process.env.DISKORYX_SMOKE_BENCHMARK_OUTPUT;
        await fs.writeFile(output, JSON.stringify({
          application: 'Diskoryx source smoke harness',
          measuredAt: new Date().toISOString(),
          scope: 'C:\\', query: targetName, target: path.resolve(benchmarkTarget),
          ...scanMeasurement, ...searchResult,
          scanAndLookupMs: scanMeasurement.requestToViewMs + searchResult.searchMs,
          pollingIntervalMs: 25
        }, null, 2) + '\n', { flag: 'wx' });
        window.setSize(1420, 900);
        await new Promise(resolve => setTimeout(resolve, 200));
        const rectangle = await js(`(() => {
          const r = document.querySelector('.tree-pane').getBoundingClientRect();
          return { x: Math.ceil(r.x), y: Math.ceil(r.y),
            width: Math.floor(r.width), height: Math.min(360, Math.floor(r.height)) };
        })()`);
        await fs.writeFile(`${output}.png`, (await window.webContents.capturePage(rectangle)).toPNG());
      }
    }
    if (process.env.DISKORYX_SMOKE_MFT_REPEAT === '1') {
      for (let repeat = 0; repeat < 2; repeat++) {
        const before = await js('currentScanId');
        const started = await js('performance.now()');
        await js('runScan(id => window.electronAPI.refreshTree("C:\\\\", currentScanFilters, id))');
        assert.equal(await js(`currentScanId > ${before} && currentResult?.scanMode === "mft" && !scanInProgress`), true);
        console.log('PASS: repeated real MFT scan reused the same broker without another UAC.',
          await js(`JSON.stringify({files:currentResult.fileCount,ms:currentResult.scanDurationMs,
            requestToViewMs:performance.now()-${started}})`));
      }
    }
    if (process.env.DISKORYX_SMOKE_LIVE_PAUSE === '1') {
      await new Promise(resolve => setTimeout(resolve, 2500));
      await waitFor('currentResult && !fileActionInProgress && !scanInProgress');
      const page = await js('window.electronAPI.getFolderPage(currentScanId, 0, 0, 200, "name", [], currentScanFilters)');
      assert.equal(page.success, true, page.error);
      const folder = page.items.find(item => item.type === 'folder');
      assert.ok(folder, 'drive scan must include browsable folders');
      const child = await js(`window.electronAPI.getFolderPage(currentScanId, ${folder.folderId}, 0, 200, "name", [], currentScanFilters)`);
      assert.equal(child.success, true, child.error);
      console.log('PASS: actual C: MFT snapshot remains browsable with drive-wide live notifications enabled.');
    }
  }
  if (archiveSaveTarget) {
    const liveFiles = await js('currentResult.fileCount');
    const liveFolders = await js('currentResult.folderCount');
    const liveBytes = await js('currentResult.totalSizeBytes');
    await js('document.getElementById("save-scan-btn").click()');
    await waitFor('document.getElementById("save-archive-dialog").open');
    assert.match(await js('document.getElementById("save-archive-note").textContent'), /full paths/);
    assert.match(await js('document.getElementById("save-archive-note").textContent'), /does not send it anywhere/);
    assert.equal(await js('document.activeElement.id'), 'save-archive-cancel');
    assert.notEqual(await js('getComputedStyle(document.getElementById("save-archive-dialog")).backgroundColor'), 'rgba(0, 0, 0, 0)');
    await js('document.getElementById("save-archive-confirm").click()');
    await waitFor('!fileActionInProgress && document.getElementById("message-dialog").open && document.getElementById("message-title").textContent === "Scan saved"');
    assert.match(await js('document.getElementById("message-text").textContent'), /not uploaded/);
    await js('document.getElementById("message-close").click()');
    assert.equal(fsSync.existsSync(archiveSaveTarget), true, 'the saved scan file must exist');
    assert.equal(await js('currentResult.readOnly'), false);
    assert.equal(await js('document.getElementById("archive-badge").hidden'), true);
    console.log('ARCHIVE SUMS', JSON.stringify({ files: liveFiles, folders: liveFolders, bytes: liveBytes }));
  }
  if (archiveSaveTarget && archiveOpenTarget) {
    const liveFiles = await js('currentResult.fileCount');
    const liveBytes = await js('currentResult.totalSizeBytes');
    assert.equal(await js('document.getElementById("open-scan-btn").disabled'), false);
    await js('document.getElementById("open-scan-btn").click()');
    await waitFor('!scanInProgress && currentResult?.readOnly === true');
    assert.equal(await js('currentResult.fileCount'), liveFiles);
    assert.equal(await js('currentResult.totalSizeBytes'), liveBytes);
    assert.equal(await js('document.getElementById("archive-badge").hidden'), false);
    assert.match(await js('document.getElementById("archive-badge").textContent'), /read-only/);
    assert.equal(await js('document.getElementById("scan-mode").textContent'), 'Saved · Read-only');
    assert.equal(await js('document.getElementById("scan-mode").hidden'), false);
    assert.equal(await js('document.getElementById("export-csv-btn").disabled'), false);
    assert.ok(await js('document.querySelectorAll(".virtual-tree-row").length') > 0);
    // Saved scans show the capacity recorded at scan time, never the live value.
    assert.match(await js('document.getElementById("volume-capacity").textContent'), /Recorded/);
    assert.doesNotMatch(await js('document.getElementById("volume-capacity").textContent'), /Whole volume/);
    await js(`showFileContextMenu(virtualTree.root.children.find(item => item.type === 'file'), { preventDefault() {}, clientX: 20, clientY: 20 })`);
    await waitFor('document.getElementById("message-dialog").open');
    assert.equal(await js('document.getElementById("message-title").textContent'), 'Saved scan: read-only');
    assert.match(await js('document.getElementById("message-text").textContent'), /are disabled/);
    await js('document.getElementById("message-close").click()');
    const blockedPreview = await js(`window.electronAPI.readTextPreview(currentScanId, currentResult.folderPath + '\\example.log', 0, null)`);
    assert.match(blockedPreview.error, /saved scan/i);
    assert.equal(await js('document.getElementById("saved-scans-select").selectedOptions[0].textContent.includes("saved scan")'), true);
    assert.equal(scans, 1, 'opening a saved scan must never start a scan');
    await js(`document.querySelector('[data-view="largest"]').click()`);
    await waitFor('!document.getElementById("analysis-panel").hidden && document.querySelectorAll("#analysis-rows tr").length > 0');
    await js(`document.querySelector('[data-view="explorer"]').click()`);
    await js(`runScan(id => window.electronAPI.refreshTree(${JSON.stringify(folderPath)}, currentScanFilters, id))`);
    await waitFor('!scanInProgress && currentResult?.readOnly === false');
    assert.equal(await js('document.getElementById("archive-badge").hidden'), true);
    assert.equal(scans, 2, 'Rescan must perform a real scan');
    console.log('PASS: saved scan saved, reopened read-only with blocked actions and analysis, then rescanned for a live result.');
    if (process.env.DISKORYX_SMOKE_COMPARE === '1') {
      // Compare needs the saved scan open again: the rescan above replaced it with a live result.
      await js('document.getElementById("open-scan-btn").click()');
      await waitFor('!scanInProgress && currentResult?.readOnly === true');
      await fs.writeFile(path.join(folderPath, 'compare-added.txt'), 'added after save');
      const compareStarted = await js('performance.now()');
      await js('document.getElementById("compare-scan-btn").click()');
      await waitFor('document.getElementById("compare-view").hidden === false && document.getElementById("compare-counts").textContent.includes("Added: 1")');
      const compareMs = await js(`performance.now() - ${compareStarted}`);
      console.log('PERF compare click-to-view ms', Math.round(compareMs));
      assert.match(await js('document.getElementById("compare-counts").textContent'), /Added: 1/);
      assert.match(await js('document.getElementById("compare-counts").textContent'), /Removed: 0/);
      assert.equal(await js('currentResult.readOnly'), true, 'Compare must leave the saved scan read-only');
      assert.equal(scans, 3, 'Compare performs one real current-state scan');
      console.log('PERF compare scans-after-click', scans);
      const ordinaryStarted = await js('performance.now()');
      await js(`runScan(id => window.electronAPI.refreshTree(${JSON.stringify(folderPath)}, currentScanFilters, id))`);
      await waitFor('!scanInProgress && currentResult?.readOnly === false');
      const ordinaryMs = await js(`performance.now() - ${ordinaryStarted}`);
      console.log('PERF ordinary scan of same folder ms', Math.round(ordinaryMs), 'files', await js('currentResult.fileCount'));
      console.log('PASS: compare reports Added: 1 after one file was added to the saved location.');
    }
  }
  assert.deepEqual(requests, []);
  assert.deepEqual(rendererErrors, []);
  assert.equal(fsSync.existsSync(mainRequire('./mft-scanner').getMftScannerPath(false)), true);
  console.log('PASS: hidden Electron startup, real preload/IPC, local fonts/D3, scan, rename/history restore/redo without rescan, Copy/Paste and verified Undo/Redo, independent largest/type views and drilldown, paged preview, themed recycle/messages in both themes, OK/Escape, literal errors, cache totals and zero HTTP requests.');
  if (realRecycle) {
    const scansBeforeRecycleRestore = scans;
    await assert.rejects(fs.stat(path.join(folderPath, 'renamed.txt')), { code: 'ENOENT' });
    await js('document.getElementById("history-btn").click()');
    await waitFor('document.querySelector("#history-rows tr button")?.textContent === "Restore from Recycle Bin"');
    const beforeConflict = await js('currentScanId');
    await fs.writeFile(path.join(folderPath, 'renamed.txt'), 'conflicting user fixture');
    await js('document.querySelector("#history-rows tr button").click()');
    await waitFor('!fileActionInProgress && document.getElementById("message-dialog").open');
    assert.equal(await fs.readFile(path.join(folderPath, 'renamed.txt'), 'utf8'), 'conflicting user fixture');
    assert.equal(await js('currentScanId'), beforeConflict, 'definite occupied-path restore refusal retains scan');
    await js('document.getElementById("message-close").click()');
    await fs.unlink(path.join(folderPath, 'renamed.txt'));
    await js('document.querySelector("#history-rows tr button").click()');
    await waitFor('!fileActionInProgress && document.querySelector("#history-rows tr").textContent.includes("Restored from Recycle Bin")');
    assert.equal(await fs.readFile(path.join(folderPath, 'renamed.txt'), 'utf8'), '{"enabled":true}');
    assert.equal(await js('currentResult.fileCount'), 3);
    assert.equal(scans, scansBeforeRecycleRestore, 'restoring a file never starts another full scan');
    await js('document.getElementById("history-close").click()');
    const folderRestore = path.join(folderPath, 'restore-folder');
    await fs.mkdir(path.join(folderRestore, 'nested'), { recursive: true });
    await fs.writeFile(path.join(folderRestore, 'nested', 'child.txt'), 'folder restore fixture');
    await js(`runScan(id => window.electronAPI.refreshTree(${JSON.stringify(folderPath)}, currentScanFilters, id))`);
    await waitFor('!scanInProgress && currentResult?.fileCount === 4');
    await contextAction('restore-folder', 'delete');
    await waitFor('document.getElementById("recycle-dialog").open');
    await js('document.getElementById("recycle-confirm").click()');
    await waitFor('!fileActionInProgress && currentResult?.fileCount === 3');
    await js('document.getElementById("history-btn").click()');
    await waitFor('document.querySelector("#history-rows tr button")?.textContent === "Restore from Recycle Bin"');
    await js('document.querySelector("#history-rows tr button").click()');
    await waitFor('!fileActionInProgress && currentResult?.fileCount === 4');
    assert.equal(await fs.readFile(path.join(folderRestore, 'nested', 'child.txt'), 'utf8'), 'folder restore fixture');
    assert.equal(scans, scansBeforeRecycleRestore + 1, 'file and folder restores never start another full scan');
    await js('document.getElementById("history-close").click()');
    // Recover only this test's earlier Undo-copy fixture before the runner
    // removes its temporary tree; do not leave it in the user's bin.
    await fs.unlink(initialCopyRecord.destination);
    const cleanupRequest = await mainRequire('./recycle-restore').findRecycledEntry({
      source: initialCopyRecord.destination, chain: initialCopyRecord.destinationChain
    });
    cleanupRequest.destinationEntries = initialCopyRecord.destinationChain.slice(0, -1);
    await mainRequire('./windows-rename').restoreWithHandles(cleanupRequest, async () => {
      const metadata = await mainRequire('./recycle-restore').readMetadata(cleanupRequest.metadata);
      assert.equal(metadata.originalPath, initialCopyRecord.destination);
    });
    assert.equal(await fs.readFile(initialCopyRecord.destination, 'utf8'), '{"enabled":true}');
    console.log(`Real Windows recycle and identity-bound restore completed for disposable fixture only: ${path.join(folderPath, 'renamed.txt')}`);
  } else {
    console.log('Recycle API is simulated on disposable fixtures; no real user files or Windows Recycle Bin are modified.');
  }
  if (process.env.DISKORYX_SMOKE_PASTE_UI === '1') {
    const pasteRoot = path.join(temporaryRoot, 'paste-ui');
    await fs.mkdir(path.join(pasteRoot, 'source'), { recursive: true });
    await fs.mkdir(path.join(pasteRoot, 'first'));
    await fs.mkdir(path.join(pasteRoot, 'second'));
    await fs.writeFile(path.join(pasteRoot, 'source', 'child.txt'), 'paste UI fixture');
    await js(`runScan(id => window.electronAPI.scanFolder(${JSON.stringify(pasteRoot)}, currentScanFilters, id))`);
    await waitFor('currentResult?.fileCount === 1 && !scanInProgress && !fileActionInProgress');
    const createFolderFromContext = async (parentName, name) => {
      if (parentName) {
        await contextAction(parentName, 'create-folder');
      } else {
        await js(`showFolderPasteMenu({
          preventDefault() {}, target: { closest() { return null; } }, clientX: 20, clientY: 20
        })`);
        await waitFor('!fileContextMenu.hidden && !document.querySelector(\'[data-file-action="create-folder"]\').hidden');
        await js(`document.querySelector('[data-file-action="create-folder"]').click()`);
      }
      await waitFor('document.getElementById("create-folder-dialog").open');
      if (name === null) await js('document.getElementById("create-folder-cancel").click()');
      else await js(`createFolderName.value = ${JSON.stringify(name)}; createFolderForm.requestSubmit();`);
    };
    await createFolderFromContext(null, 'created-from-explorer');
    await waitFor('!fileActionInProgress && currentResult?.folderCount === 4');
    assert.deepEqual(await fs.readdir(path.join(pasteRoot, 'created-from-explorer')), []);
    await createFolderFromContext('first', 'child-created-from-folder');
    await waitFor('!fileActionInProgress && currentResult?.folderCount === 5');
    assert.deepEqual(await fs.readdir(path.join(pasteRoot, 'first', 'child-created-from-folder')), []);
    await createFolderFromContext(null, null);
    await waitFor('!document.getElementById("create-folder-dialog").open');
    await createFolderFromContext(null, 'NUL.txt');
    await waitFor('document.getElementById("message-dialog").open');
    assert.match(await js('document.getElementById("message-text").textContent'), /valid Windows/);
    await js('document.getElementById("message-close").click()');
    await waitFor('!document.getElementById("message-dialog").open');
    await assert.rejects(fs.stat(path.join(pasteRoot, 'NUL.txt')), { code: 'ENOENT' });
    await contextAction('source', 'copy');
    await waitFor('copiedItemName === "source"');
    const openDestination = async () => {
      await js('document.getElementById("choose-destination").click()');
      await waitFor('document.getElementById("destination-dialog").open && !document.getElementById("destination-confirm").disabled');
    };
    const openDestinationFolder = async name => {
      await js(`Array.from(document.querySelectorAll("#destination-folders button"))
        .find(button => button.textContent === ${JSON.stringify(name)}).click();`);
      await waitFor(`!document.getElementById("destination-confirm").disabled &&
        document.getElementById("destination-path").textContent.endsWith(${JSON.stringify(`\\${name}`)})`);
    };
    await openDestination();
    assert.equal(await js('document.getElementById("destination-confirm").textContent'), 'Copy here');
    assert.equal(await js('document.getElementById("destination-source").textContent'),
      `Copying: ${path.join(pasteRoot, 'source')}`);
    await openDestinationFolder('first');
    await js('document.getElementById("destination-create-folder").click()');
    await waitFor('document.getElementById("create-folder-dialog").open');
    await js(`createFolderName.value = 'created-in-picker'; createFolderForm.requestSubmit();`);
    await waitFor(`!fileActionInProgress && !document.getElementById("destination-confirm").disabled &&
      document.getElementById("destination-path").textContent === ${JSON.stringify(path.join(pasteRoot, 'first', 'created-in-picker'))}`);
    assert.deepEqual(await fs.readdir(path.join(pasteRoot, 'first', 'created-in-picker')), []);
    await js('document.getElementById("destination-up").click()');
    await waitFor(`!document.getElementById("destination-confirm").disabled &&
      document.getElementById("destination-path").textContent === ${JSON.stringify(path.join(pasteRoot, 'first'))}`);
    assert.equal(await js('Array.from(document.querySelectorAll("#destination-folders button")).some(button => button.textContent === "created-in-picker")'), true);
    await js('document.getElementById("destination-cancel").click()');
    assert.deepEqual((await fs.readdir(path.join(pasteRoot, 'first'))).sort(),
      ['child-created-from-folder', 'created-in-picker']);
    assert.equal(await js('copiedItemName'), 'source');
    await openDestination();
    await openDestinationFolder('first');
    if (process.env.DISKORYX_SMOKE_LIVE === '1') {
      const before = await js('currentScanId');
      const liveFolder = path.join(pasteRoot, 'live-picker-added');
      await fs.mkdir(liveFolder);
      await waitFor(`currentScanId > ${before} && !fileActionInProgress &&
        !document.getElementById("destination-confirm").disabled`);
      assert.equal(await js('document.getElementById("destination-path").textContent'), path.join(pasteRoot, 'first'));
      const added = await js('currentScanId');
      await fs.rmdir(liveFolder);
      await waitFor(`currentScanId > ${added} && !fileActionInProgress &&
        !document.getElementById("destination-confirm").disabled`);
    }
    if (process.env.DISKORYX_SMOKE_CAPTURE) {
      window.setSize(1420, 900);
      for (const theme of ['dark', 'light']) {
        await js(`document.body.dataset.theme = ${JSON.stringify(theme)}`);
        await new Promise(resolve => setTimeout(resolve, 150));
        await fs.writeFile(path.join(process.env.DISKORYX_SMOKE_CAPTURE, `destination-${theme}.png`),
          (await window.webContents.capturePage()).toPNG());
      }
      await js('document.body.dataset.theme = "dark"');
    }
    await js('document.getElementById("destination-confirm").click()');
    await waitFor('!fileActionInProgress && !copyDialog.open && currentResult?.fileCount === 2');
    assert.equal(await fs.readFile(path.join(pasteRoot, 'first', 'source', 'child.txt'), 'utf8'), 'paste UI fixture');
    await waitFor('document.getElementById("message-dialog").open');
    await js('document.getElementById("message-close").click()');
    await waitFor('!document.getElementById("message-dialog").open');
    await contextAction('source', 'copy');
    await waitFor('copiedItemName === "source"');
    const navigate = async name => {
      await waitFor(`!fileActionInProgress && !scanInProgress`);
      await js(`diskTreemap.navigateToFolder(virtualTree.root.children.find(item => item.name === ${JSON.stringify(name)}))`);
      await waitFor('!document.querySelector("#treemap-canvas .is-loading") && !fileActionInProgress');
    };
    await navigate('second');
    assert.equal(await js('document.getElementById("paste-btn") === null'), true);
    assert.equal(await js('copiedItemName'), 'source');
    await js(`treemapCanvas.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 700, clientY: 500 }));
      document.querySelector('[data-file-action="paste"]').click();`);
    await waitFor('!fileActionInProgress && !copyDialog.open && currentResult?.fileCount === 3');
    assert.equal(await fs.readFile(path.join(pasteRoot, 'second', 'source', 'child.txt'), 'utf8'), 'paste UI fixture');
    assert.equal(await fs.readFile(path.join(pasteRoot, 'source', 'child.txt'), 'utf8'), 'paste UI fixture');
    await waitFor('document.getElementById("message-dialog").open');
    await js('document.getElementById("message-close").click()');
    await waitFor('!document.getElementById("message-dialog").open');
    await navigate('source');
    await contextAction('source', 'copy');
    await waitFor('copiedItemName === "source"');
    await navigate('second');
    await js(`treemapCanvas.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 700, clientY: 500 }));
      document.querySelector('[data-file-action="paste"]').click();`);
    await waitFor('!fileActionInProgress && document.getElementById("message-dialog").open');
    assert.match(await js('document.getElementById("message-text").textContent'), /exists|overwrite|occupied/i);
    assert.equal(await js('currentResult.fileCount'), 3);
    assert.deepEqual(rendererErrors, []);
    assert.deepEqual(requests, []);
    console.log('PASS: explicit in-app destination folder picker, empty folders, Up, Cancel, Copy here and compatible context Paste; no header Paste, picker or Explorer; originals preserved.');
  }
  if (multiDrive) {
    await js('if (messageDialog.open) document.getElementById("message-close").click()');
    await js('document.getElementById("choose-drives-btn").click()');
    await waitFor('chooseDrivesDialog.open && driveChecklist.querySelectorAll("input").length === 3');
    await js('document.getElementById("select-all-drives").click()');
    assert.equal(await js('driveChecklist.querySelectorAll("input:checked").length'), 3);
    await js('document.getElementById("select-no-drives").click()');
    assert.equal(await js('driveChecklist.querySelectorAll("input:checked").length'), 0);
    await js(`driveChecklist.querySelectorAll("input")[0].checked = true;
      driveChecklist.querySelectorAll("input")[2].checked = true;
      document.getElementById("choose-drives-form").requestSubmit();`);
    assert.equal(await js('document.getElementById("scan-drive-btn").textContent'), 'Scan 2 drives');
    const before = scans;
    await js('document.getElementById("scan-drive-btn").click()');
    await waitFor(`!scanInProgress && currentFolderPath === ${JSON.stringify(fixtureDrives[2].path)}`);
    assert.equal(scans, before + 2);
    assert.equal(await js('currentResult.totalSizeBytes'), 33);
    const saved = await js('window.electronAPI.listSavedScans()');
    assert(saved.scans.some(scan => scan.folderPath === fixtureDrives[0].path));
    assert(!saved.scans.some(scan => scan.folderPath === fixtureDrives[1].path));
    const switchTo = async folder => {
      await waitFor(`!scanInProgress && !fileActionInProgress &&
        Array.from(savedScansSelect.options).some(option => option.value === ${JSON.stringify(folder)})`);
      await js(`savedScansSelect.value = ${JSON.stringify(folder)};
        savedScansSelect.dispatchEvent(new Event("change"));`);
      await waitFor(`!fileActionInProgress && currentFolderPath === ${JSON.stringify(folder)}`);
    };
    await switchTo(fixtureDrives[0].path);
    assert.equal(await js('currentResult.totalSizeBytes'), 11);
    assert.equal(await js('document.getElementById("live-status")'), null);
    await contextAction('disk-0.txt', 'copy');
    await waitFor('copiedItemName === "disk-0.txt"');
    await switchTo(fixtureDrives[2].path);
    await js(`treemapCanvas.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, clientX: 700, clientY: 500
    })); document.querySelector('[data-file-action="paste"]').click();`);
    await waitFor('!fileActionInProgress && !copyDialog.open && currentResult?.fileCount === 2');
    assert.equal(await fs.readFile(path.join(fixtureDrives[2].path, 'disk-0.txt'), 'utf8'), 'x'.repeat(11));
    await switchTo(fixtureDrives[0].path);
    assert.equal(await js('currentResult.fileCount'), 1);
    assert.equal(await js('currentResult.totalSizeBytes'), 11);
    assert.equal(scans, before + 2, 'switching and cross-snapshot Copy must never rescan');
    await js('document.getElementById("refresh-btn").click()');
    await waitFor('!scanInProgress && currentResult?.fileCount === 1');
    assert.equal(scans, before + 3);
    await switchTo(fixtureDrives[2].path);
    assert.equal(await js('currentResult.fileCount'), 2, 'other snapshot must survive Rescan');
    const beforeAll = scans;
    await js('document.getElementById("choose-drives-btn").click()');
    await waitFor('chooseDrivesDialog.open');
    await js(`document.getElementById("select-all-drives").click();
      document.getElementById("choose-drives-form").requestSubmit();
      document.getElementById("scan-drive-btn").click();`);
    await waitFor(`!scanInProgress && currentFolderPath === ${JSON.stringify(fixtureDrives[2].path)}`);
    assert.equal(scans, beforeAll + 3, 'Select all must scan every selected fixture once');
    assert((await js('window.electronAPI.listSavedScans()')).scans.some(scan => scan.folderPath === fixtureDrives[1].path));
    const openLocation = async location => {
      await js(`savedScansSelect.value = ${JSON.stringify(location)};
        savedScansSelect.dispatchEvent(new Event("change"));`);
      await waitFor(`!fileActionInProgress && currentFolderPath === ${JSON.stringify(location)}`);
    };
    await openLocation(fixtureDrives[0].path);
    await contextAction('disk-0.txt', 'move');
    await waitFor('copiedItemName === "disk-0.txt" && transferMode === "move"');
    assert.match(await js('document.getElementById("transfer-selection").textContent'), /Move: disk-0.txt/);
    assert.equal(await js('document.getElementById("paste-btn") === null'), true);
    await js('document.getElementById("choose-destination").click()');
    await waitFor('document.getElementById("destination-dialog").open && !document.getElementById("destination-confirm").disabled');
    assert.equal(await js('document.getElementById("destination-confirm").textContent'), 'Move here');
    await js(`document.getElementById("destination-location").value = ${JSON.stringify(fixtureDrives[1].path)};
      document.getElementById("destination-location").dispatchEvent(new Event("change"));`);
    await waitFor(`!fileActionInProgress && !document.getElementById("destination-confirm").disabled &&
      document.getElementById("destination-path").textContent === ${JSON.stringify(fixtureDrives[1].path)}`);
    assert.equal(await fs.readFile(path.join(fixtureDrives[0].path, 'disk-0.txt'), 'utf8'), 'x'.repeat(11));
    await js('document.getElementById("destination-confirm").click()');
    await waitFor('!fileActionInProgress && copiedItemName === null && currentResult.fileCount === 2');
    await assert.rejects(fs.stat(path.join(fixtureDrives[0].path, 'disk-0.txt')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(fixtureDrives[1].path, 'disk-0.txt'), 'utf8'), 'x'.repeat(11));
    await js('document.getElementById("history-btn").click()');
    await waitFor('document.querySelector("#history-rows tr button")?.textContent === "Return to original location"');
    await js('document.querySelector("#history-rows tr button").click()');
    await waitFor('!fileActionInProgress && document.querySelector("#history-rows tr button")?.textContent === "Redo move"');
    assert.equal(await fs.readFile(path.join(fixtureDrives[0].path, 'disk-0.txt'), 'utf8'), 'x'.repeat(11));
    await js('document.querySelector("#history-rows tr button").click()');
    await waitFor('!fileActionInProgress && document.querySelector("#history-rows tr button")?.textContent === "Return to original location"');
    await js('document.getElementById("history-close").click()');
    assert.equal(await fs.readFile(path.join(fixtureDrives[1].path, 'disk-0.txt'), 'utf8'), 'x'.repeat(11));
    await contextAction('disk-0.txt', 'copy');
    await waitFor('copiedItemName === "disk-0.txt" && transferMode === "copy"');
    await js('document.getElementById("clear-transfer").click()');
    await waitFor('copiedItemName === null');
    assert.match((await js('window.electronAPI.pasteItem(currentScanId, 0)')).error, /Use Copy/);
    assert.equal(await js('document.getElementById("transfer-selection").hidden'), true);
    if (process.env.DISKORYX_SMOKE_CAPTURE) {
      window.setSize(1420, 900);
      for (const theme of ['dark', 'light']) {
        await js(`document.body.dataset.theme = ${JSON.stringify(theme)};
          document.querySelector(".sidebar").scrollTop = 0;`);
        await window.webContents.capturePage();
        await new Promise(resolve => setTimeout(resolve, 250));
        assert.equal(await js('document.querySelector(".sidebar-bottom").getBoundingClientRect().bottom <= innerHeight'), true);
        const image = await window.webContents.capturePage();
        await fs.writeFile(path.join(process.env.DISKORYX_SMOKE_CAPTURE, `multi-drive-${theme}.png`), image.toPNG());
      }
      await js('document.body.dataset.theme = "dark"');
    }
    assert.deepEqual(rendererErrors, []);
    assert.deepEqual(requests, []);
    console.log('PASS: multi-drive selection/all/clear, sequential real fixture scans, independent cached switching, revision-bound Paste and single-location Rescan.');
    console.log('PASS: context Move, explicit destination picker switching saved roots, Move here, source removal, History return/redo and Cancel selection; no Windows picker, header Paste or extra scan.');
  }
  if (process.env.DISKORYX_SMOKE_CAPTURE_PRODUCT === '1') {
    const screenshotDirectory = process.env.DISKORYX_SMOKE_PRODUCT_CAPTURE_DIR;
    if (!screenshotDirectory) throw new Error('Product screenshot output directory is not configured.');
    await fs.mkdir(screenshotDirectory, { recursive: true });
    const demoRoot = path.join(temporaryRoot, 'product-demo');
    const samples = [
      ['Diskoryx overview.txt', 'Generated sample file for the Diskoryx product gallery.\n'.repeat(36)],
      ['Disk report.csv', 'volume,files,category\nC,11,example\n'.repeat(52)],
      ['Storage guide.md', '# Storage guide\n\nA generated sample document for screenshots.\n'.repeat(27)],
      ['Documents/Getting started.md', '# Getting started\n\nExplore storage locally with Diskoryx.\n'.repeat(24)],
      ['Documents/Release checklist.txt', 'Release checklist: validate, measure, document.\n'.repeat(42)],
      ['Documents/Storage notes.txt', 'Sample notes about files, folders, and storage.\n'.repeat(58)],
      ['Projects/diskoryx.config.json', JSON.stringify({ product: 'Diskoryx', offline: true, sample: true }, null, 2)],
      ['Projects/scan-summary.csv', 'type,count,bytes\ntext,12,42800\nimages,4,125000\n'.repeat(32)],
      ['Projects/scan-worker.js', 'function summarize(entries) { return entries.length; }\n'.repeat(95)],
      ['Projects/theme.css', '.panel { border-radius: 12px; color: #b3a5ff; }\n'.repeat(86)],
      ['Logs/scan-2026-01.log', 'INFO scan complete; files indexed locally\n'.repeat(120)],
      ['Logs/scan-2026-02.log', 'INFO scan complete; no data uploaded\n'.repeat(175)],
      ['Creative/brand-guide.svg', '<svg xmlns="http://www.w3.org/2000/svg"><title>Diskoryx sample</title></svg>\n'.repeat(72)],
      ['Creative/layout-notes.md', 'A visual map of storage, sorted by file size.\n'.repeat(92)]
    ];
    for (const [relative, contents] of samples) {
      const file = path.join(demoRoot, relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, contents);
    }
    if (await js('!document.getElementById("clear-transfer").hidden')) {
      await js('document.getElementById("clear-transfer").click()');
      await waitFor('document.getElementById("clear-transfer").hidden');
    }
    await js(`runScan(id => window.electronAPI.scanFolder(${JSON.stringify(demoRoot)}, currentScanFilters, id))`);
    await waitFor(`currentResult?.fileCount === ${samples.length} && !scanInProgress`);
    window.setSize(1420, 900);
    await waitFor(`Array.from(document.querySelectorAll('.virtual-tree-row.is-file'))
      .some(row => row.textContent.includes('Diskoryx overview.txt'))`);
    await new Promise(resolve => setTimeout(resolve, 200));
    await js(`Array.from(document.querySelectorAll('.virtual-tree-row.is-file'))
      .find(row => row.textContent.includes('Diskoryx overview.txt')).click()`);
    await waitFor(`document.querySelector('.file-details-content')?.textContent.includes('Diskoryx overview.txt')`);
    const prepareScreenshot = async () => js(`(() => {
      const root = ${JSON.stringify(temporaryRoot)};
      const replacement = 'C:\\\\Users\\\\Public\\\\Documents\\\\Diskoryx sample data';
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) walker.currentNode.textContent = walker.currentNode.textContent.split(root).join(replacement);
      diskTreemap.rootPath = replacement + '\\\\product-demo';
      if (diskTreemap.frames[0]) {
        diskTreemap.frames[0].name = diskTreemap.rootPath;
        diskTreemap.frames[0].path = diskTreemap.rootPath;
      }
      diskTreemap.renderBreadcrumb();
      document.getElementById('metric-duration').textContent = '—';
      document.getElementById('metric-rate').textContent = 'Demo only; not benchmarked';
      document.getElementById('files-loaded').textContent = 'Sample data · benchmark results not shown';
      document.getElementById('volume-capacity').hidden = true;
      document.getElementById('action-toast').hidden = true;
      document.querySelector('.sidebar').scrollTop = 0;
      return JSON.stringify({
        duration: document.getElementById('metric-duration').textContent,
        rate: document.getElementById('metric-rate').textContent,
        path: document.getElementById('location-label').textContent,
        containsTemporaryPath: document.body.innerText.includes(root),
        capacityHidden: document.getElementById('volume-capacity').hidden,
        toastHidden: document.getElementById('action-toast').hidden
      });
    })()`);
    await new Promise(resolve => setTimeout(resolve, 300));
    for (const theme of ['light', 'dark']) {
      await js(`if (document.body.dataset.theme !== ${JSON.stringify(theme)})
        document.getElementById('theme-toggle').click();
        document.activeElement.blur();`);
      await new Promise(resolve => setTimeout(resolve, 120));
      const state = JSON.parse(await prepareScreenshot());
      if (state.duration !== '—' || state.rate !== 'Demo only; not benchmarked' ||
          state.containsTemporaryPath || !state.capacityHidden || !state.toastHidden) {
        throw new Error(`Unsafe or misleading screenshot state: ${JSON.stringify(state)}`);
      }
      await new Promise(resolve => setTimeout(resolve, 150));
      await window.webContents.capturePage();
      await new Promise(resolve => setTimeout(resolve, 200));
      await fs.writeFile(path.join(screenshotDirectory, `overview-${theme}.png`),
        (await window.webContents.capturePage()).toPNG());
    }
    await js(`document.querySelector('[data-view="largest"]').click(); document.activeElement.blur();`);
    await waitFor('!document.getElementById("analysis-panel").hidden && document.querySelectorAll("#analysis-rows tr").length > 0');
    const largestState = JSON.parse(await prepareScreenshot());
    if (largestState.containsTemporaryPath) throw new Error('Screenshot contains a temporary user path.');
    await new Promise(resolve => setTimeout(resolve, 200));
    await fs.writeFile(path.join(screenshotDirectory, 'largest-files-dark.png'),
      (await window.webContents.capturePage()).toPNG());
    await js(`document.querySelector('[data-view="types"]').click(); document.activeElement.blur();`);
    await waitFor('!document.getElementById("analysis-panel").hidden && document.getElementById("analysis-title").textContent === "File types"');
    const typesState = JSON.parse(await prepareScreenshot());
    if (typesState.containsTemporaryPath) throw new Error('Screenshot contains a temporary user path.');
    await new Promise(resolve => setTimeout(resolve, 200));
    await fs.writeFile(path.join(screenshotDirectory, 'file-types-dark.png'),
      (await window.webContents.capturePage()).toPNG());
    console.log(`PASS: captured four Diskoryx product screenshots in ${screenshotDirectory}.`);
  }
}

async function runArchiveReopen(js) {
  // A second Electron process opens the archive written by the first one, so
  // reopening is verified after a real application restart.
  const expected = JSON.parse(process.env.DISKORYX_SMOKE_ARCHIVE_EXPECT || 'null');
  assert.equal(await js('document.getElementById("archive-badge").hidden'), true);
  const state = JSON.parse(await js(`(async () => {
    document.getElementById('open-scan-btn').click();
    for (let attempt = 0; attempt < 400; attempt++) {
      if (!scanInProgress && currentResult?.readOnly
        && document.querySelectorAll('.virtual-tree-row').length > 0) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return JSON.stringify({
      readOnly: currentResult?.readOnly === true,
      files: currentResult?.fileCount, folders: currentResult?.folderCount,
      bytes: currentResult?.totalSizeBytes, savedAt: currentResult?.archive?.savedAt,
      badge: document.getElementById('archive-badge').textContent,
      badgeHidden: document.getElementById('archive-badge').hidden,
      scanMode: document.getElementById('scan-mode').textContent,
      scanModeHidden: document.getElementById('scan-mode').hidden,
      rows: document.querySelectorAll('.virtual-tree-row').length,
      metrics: document.getElementById('metric-files').textContent,
      scanInProgress
    });
  })()`));
  assert.equal(state.readOnly, true, 'the saved scan must open read-only');
  assert.equal(state.scanInProgress, false);
  assert.equal(state.badgeHidden, false);
  assert.match(state.badge, /read-only/);
  assert.equal(state.scanModeHidden, false);
  assert.equal(state.scanMode, 'Saved · Read-only');
  assert.match(state.savedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(state.rows > 0, 'the reopened tree must render rows');
  if (expected) {
    assert.equal(state.files, expected.files);
    assert.equal(state.folders, expected.folders);
    assert.equal(state.bytes, expected.bytes);
    assert.equal(state.metrics, expected.files.toLocaleString());
  }
  const blocked = await js(`window.electronAPI.renameFile(currentResult.folderPath + '\\example.log', 'renamed.txt', currentScanId)`);
  assert.match(blocked.error, /saved scan/i);
  const preview = await js(`window.electronAPI.readTextPreview(currentScanId, currentResult.folderPath + '\\example.log', 0, null)`);
  assert.match(preview.error, /saved scan/i);
  await js(`showFileContextMenu({ type: 'file', name: 'example.log', path: currentResult.folderPath + '\\example.log', size: '1 KB' }, { preventDefault() {}, clientX: 20, clientY: 20 })`);
  assert.equal(await js('document.getElementById("message-dialog").open'), true);
  assert.equal(await js('document.getElementById("message-title").textContent'), 'Saved scan: read-only');
  assert.match(await js('document.getElementById("message-text").textContent'), /are disabled/);
  assert.deepEqual(requests, []);
  assert.deepEqual(rendererErrors, []);
  console.log('PASS: saved scan reopened in a fresh Electron process, read-only, no scan, no live actions and no HTTP.');
}

run().then(() => finish(0), error => {
  console.error(error);
  finish(1);
});

function finish(code) {
  electron.app.removeAllListeners('window-all-closed');
  if (window && !window.isDestroyed()) window.destroy();
  electron.app.exit(code);
}
