const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const readline = require('node:readline');
const net = require('node:net');
const { randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { createScanBroker } = require('../src/main/mft-broker');

let root;
let executable;
test.before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diskoryx-broker-'));
  const brokerFolder = path.join(root, 'native', 'scan-broker', 'bin');
  const scannerFolder = path.join(root, 'native', 'mft-scanner', 'bin');
  await fs.mkdir(brokerFolder, { recursive: true });
  await fs.mkdir(scannerFolder, { recursive: true });
  executable = path.join(brokerFolder, 'diskoryx-scan-broker.exe');
  const compiler = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  execFileSync(compiler, ['/nologo', '/target:exe', '/platform:x64',
    `/out:${path.join(scannerFolder, 'diskoryx-mft-scanner.exe')}`,
    path.join(__dirname, 'fixtures', 'scan-broker-helper.cs')], { windowsHide: true, stdio: 'pipe' });
  const digest = createHash('sha256').update(await fs.readFile(
    path.join(scannerFolder, 'diskoryx-mft-scanner.exe'))).digest('hex');
  const identity = path.join(root, 'ScannerIdentity.cs');
  await fs.writeFile(identity, `internal static class ScannerIdentity { internal const string Sha256 = "${digest}"; }`);
  execFileSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/reference:System.Web.Extensions.dll',
    `/out:${executable}`, path.join(__dirname, '..', 'native', 'scan-broker', 'Program.cs'), identity],
  { windowsHide: true, stdio: 'pipe' });
});
test.after(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function broker(t) {
  const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const messages = [];
  const lines = readline.createInterface({ input: child.stdout });
  const events = new (require('node:events').EventEmitter)();
  let stderr = '';
  let closed = false;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  lines.on('line', line => {
    messages.push(JSON.parse(line));
    events.emit('message');
  });
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => { closed = true; resolve(code); events.emit('message'); });
  });
  function wait(predicate) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Broker timeout: ${stderr}`)), 5000);
      function finish(error, message) {
        clearTimeout(timer);
        events.removeListener('message', inspect);
        if (error) reject(error);
        else resolve(message);
      }
      function inspect() {
        const message = messages.find(predicate);
        if (message) finish(null, message);
        else if (closed) finish(new Error(`Broker closed before expected response: ${stderr}`));
      }
      events.on('message', inspect);
      inspect();
    });
  }
  t.after(async () => {
    if (!closed) child.stdin.end();
    await completion;
    lines.close();
  });
  const ready = await wait(message => message.type === 'ready');
  assert.equal(ready.childLifetimeContained, true);
  return {
    child, messages, completion, wait,
    send: message => child.stdin.write(JSON.stringify(message) + '\n')
  };
}

test('broker rejects arbitrary commands and paths, then streams two scans in one process', { timeout: 15000 }, async t => {
  const b = await broker(t);
  b.send({ command: 'rename', id: 1, drive: 'C' });
  assert.match((await b.wait(m => m.type === 'error' && m.id === 1)).error, /Unsupported/);
  b.send({ command: 'scan', id: 2, drive: 'C:\\Windows' });
  assert.match((await b.wait(m => m.type === 'error' && m.id === 2)).error, /single local drive/);
  b.child.stdin.write('not-json\n');
  await b.wait(m => m.type === 'error' && m.id === 0);
  for (const id of [3, 4]) {
    b.send({ command: 'scan', id, drive: 'C' });
    const exit = await b.wait(m => m.type === 'exit' && m.id === id);
    assert.equal(exit.code, 0);
    assert.equal(exit.cancelled, false);
    assert.equal(exit.error, null);
    assert(b.messages.some(m => m.type === 'stdout' && m.id === id && m.data.includes('"summary"')));
    assert(b.messages.some(m => m.type === 'stderr' && m.id === id && m.data.includes('progress')));
  }
});

test('broker serializes scans, rejects stale cancellation and waits for the owned scanner to exit', { timeout: 15000 }, async t => {
  const b = await broker(t);
  b.send({ command: 'scan', id: 10, drive: 'D' });
  const data = await b.wait(m => m.type === 'stdout' && m.id === 10);
  const pid = JSON.parse(data.data.trim().split('\n')[0]).pid;
  b.send({ command: 'scan', id: 11, drive: 'C' });
  assert.match((await b.wait(m => m.type === 'error' && m.id === 11)).error, /already active/);
  b.send({ command: 'cancel', id: 12 });
  assert.match((await b.wait(m => m.type === 'error' && m.id === 12)).error, /matching active/);
  assert.doesNotThrow(() => process.kill(pid, 0));
  b.send({ command: 'cancel', id: 10 });
  assert.equal((await b.wait(m => m.type === 'exit' && m.id === 10)).cancelled, true);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  b.send({ command: 'scan', id: 13, drive: 'C' });
  assert.equal((await b.wait(m => m.type === 'exit' && m.id === 13)).code, 0);
});

test('closing the command connection drains and terminates its active scanner', { timeout: 15000 }, async t => {
  const b = await broker(t);
  b.send({ command: 'scan', id: 20, drive: 'D' });
  const pid = JSON.parse((await b.wait(m => m.type === 'stdout' && m.id === 20)).data.trim().split('\n')[0]).pid;
  b.child.stdin.end();
  assert.equal(await b.completion, 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert(b.messages.some(m => m.type === 'exit' && m.id === 20 && m.cancelled));
});

test('forced broker termination also terminates its scanner without a graceful Stop', { timeout: 15000 }, async t => {
  const b = await broker(t);
  b.send({ command: 'scan', id: 21, drive: 'F' });
  const pid = JSON.parse((await b.wait(m => m.type === 'stdout' && m.id === 21)).data.trim().split('\n')[0]).pid;
  const descendantPid = (await b.wait(m =>
    m.type === 'stdout' && m.id === 21 && m.data.includes('descendantPid'))).data.trim().split('\n')
    .map(line => JSON.parse(line)).find(record => record.descendantPid).descendantPid;
  assert.doesNotThrow(() => process.kill(pid, 0));
  assert.doesNotThrow(() => process.kill(descendantPid, 0));
  b.child.kill();
  await b.completion;
  // Job termination may finish shortly after the broker's own exit is observed.
  for (let attempt = 0; attempt < 100; attempt++) {
    let alive = false;
    for (const ownedPid of [pid, descendantPid]) {
      try { process.kill(ownedPid, 0); alive = true; }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (!alive) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Owned scanner or descendant survived forced broker termination.');
});

test('oversized command closes the broker instead of allocating an unbounded request', { timeout: 15000 }, async t => {
  const b = await broker(t);
  b.child.stdin.write('x'.repeat(1025));
  assert.equal(await b.completion, 1);
});

test('scanner failure is reported without a filesystem fallback and broker can accept another scan', { timeout: 15000 }, async t => {
  const b = await broker(t);
  b.send({ command: 'scan', id: 30, drive: 'E' });
  const failed = await b.wait(m => m.type === 'exit' && m.id === 30);
  assert.equal(failed.code, 4);
  assert.equal(failed.cancelled, false);
  b.send({ command: 'scan', id: 31, drive: 'c' });
  assert.equal((await b.wait(m => m.type === 'exit' && m.id === 31)).code, 0);
});

test('missing bundled scanner is an explicit error and never launches another executable', { timeout: 15000 }, async t => {
  const scanner = path.join(root, 'native', 'mft-scanner', 'bin', 'diskoryx-mft-scanner.exe');
  const saved = scanner + '.saved';
  await fs.rename(scanner, saved);
  try {
    const b = await broker(t);
    b.send({ command: 'scan', id: 40, drive: 'C' });
    assert.match((await b.wait(m => m.type === 'error' && m.id === 40)).error, /bundled MFT scanner is missing/);
    assert.equal(b.messages.some(m => m.type === 'started'), false);
  } finally {
    await fs.rename(saved, scanner);
  }
});

test('broker streams over a local pipe verified against the owning application PID', { timeout: 15000 }, async t => {
  const name = `diskoryx-scan-${randomBytes(16).toString('hex')}`;
  const server = net.createServer();
  server.listen(`\\\\.\\pipe\\${name}`);
  await once(server, 'listening');
  t.after(() => server.close());
  const connected = once(server, 'connection');
  const child = spawn(executable, ['--pipe', name, '--parent', String(process.pid)], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  const closed = once(child, 'close');
  const [socket] = await connected;
  const lines = readline.createInterface({ input: socket });
  const iterator = lines[Symbol.asyncIterator]();
  t.after(async () => { socket.destroy(); child.kill(); await closed; lines.close(); });
  assert.equal(JSON.parse((await iterator.next()).value).type, 'ready');
  socket.write(JSON.stringify({ command: 'scan', id: 50, drive: 'C' }) + '\n');
  let exit;
  const messages = [];
  while (!exit) {
    const message = JSON.parse((await iterator.next()).value);
    messages.push(message);
    if (message.type === 'exit') exit = message;
  }
  assert.equal(exit.id, 50);
  assert.equal(exit.code, 0);
  assert(messages.some(m => m.type === 'stdout' && m.data.includes('summary')));
  socket.end();
  assert.equal((await closed)[0], 0);
});

test('pipe with the wrong claimed application PID is refused before readiness', { timeout: 15000 }, async t => {
  const name = `diskoryx-scan-${randomBytes(16).toString('hex')}`;
  const parent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true });
  const parentClosed = once(parent, 'close');
  t.after(async () => { parent.kill(); await parentClosed; });
  const server = net.createServer(socket => { socket.resume(); });
  server.listen(`\\\\.\\pipe\\${name}`);
  await once(server, 'listening');
  t.after(() => server.close());
  const child = spawn(executable, ['--pipe', name, '--parent', String(parent.pid)], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  let errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(code, 1);
  assert.equal(output, '');
  assert.match(errors, /does not belong to the expected application/);
});

test('unexpected application death terminates pipe broker and its active scanner', { timeout: 15000 }, async t => {
  const name = `diskoryx-scan-${randomBytes(16).toString('hex')}`;
  const script = `
    const net = require('node:net');
    const {spawn} = require('node:child_process');
    const readline = require('node:readline');
    net.createServer(socket => {
      const lines = readline.createInterface({input:socket});
      lines.on('line', line => {
        const m = JSON.parse(line);
        if (m.type === 'ready') socket.write(JSON.stringify({command:'scan',id:60,drive:'D'})+'\\n');
        if (m.type === 'stdout') process.stdout.write(JSON.stringify({scanner:JSON.parse(m.data.trim().split('\\n')[0]).pid})+'\\n');
      });
    }).listen(${JSON.stringify(`\\\\.\\pipe\\${name}`)}, () => {
      const child = spawn(${JSON.stringify(executable)}, ['--pipe',${JSON.stringify(name)},'--parent',String(process.pid)],
        {windowsHide:true,stdio:'ignore'});
      process.stdout.write(JSON.stringify({broker:child.pid})+'\\n');
    });
  `;
  const parent = spawn(process.execPath, ['-e', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(parent, 'close');
  const lines = readline.createInterface({ input: parent.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  const owned = [];
  t.after(async () => {
    parent.kill();
    await closed;
    for (const pid of owned) {
      try { process.kill(pid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    lines.close();
  });
  owned.push(JSON.parse((await iterator.next()).value).broker);
  owned.push(JSON.parse((await iterator.next()).value).scanner);
  parent.kill();
  await closed;
  for (let attempt = 0; attempt < 100; attempt++) {
    let alive = false;
    for (const pid of owned) {
      try { process.kill(pid, 0); alive = true; }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (!alive) { owned.length = 0; return; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Broker or scanner survived unexpected application exit.');
});

test('application scan adapter streams results, reuses one worker and drains Stop before another scan', { timeout: 15000 }, async t => {
  let launches = 0;
  const adapter = createScanBroker(executable, (file, _args, options) => {
    launches++;
    return spawn(file, [], options);
  });
  t.after(() => adapter.close());
  const first = await adapter.start(null, '\\\\.\\C:', new AbortController().signal);
  let output = '';
  first.stdout.setEncoding('utf8');
  first.stdout.on('data', chunk => { output += chunk; });
  first.stderr.resume();
  assert.equal((await first.completion).code, 0);
  assert.match(output, /"summary"/);
  const controller = new AbortController();
  const second = await adapter.start(null, '\\\\.\\D:', controller.signal);
  const data = once(second.stdout, 'data');
  second.stderr.resume();
  await data;
  await assert.rejects(adapter.start(null, '\\\\.\\C:'), /already running/);
  controller.abort();
  await second.dispose();
  const third = await adapter.start(null, '\\\\.\\C:');
  third.stdout.resume();
  third.stderr.resume();
  assert.equal((await third.completion).code, 0);
  assert.equal(launches, 1, 'Rescan/Stop must not request another UAC connection');
});

test('app adapter refuses invalid drives and failed startup without a filesystem fallback', { timeout: 15000 }, async t => {
  const adapter = createScanBroker(executable, (_file, _args, options) => spawn(process.execPath,
    ['-e', 'process.stderr.write("UAC declined fixture");process.exit(1)'], options));
  t.after(() => adapter.close());
  await assert.rejects(adapter.start(null, 'C:\\Windows'), /local drive/);
  await assert.rejects(adapter.start(null, '\\\\.\\C:'), error => {
    assert.equal(error.noFallback, true);
    assert.match(error.message, /UAC declined fixture/);
    return true;
  });
});

test('app adapter cancellation during startup closes the owning bridge', { timeout: 15000 }, async t => {
  let child;
  const adapter = createScanBroker(executable, (_file, _args, options) => {
    child = spawn(process.execPath, ['-e', 'setInterval(() => {},1000)'], options);
    return child;
  });
  t.after(() => adapter.close());
  const controller = new AbortController();
  const running = adapter.start(null, '\\\\.\\C:', controller.signal);
  controller.abort();
  await assert.rejects(running);
  assert.notEqual(child.exitCode ?? child.signalCode, null);
});

test('tampered scanner image is refused before execution', { timeout: 15000 }, async t => {
  const scanner = path.join(root, 'native', 'mft-scanner', 'bin', 'diskoryx-mft-scanner.exe');
  const bytes = await fs.readFile(scanner);
  try {
    await fs.appendFile(scanner, 'tampered');
    const b = await broker(t);
    b.send({ command: 'scan', id: 70, drive: 'C' });
    assert.match((await b.wait(m => m.type === 'error' && m.id === 70)).error, /approved local build/);
    assert.equal(b.messages.some(m => m.type === 'started'), false);
  } finally {
    await fs.writeFile(scanner, bytes);
  }
});

test('chunked adapter preserves every Unicode record through slow-consumer backpressure', { timeout: 15000 }, async t => {
  const adapter = createScanBroker(executable, (file, _args, options) => spawn(file, [], options));
  t.after(() => adapter.close());
  const session = await adapter.start(null, '\\\\.\\G:');
  session.stderr.resume();
  const lines = readline.createInterface({ input: session.stdout });
  let count = 0;
  for await (const line of lines) {
    const record = JSON.parse(line);
    if (record.pid) continue;
    assert.equal(record.index, count++);
    assert.equal(record.name, '\u010ditanje-\u65e5\u672c\u8a9e-\ud83d\ude42');
    if (count % 500 === 0) await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal(count, 20000);
  assert.equal((await session.completion).code, 0);
});

test('broker data envelopes preserve all controls, JSON metacharacters and Unicode on both streams', { timeout: 15000 }, async t => {
  const adapter = createScanBroker(executable, (file, _args, options) => spawn(file, [], options));
  t.after(() => adapter.close());
  const session = await adapter.start(null, '\\\\.\\H:');
  async function collect(stream) {
    stream.setEncoding('utf8');
    let text = '';
    for await (const chunk of stream) text += chunk;
    return text;
  }
  const [stdout, stderr, result] = await Promise.all([
    collect(session.stdout), collect(session.stderr), session.completion
  ]);
  assert.equal(result.code, 0, JSON.stringify({ stderr, error: result.error?.message }));
  const controls = Array.from({ length: 32 }, (_, index) => String.fromCharCode(index)).join('');
  assert.match(stdout, /^\{"pid":\d+\}\r?\n/);
  assert.equal(stdout.replace(/^\{"pid":\d+\}\r?\n/, ''), controls + '"\\/<>&\u2028\u2029\u010d\u65e5\ud83d\ude42');
  assert.equal(stderr.replace(/^fixture scanner progress\r?\n/, ''), '\0\t\r\n"\\\u010d\ud83d\ude42');
  assert.equal(result.code, 0);
});
