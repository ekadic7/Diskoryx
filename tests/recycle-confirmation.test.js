const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { createRecycleConfirmation } = require('../src/main/recycle-confirmation');

function fixture() {
  const handlers = new Map();
  const request = createRecycleConfirmation({ handle: (channel, fn) => handlers.set(channel, fn) });
  const sender = new EventEmitter();
  sender.isDestroyed = () => false;
  const messages = [];
  sender.send = (channel, value) => messages.push({ channel, value });
  return { sender, messages, request, respond: handlers.get('confirm-recycle') };
}

test('recycle confirmation belongs to one sender and one single-use request', async () => {
  const f = fixture();
  const waiting = f.request(f.sender, 'C:\\test\\<README>');
  const payload = f.messages[0].value;
  assert.equal(payload.path, 'C:\\test\\<README>');
  assert.match(f.respond({ sender: {} }, payload.requestId, true).error, /no longer active/);
  assert.match(f.respond({ sender: f.sender }, 'wrong', true).error, /no longer active/);
  assert.match(f.respond({ sender: f.sender }, payload.requestId, 'yes').error, /no longer active/);
  await assert.rejects(f.request(f.sender, 'C:\\another'), /already open/);
  assert.equal(f.respond({ sender: f.sender }, payload.requestId, true).success, true);
  assert.equal(await waiting, true);
  assert.match(f.respond({ sender: f.sender }, payload.requestId, true).error, /no longer active/);
  assert.equal(f.sender.listenerCount('destroyed'), 0);
  assert.equal(f.sender.listenerCount('did-start-loading'), 0);
});

test('Cancel, renderer reload and window closure never authorize recycling', async () => {
  for (const reason of ['cancel', 'did-start-loading', 'destroyed']) {
    const f = fixture();
    const waiting = f.request(f.sender, 'C:\\test');
    if (reason === 'cancel') f.respond({ sender: f.sender }, f.messages[0].value.requestId, false);
    else f.sender.emit(reason);
    assert.equal(await waiting, false);
    assert.equal(f.sender.listenerCount('destroyed'), 0);
  }
});

test('confirmation expires closed and send failures release its listeners', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const waiting = f.request(f.sender, 'C:\\test');
  t.mock.timers.tick(120000);
  assert.equal(await waiting, false);
  f.sender.send = () => { throw new Error('Renderer disconnected'); };
  await assert.rejects(f.request(f.sender, 'C:\\test'), /disconnected/);
  assert.equal(f.sender.listenerCount('destroyed'), 0);
});
