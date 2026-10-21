const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { PassThrough } = require('node:stream');
const { once } = require('node:events');

function getScanBrokerPath() {
  const packaged = typeof process.resourcesPath === 'string'
    ? path.join(process.resourcesPath, 'native', 'scan-broker', 'bin', 'diskoryx-scan-broker.exe')
    : '';
  if (packaged && fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', '..', 'native', 'scan-broker', 'bin', 'diskoryx-scan-broker.exe');
}

function requireStandardUser() {
  const executable = getScanBrokerPath();
  if (!fs.existsSync(executable)) throw new Error('Scanner broker missing. Run npm run build:scan-broker locally.');
  try {
    execFileSync(executable, ['--check-ui'], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
  } catch (error) {
    throw new Error(String(error.stderr || error.message).trim());
  }
}

function createScanBroker(executable = getScanBrokerPath(), launch = spawn) {
  let connection = null;
  let active = null;
  let nextId = 0;
  function failure(message) {
    const error = new Error(message);
    error.noFallback = true;
    return error;
  }
  function finish(session, result) {
    if (active !== session) return;
    active = null;
    session.stdout.end();
    session.stderr.end();
    session.signal?.removeEventListener('abort', session.stop);
    session.resolve(result);
  }
  function open() {
    if (connection) return connection;
    if (!fs.existsSync(executable)) throw failure('Scanner broker missing. Run npm run build:scan-broker locally.');
    const child = launch(executable, ['--client'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const state = { child, ready: false, errors: '', problem: null };
    connection = state;
    let readyResolve;
    let readyReject;
    state.readiness = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    state.closed = new Promise(resolve => child.once('close', () => {
      if (connection === state) connection = null;
      const error = failure(state.problem?.message || state.errors.trim()
        || 'Administrator scanner closed. Start a new scan to reconnect.');
      readyReject(error);
      if (active?.connection === state) finish(active, { code: 1, error });
      resolve();
    }));
    child.once('error', error => { state.problem = error; });
    child.stdin.on('error', error => { state.problem = error; child.kill(); });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { state.errors = (state.errors + chunk).slice(-8192); });
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    void (async () => {
      try {
        for await (const line of lines) {
          if (line.length > 1048576) throw failure('Oversized scanner broker response.');
          const message = JSON.parse(line);
          if (!state.ready) {
            if (message.type !== 'ready' || message.protocol !== 2 || message.childLifetimeContained !== true) {
              throw failure('Scanner broker did not confirm its protocol and process containment.');
            }
            state.ready = true;
            readyResolve();
            continue;
          }
          const session = active;
          if (!session || session.connection !== state || message.id !== session.id) {
            throw failure('Scanner broker returned an unexpected scan ID.');
          }
          if (message.type === 'stdout' || message.type === 'stderr') {
            if (typeof message.data !== 'string') throw failure('Invalid scanner data.');
            const stream = session[message.type];
            if (!session.discard && !stream.write(message.data)) await once(stream, 'drain');
          } else if (message.type === 'exit') {
            if (!Number.isInteger(message.code)) throw failure('Invalid scanner exit code.');
            finish(session, {
              code: message.code,
              error: message.error ? failure(message.error) : null
            });
          } else if (message.type === 'error') {
            finish(session, { code: 1, error: failure(message.error || 'Scanner request refused.') });
          } else if (message.type !== 'started') {
            throw failure('Unexpected scanner broker response.');
          }
        }
      } catch (error) {
        state.problem = error;
        child.kill();
      } finally {
        lines.close();
      }
    })();
    return state;
  }
  return {
    async start(_executable, devicePath, signal) {
      signal?.throwIfAborted();
      if (!/^\\\\\.\\[A-Z]:$/i.test(devicePath)) throw failure('A local drive is required for MFT scanning.');
      if (active) throw failure('An MFT scan is already running.');
      const state = open();
      // Cancelling a pending UAC/handshake closes its owning bridge. A late
      // approved worker will refuse its now-dead parent.
      const cancelStartup = () => state.child.kill();
      signal?.addEventListener('abort', cancelStartup, { once: true });
      if (signal?.aborted) cancelStartup();
      try { await state.readiness; }
      finally { signal?.removeEventListener('abort', cancelStartup); }
      signal?.throwIfAborted();
      if (active) throw failure('An MFT scan is already running.');
      const session = {
        id: ++nextId, connection: state, signal, discard: false, stopped: false,
        stdout: new PassThrough(), stderr: new PassThrough()
      };
      session.completion = new Promise(resolve => { session.resolve = resolve; });
      session.stop = () => {
        if (active !== session || session.stopped) return;
        session.stopped = true;
        state.child.stdin.write(JSON.stringify({ command: 'cancel', id: session.id }) + '\n');
      };
      session.dispose = async () => {
        session.discard = true;
        session.stdout.resume();
        session.stderr.resume();
        session.stop();
        await session.completion;
      };
      active = session;
      signal?.addEventListener('abort', session.stop, { once: true });
      state.child.stdin.write(JSON.stringify({ command: 'scan', id: session.id, drive: devicePath.at(-2) }) + '\n');
      if (signal?.aborted) session.stop();
      return session;
    },
    async close() {
      const state = connection;
      if (!state) return;
      if (active) {
        active.discard = true;
        active.stdout.resume();
        active.stderr.resume();
      }
      state.child.stdin.end();
      // Closing the bridge is enough even if its elevated child is stuck:
      // native parent-death monitoring closes the scanner's lifetime job.
      state.child.kill();
      await state.closed;
    }
  };
}

const broker = createScanBroker();
module.exports = {
  getScanBrokerPath, requireStandardUser, createScanBroker,
  startBrokerMftSession: (...args) => broker.start(...args),
  closeScanBroker: () => broker.close()
};
