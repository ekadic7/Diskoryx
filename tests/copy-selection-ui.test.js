const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function element() {
  const listeners = new Map();
  const classes = new Set();
  return {
    value: '', textContent: '', disabled: false, hidden: true, children: [], style: {}, title: '',
    addEventListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
    },
    async fire(name, event = {}) {
      for (const fn of listeners.get(name) || []) await fn({ target: this, preventDefault() {}, ...event });
    },
    click() { return this.disabled ? Promise.resolve() : this.fire('click'); },
    remove() {}, close() { this.open = false; }, showModal() { this.open = true; }, focus() {}, select() {},
    querySelector() { return element(); },
    querySelectorAll() { return []; },
    append() {}, replaceChildren() {}, setAttribute() {},
    classList: {
      add(name) { classes.add(name); },
      contains(name) { return classes.has(name); },
      toggle(name, force) { if (force) classes.add(name); else classes.delete(name); }
    }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

// Loads the real copy.js and the message-dialog part of app.js into one VM context.
function loadRenderer(api) {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const timers = [];
  const document = Object.assign(element(), {
    getElementById: get, querySelector: get, createElement: element, dispatchEvent() {}
  });
  get('copy-dialog').open = false;
  get('message-dialog').open = false;
  const context = vm.createContext({
    document, Event: class {}, CustomEvent: class {},
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: id => { const t = timers[id - 1]; if (t) t.cancelled = true; },
    fileContextMenu: element(), fileActionInProgress: false, scanInProgress: false,
    currentScanId: 1, invalidateFileActionView() {}, refreshAfterFileAction: async () => {},
    setFileActionBusy() {}, showActionToast() {},
    window: { electronAPI: { onCopyProgress() {}, ...api } },
    messageDialog: get('message-dialog'), actionToast: element(), treeContainer: element(), treemapCanvas: element()
  });
  vm.runInContext('let messageDialog = document.getElementById("message-dialog");', context);
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  const copy = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'copy.js'), 'utf8');
  // Only the dialog section of app.js is needed; it uses the shared messageDialog element.
  const dialogStart = app.indexOf('let messageToken');
  const dialogEnd = app.indexOf('function showActionToast');
  vm.runInContext(app.slice(dialogStart, dialogEnd), context);
  vm.runInContext(copy, context);
  return { context, get, timers, run: code => vm.runInContext(code, context) };
}

test('a late successful response for an older selection does not clear a newer selection', async () => {
  const first = deferred();
  let call = 0;
  const api = {
    copyItem: async () => ({ success: true, name: `item${++call}` }),
    pasteItem: () => first.promise
  };
  const ui = loadRenderer(api);
  ui.run('copiedItemName = "A"; copiedItemPath = "A"; copySelectionToken = 1;');
  const pending = ui.run('pasteIntoFolder(0, 1)');
  // Selection B is copied while the paste for A is still running.
  ui.run('++copySelectionToken; copiedItemName = "B";');
  first.resolve({ success: true, actionLabel: 'Copied A' });
  await pending;
  assert.equal(ui.run('copiedItemName'), 'B', 'newer selection B must survive the late response for A');
});

test('a successful Paste for the current selection clears it', async () => {
  const ui = loadRenderer({ pasteItem: async () => ({ success: true, actionLabel: 'Copied' }) });
  ui.run('copiedItemName = "A"; copiedItemPath = "A"; copySelectionToken = 1;');
  await ui.run('pasteIntoFolder(0, 1)');
  assert.equal(ui.run('copiedItemName'), null);
});

test('success dialog closes on its own timer only while its own message is still current', () => {
  const ui = loadRenderer({});
  ui.run('showSuccessDialog("Same text", "Copied successfully")');
  assert.equal(ui.get('message-dialog').open, true);
  const timer = ui.timers[ui.timers.length - 1];
  assert.equal(timer.ms, 10000);
  // A later error with identical text must not be closed by the first dialog's timer.
  ui.run('showAppMessage("Same text", "Transfer not completed")');
  timer.fn();
  assert.equal(ui.get('message-dialog').open, true, 'timer of an earlier success must not close a later message');
});

test('closing the success dialog manually cancels its timer', () => {
  const ui = loadRenderer({});
  ui.run('showSuccessDialog("Done text", "Copied successfully")');
  const timer = ui.timers[ui.timers.length - 1];
  ui.get('message-dialog').close();
  ui.get('message-dialog').fire('close');
  assert.equal(timer.cancelled, true);
  ui.run('showAppMessage("Done text", "Transfer not completed")');
  ui.get('message-dialog').open = true;
  timer.fn();
  assert.equal(ui.get('message-dialog').open, true, 'a cancelled timer must not close a later message');
});
