const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function node() {
  const listeners = new Map();
  const classes = new Set();
  return {
    textContent: '', value: '', open: false, children: [], disabled: false,
    attributes: {}, checked: true,
    classList: {
      add(name) { classes.add(name); }, remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
      toggle(name, force) {
        const enabled = force === undefined ? !classes.has(name) : force;
        if (enabled) classes.add(name); else classes.delete(name);
        return enabled;
      }
    },
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(callback);
    },
    async fire(type, event = {}) {
      for (const callback of listeners.get(type) || []) await callback({ target: this, preventDefault() {}, ...event });
    },
    click() { return this.disabled ? Promise.resolve() : this.fire('click'); },
    setAttribute(name, value) { this.attributes[name] = value; },
    prepend(child) { this.children.unshift(child); },
    showModal() { this.open = true; },
    close() { this.open = false; void this.fire('close'); },
    reportValidity() { return true; },
    remove() { this.removed = true; }
  };
}

function loadUI(read) {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, node());
    return elements.get(id);
  };
  const document = node();
  document.getElementById = get;
  document.createElement = node;
  document.querySelector = selector => {
    if (selector === '.file-details-content') return get('inspector');
    if (selector === '#preview-page-form button') return get('go');
    if (selector === '.open-text-preview') return get('inspector').children[0];
    throw new Error(`Unexpected selector: ${selector}`);
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'text-preview-ui.js'), 'utf8'), {
    document, window: { electronAPI: { readTextPreview: read } }
  });
  return { document, get };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const response = page => ({
  success: true, text: `page ${page}`, page, pageCount: 4,
  fileSize: 250000, startByte: page * 65536, endByte: Math.min((page + 1) * 65536, 250000),
  encoding: 'utf-8', revision: 'original'
});

async function open(ui, file = { name: 'example.log', path: 'C:\\test\\example.log' }) {
  ui.get('inspector').children = [];
  await ui.document.fire('diskoryx:selection', { detail: { file, scanId: 4 } });
  await ui.get('inspector').children[0].click();
  await tick();
}

test('preview UI navigates the complete file, jumps pages, wraps and reloads', async () => {
  const calls = [];
  const ui = loadUI(async (...args) => { calls.push(args); return response(args[2]); });
  await open(ui);
  assert.equal(ui.get('text-preview-dialog').open, true);
  assert.equal(ui.get('preview-content').textContent, 'page 0');
  assert.equal(ui.get('preview-first').disabled, true);
  await ui.get('preview-next').click();
  assert.equal(ui.get('preview-content').textContent, 'page 1');
  assert.equal(calls.at(-1)[3], 'original');
  await ui.get('preview-last').click();
  assert.equal(ui.get('preview-content').textContent, 'page 3');
  assert.equal(ui.get('preview-next').disabled, true);
  await ui.get('preview-previous').click();
  assert.equal(ui.get('preview-page-number').value, '3');
  await ui.get('preview-first').click();
  assert.equal(ui.get('preview-page-number').value, '1');
  ui.get('preview-page-number').value = '3';
  await ui.get('preview-page-form').fire('submit');
  await tick();
  assert.equal(ui.get('preview-content').textContent, 'page 2');
  ui.get('preview-word-wrap').checked = false;
  await ui.get('preview-word-wrap').fire('change');
  assert.equal(ui.get('preview-content').classList.contains('no-wrap'), true);
  await ui.get('preview-reload').click();
  assert.equal(calls.at(-1)[2], 0);
  assert.equal(calls.at(-1)[3], null);
});

test('changed file errors clear stale content, disable paging and allow an explicit reload', async () => {
  let changed = false;
  const ui = loadUI(async (_scanId, _file, page, revision) =>
    changed && revision ? { error: 'File changed. Reload it.' } : response(page));
  await open(ui);
  changed = true;
  await ui.get('preview-next').click();
  assert.equal(ui.get('preview-content').textContent, '');
  assert.match(ui.get('preview-status').textContent, /changed/);
  assert.equal(ui.get('preview-status').classList.contains('is-error'), true);
  assert.equal(ui.get('preview-next').disabled, true);
  assert.equal(ui.get('preview-reload').disabled, false);
  await ui.get('preview-reload').click();
  assert.equal(ui.get('preview-status').classList.contains('is-error'), false);
  assert.equal(ui.get('preview-content').textContent, 'page 0');
});

test('closing or starting another scan discards late async preview results', async () => {
  let resolveRead;
  const ui = loadUI(() => new Promise(resolve => { resolveRead = resolve; }));
  await open(ui);
  assert.equal(ui.get('preview-content').attributes['aria-busy'], 'true');
  ui.get('text-preview-dialog').close();
  resolveRead(response(0));
  await tick();
  assert.equal(ui.get('preview-content').textContent, '');
  await open(ui);
  await ui.document.fire('diskoryx:scan-start');
  resolveRead(response(0));
  await tick();
  assert.equal(ui.get('text-preview-dialog').open, false);
  assert.equal(ui.get('preview-content').textContent, '');
});

test('a local file mutation closes preview and discards results from the old snapshot', async () => {
  let resolveRead;
  const ui = loadUI(() => new Promise(resolve => { resolveRead = resolve; }));
  await open(ui);
  await ui.document.fire('diskoryx:files-changed');
  resolveRead(response(0));
  await tick();
  assert.equal(ui.get('text-preview-dialog').open, false);
  assert.equal(ui.get('preview-content').textContent, '');
  assert.equal(ui.get('inspector').children[0].removed, true);
});

test('preview UI treats content as literal text and handles empty files and IPC failures', async () => {
  const literal = '<img src=x onerror=alert(1)>';
  let mode = 'literal';
  const ui = loadUI(async () => {
    if (mode === 'error') throw new Error('IPC disconnected');
    if (mode === 'empty') return { ...response(0), text: '', fileSize: 0, pageCount: 1 };
    return { ...response(0), text: literal, pageCount: 1 };
  });
  await open(ui);
  assert.equal(ui.get('preview-content').textContent, literal);
  assert.equal(ui.get('preview-content').children.length, 0);
  ui.get('text-preview-dialog').close();
  mode = 'empty';
  await open(ui);
  assert.equal(ui.get('preview-status').textContent, 'This file is empty.');
  ui.get('text-preview-dialog').close();
  mode = 'error';
  await open(ui);
  assert.match(ui.get('preview-status').textContent, /IPC disconnected/);
  assert.equal(ui.get('preview-next').disabled, true);
});
