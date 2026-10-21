const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(reply = async () => ({ success: true }), deferredClose = false) {
  const elements = new Map();
  const closeEvents = [];
  const get = id => {
    if (!elements.has(id)) {
      const listeners = new Map();
      elements.set(id, {
        textContent: '', hidden: false, disabled: false, open: false,
        addEventListener: (type, fn) => listeners.set(type, fn),
        fire: (type, event) => listeners.get(type)?.(event),
        showModal() { this.open = true; },
        close() {
          this.open = false;
          if (deferredClose) closeEvents.push(() => this.fire('close'));
          else this.fire('close');
        },
        focus() { this.focused = true; }
      });
    }
    return elements.get(id);
  };
  let request;
  let closed;
  const answers = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'recycle-confirmation-ui.js'), 'utf8'), {
    document: { getElementById: get },
    window: { electronAPI: {
      onRecycleConfirmation: fn => { request = fn; },
      onRecycleConfirmationClosed: fn => { closed = fn; },
      confirmRecycle: async (...args) => { answers.push(args); return reply(...args); }
    } }
  });
  return { get, answers, request: value => request(value), closed: id => closed(id),
    flushCloses() { while (closeEvents.length) closeEvents.shift()(); } };
}

test('app confirmation renders literal paths and Cancel has initial focus', async () => {
  const f = fixture();
  f.request({ requestId: 'a', path: '<img src=x onerror=alert(1)>' });
  assert.equal(f.get('recycle-dialog').open, true);
  assert.equal(f.get('recycle-cancel').focused, true);
  assert.equal(f.get('recycle-path').textContent, '<img src=x onerror=alert(1)>');
  await f.get('recycle-cancel').fire('click');
  assert.deepEqual(f.answers, [['a', false]]);
  assert.equal(f.get('recycle-dialog').open, false);
  await f.get('recycle-confirm').fire('click');
  assert.equal(f.answers.length, 1);
});

test('Escape cancels and stale close events do not close a different confirmation', async () => {
  const f = fixture();
  f.request({ requestId: 'a', path: 'C:\\test' });
  f.closed('old');
  assert.equal(f.get('recycle-dialog').open, true);
  let prevented = false;
  f.get('recycle-dialog').fire('cancel', { preventDefault() { prevented = true; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prevented, true);
  assert.deepEqual(f.answers, [['a', false]]);
});

test('confirmation prevents duplicate responses and shows IPC errors without accepting', async () => {
  let release;
  const f = fixture(() => new Promise(resolve => { release = resolve; }));
  f.request({ requestId: 'a', path: 'C:\\test' });
  const running = f.get('recycle-confirm').fire('click');
  assert.equal(f.get('recycle-confirm').disabled, true);
  await f.get('recycle-confirm').fire('click');
  release({ error: 'Connection unavailable' });
  await running;
  assert.equal(f.answers.length, 1);
  assert.equal(f.get('recycle-error').textContent, 'Connection unavailable');
  assert.equal(f.get('recycle-dialog').open, true);
  assert.equal(f.get('recycle-confirm').disabled, false);
  f.closed('a');
  assert.equal(f.get('recycle-dialog').open, false);
});

test('a delayed response and queued close from the previous confirmation cannot dismiss the next one', async () => {
  let release;
  const f = fixture(id => id === 'a' ? new Promise(resolve => { release = resolve; })
    : Promise.resolve({ success: true }), true);
  f.request({ requestId: 'a', path: 'C:\\first' });
  const firstResponse = f.get('recycle-cancel').fire('click');
  f.closed('a');
  f.request({ requestId: 'b', path: 'C:\\second' });
  f.flushCloses();
  assert.equal(f.get('recycle-dialog').open, true);
  assert.equal(f.get('recycle-confirm').disabled, false);
  release({ success: true });
  await firstResponse;
  assert.equal(f.get('recycle-dialog').open, true);
  assert.equal(f.get('recycle-path').textContent, 'C:\\second');
  assert.deepEqual(f.answers, [['a', false]]);
  await f.get('recycle-confirm').fire('click');
  assert.deepEqual(f.answers, [['a', false], ['b', true]]);
  assert.equal(f.get('recycle-dialog').open, false);
});

test('a stale IPC error cannot replace the error state of a newer confirmation', async () => {
  let release;
  const f = fixture(() => new Promise(resolve => { release = resolve; }));
  f.request({ requestId: 'a', path: 'C:\\first' });
  const firstResponse = f.get('recycle-confirm').fire('click');
  f.closed('a');
  f.request({ requestId: 'b', path: 'C:\\second' });
  release({ error: 'Old request failed' });
  await firstResponse;
  assert.equal(f.get('recycle-dialog').open, true);
  assert.equal(f.get('recycle-error').hidden, true);
  assert.equal(f.get('recycle-confirm').disabled, false);
});
