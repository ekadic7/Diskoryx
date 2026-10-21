const fs = require('node:fs');
const path = require('node:path');

function createLiveMonitor({
  onBatch, onStale, isBusy = () => false, watch = fs.watch,
  inspectRoot = folder => fs.lstatSync(folder, { bigint: true }), delay = 300, maxPaths = 512
}) {
  let watcher;
  let root;
  let timer;
  let generation = 0;
  let running = false;
  let rootIdentity;
  let failure = null;
  const pending = new Set();
  function stop() {
    generation++;
    clearTimeout(timer);
    timer = null;
    watcher?.close();
    watcher = null;
    pending.clear();
    failure = null;
  }
  function stale(message) {
    stop();
    failure = message;
    schedule();
  }
  function schedule() {
    if (timer || running || (!watcher && !failure)) return;
    timer = setTimeout(() => { timer = null; void drain(); }, delay);
    timer.unref?.();
  }
  async function drain() {
    if (!failure && (!watcher || !pending.size)) return;
    if (isBusy()) { schedule(); return; }
    if (failure) {
      const message = failure;
      failure = null;
      onStale(message);
      return;
    }
    const token = generation;
    const batch = [...pending];
    pending.clear();
    running = true;
    try {
      const stat = inspectRoot(root);
      if (stat.isSymbolicLink() || !stat.isDirectory() || `${stat.dev}:${stat.ino}` !== rootIdentity) {
        throw new Error('The watched root was replaced, redirected or removed.');
      }
      await onBatch(batch, () => token === generation && !failure);
    }
    catch (error) { if (token === generation) stale(error.message); }
    finally { running = false; if (pending.size || failure) schedule(); }
  }
  return {
    start(folder) {
      stop();
      root = path.resolve(folder);
      const token = generation;
      try {
        const stat = inspectRoot(root);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('A regular, non-redirected root directory is required.');
        rootIdentity = `${stat.dev}:${stat.ino}`;
        watcher = watch(root, { recursive: true, persistent: false }, (_type, filename) => {
          if (token !== generation) return;
          if (!filename) { stale('Windows did not identify a changed path; events may have been lost.'); return; }
          const target = path.resolve(root, String(filename));
          const relative = path.relative(root, target);
          if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            stale('The watched root or an invalid path changed.'); return;
          }
          pending.add(target);
          if (pending.size > maxPaths) { stale('Too many filesystem changes arrived to reconcile reliably.'); return; }
          schedule();
        });
        watcher.on('error', error => {
          if (token === generation) stale(`Filesystem notifications stopped: ${error.message}`);
        });
        return true;
      } catch (error) { stale(`Live updates unavailable: ${error.message}`); return false; }
    },
    stop
  };
}

module.exports = { createLiveMonitor };
