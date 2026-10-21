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
if (!temporaryRoot) throw new Error('Run with npm run test:smoke, not directly.');
electron.app.setPath('sessionData', temporaryRoot);
const mainRoot = path.join(__dirname, '..', 'src', 'main');
const mainRequire = createRequire(path.join(mainRoot, 'main.js'));
let window;
let scans = 0;
let recycleCount = 0;
let initialCopyRecord;
const rendererErrors = [];
const requests = [];
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
  await fs.mkdir(path.join(temporaryRoot, 'settings'));
  await fs.mkdir(path.join(temporaryRoot, 'scan'));
  await fs.mkdir(path.join(temporaryRoot, 'scan', 'copy-destination'));
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
    __dirname: mainRoot, process, console, setImmediate, AbortController,
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
          showOpenDialog: async () => { throw new Error('Copy/Paste must stay inside Diskoryx'); }
        },
        shell: {
          ...electron.shell,
          // Exercise UI/backend completion without touching the real Windows Recycle Bin.
          trashItem: target => realRecycle
            ? electron.shell.trashItem(target)
            : fs.rename(target, path.join(temporaryRoot, `recycled-${++recycleCount}.txt`))
        }
      };
      if (name === './scanner') return {
        ...mainRequire(name),
        scanFolder(...args) { scans++; return mainRequire(name).scanFolder(...args); }
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
  await js('document.fonts.ready');
  assert.equal(await js('document.fonts.check(\'900 14px "Font Awesome 6 Free"\')'), true);
  const folderPath = path.join(temporaryRoot, 'scan');
  await js(`runScan(id => window.electronAPI.scanFolder(${JSON.stringify(folderPath)}, currentScanFilters, id))`);
  await waitFor('currentResult?.fileCount === 2 && !scanInProgress');
  await waitFor('!document.getElementById("disk-capacity-card").hidden && document.getElementById("capacity-free").textContent !== "Checking..."');
  assert.notEqual(await js('document.getElementById("capacity-free").textContent'), 'Unavailable');
  assert.match(await js('document.getElementById("capacity-total").textContent'), /free of .* total/);
  assert.equal(await js('document.getElementById("capacity-volume").textContent'), path.parse(folderPath).root.replace(/[\\/]+$/, ''));
  const duration = await js('currentResult.scanDurationMs');
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
  assert.equal(await js('messageDialog.open'), false,
    await js('document.getElementById("message-text").textContent'));
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
    initialCopyRecord = JSON.parse(await fs.readFile(path.join(temporaryRoot, 'settings', 'action-history.json'), 'utf8'))
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
    console.log('PASS: normal-user hidden Electron completed real administrator MFT scan.',
      await js(`JSON.stringify({files:currentResult.fileCount,ms:currentResult.scanDurationMs,
        requestToViewMs:performance.now()-${scanReadyStarted}})`));
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
  assert.deepEqual(requests, []);
  assert.deepEqual(rendererErrors, []);
  assert.equal(fsSync.existsSync(mainRequire('./mft-scanner').getMftScannerPath(false)), true);
  console.log('PASS: hidden Electron startup, real preload/IPC, local fonts/D3, scan, rename/history restore/redo without rescan, Copy/Paste and verified Undo/Redo, independent largest/type views and drilldown, paged preview, themed recycle/messages in both themes, OK/Escape, literal errors, cache totals and zero HTTP requests.');
  if (realRecycle) {
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
    assert.equal(scans, 1);
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
    assert.equal(scans, 2, 'file and folder restores never start another full scan');
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
    const navigate = async name => {
      await waitFor(`!fileActionInProgress && !scanInProgress`);
      await js(`diskTreemap.navigateToFolder(virtualTree.root.children.find(item => item.name === ${JSON.stringify(name)}))`);
      await waitFor('!document.querySelector("#treemap-canvas .is-loading") && !fileActionInProgress');
    };
    await navigate('second');
    assert.equal(await js('document.getElementById("paste-btn") === null'), true);
    await js(`treemapCanvas.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 700, clientY: 500 }));
      document.querySelector('[data-file-action="paste"]').click();`);
    await waitFor('!fileActionInProgress && !copyDialog.open && currentResult?.fileCount === 3');
    assert.equal(await fs.readFile(path.join(pasteRoot, 'second', 'source', 'child.txt'), 'utf8'), 'paste UI fixture');
    assert.equal(await fs.readFile(path.join(pasteRoot, 'source', 'child.txt'), 'utf8'), 'paste UI fixture');
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
