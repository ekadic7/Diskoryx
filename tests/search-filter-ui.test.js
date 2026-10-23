const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const rendererRoot = path.join(__dirname, '..', 'src', 'renderer');

function node(extra = {}) {
  const listeners = new Map();
  return {
    value: '', textContent: '', hidden: false, className: '', children: [], title: '',
    attributes: {}, type: '', dataset: {},
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    fire(type, event = {}) {
      for (const fn of listeners.get(type) || []) fn({ preventDefault() {}, ...event });
    },
    setAttribute(key, value) { this.attributes[key] = value; },
    append(...children) { this.children.push(...children); },
    replaceChildren() { this.children = []; },
    focus() {}, showModal() { this.open = true; }, close() { this.open = false; },
    reset() { this.value = ''; },
    ...extra
  };
}

function loadUI() {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, node());
    return nodes.get(id);
  };
  const document = {
    getElementById: get,
    createElement: () => node(),
  };
  const context = { document, window: {} };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(rendererRoot, 'search-filters.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(path.join(rendererRoot, 'search-filter-ui.js'), 'utf8'), context);
  const sizeValue = get('size-value');
  get('size-operator').value = '>';
  get('size-unit').value = 'MB';
  return { get, sizeValue };
}

function chipLabels(get) {
  return get('search-filter-chips').children.map(chip => chip.children[0].textContent);
}

test('applying a size filter appends it to typed text and shows a chip', () => {
  const { get, sizeValue } = loadUI();
  get('search-input').value = 'report';
  get('search-input').fire('input');
  get('search-filter-btn').fire('click');
  sizeValue.value = '10';
  sizeValue.fire('input');
  assert.equal(get('search-filter-preview').textContent, 'report size:>10MB');
  assert.equal(get('search-filter-error').hidden, true);
  get('search-filter-form').fire('submit');
  assert.equal(get('search-input').value, 'report size:>10MB');
  assert.deepEqual(chipLabels(get), ['Size > 10MB']);
  assert.equal(get('search-filter-chips').hidden, false);
});

test('a date filter is added with the parser syntax and listed as a chip', () => {
  const { get } = loadUI();
  get('search-input').value = 'photo OR notes';
  get('search-filter-btn').fire('click');
  get('modified-operator').value = '>=';
  get('modified-value').value = '2025-01-01';
  get('modified-value').fire('change');
  get('search-filter-form').fire('submit');
  assert.equal(get('search-input').value, 'photo OR notes modified:>=2025-01-01');
  assert.deepEqual(chipLabels(get), ['Modified >= 2025-01-01']);
});

test('size and date filled together are both added with one Add filter click', () => {
  const { get, sizeValue } = loadUI();
  get('search-input').value = 'report';
  get('search-filter-btn').fire('click');
  sizeValue.value = '2';
  sizeValue.fire('input');
  get('modified-operator').value = '<';
  get('modified-value').value = '2026-10-22';
  get('modified-value').fire('change');
  assert.equal(get('search-filter-error').hidden, true);
  assert.equal(get('search-filter-preview').textContent, 'report size:>2MB modified:<2026-10-22');
  get('search-filter-form').fire('submit');
  assert.equal(get('search-input').value, 'report size:>2MB modified:<2026-10-22');
  assert.deepEqual(chipLabels(get), ['Size > 2MB', 'Modified < 2026-10-22']);
});

test('invalid input shows an error and does not change the search text', () => {
  const { get, sizeValue } = loadUI();
  get('search-input').value = 'report';
  get('search-filter-btn').fire('click');
  sizeValue.value = 'big';
  sizeValue.fire('input');
  assert.equal(get('search-filter-error').hidden, false);
  get('search-filter-form').fire('submit');
  assert.equal(get('search-input').value, 'report');
});

test('removing one chip removes only that condition and keeps the other text', () => {
  const { get } = loadUI();
  get('search-input').value = 'report NOT size:>10MB modified:>=2025-01-01';
  get('search-input').fire('input');
  assert.deepEqual(chipLabels(get), ['Size > 10MB', 'Modified >= 2025-01-01']);
  get('search-filter-chips').children[0].children[1].fire('click');
  assert.equal(get('search-input').value, 'report modified:>=2025-01-01');
  assert.deepEqual(chipLabels(get), ['Modified >= 2025-01-01']);
});

test('old queries without filters show no chips and keep the text as typed', () => {
  const { get } = loadUI();
  get('search-input').value = 'report size:>big';
  get('search-input').fire('input');
  assert.deepEqual(chipLabels(get), []);
  assert.equal(get('search-filter-chips').hidden, true);
  assert.equal(get('search-input').value, 'report size:>big');
});
