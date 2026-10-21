const { spawn } = require('node:child_process');

function startMftSession(executable, devicePath, signal) {
  signal?.throwIfAborted();
  const child = spawn(executable, [devicePath], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let closed = false;
  let stopping = false;
  let spawnError = null;
  const completion = new Promise(resolve => {
    child.once('error', error => { spawnError = error; });
    child.once('close', (code, exitSignal) => {
      closed = true;
      signal?.removeEventListener('abort', stop);
      resolve({ code, signal: exitSignal, error: spawnError });
    });
  });
  function stop() {
    if (closed || stopping) return;
    stopping = true;
    child.kill();
  }
  signal?.addEventListener('abort', stop, { once: true });
  // Abort can occur inside a synchronous launcher before the listener is attached.
  if (signal?.aborted) stop();
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    completion,
    stop,
    async dispose() {
      stop();
      await completion;
      signal?.removeEventListener('abort', stop);
    }
  };
}

module.exports = { startMftSession };
