const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { validateNewName } = require('./file-action-guard');

function getFileActionHelperPath() {
  const packaged = typeof process.resourcesPath === 'string'
    ? path.join(process.resourcesPath, 'native', 'file-actions', 'bin', 'diskoryx-file-actions.exe')
    : '';
  if (packaged && fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', '..', 'native', 'file-actions', 'bin', 'diskoryx-file-actions.exe');
}

async function runWithHandles(root, target, newName, entries, beforeCommit, recycleGuard, restoreRequest = null, createFolder = false) {
  const action = recycleGuard ? 'Recycle' : createFolder ? 'Create folder' : 'Rename';
  if (process.platform !== 'win32') throw new Error('Handle-based file actions require Windows.');
  if (!recycleGuard) validateNewName(newName);
  const executable = getFileActionHelperPath();
  if (!fs.existsSync(executable)) {
    throw new Error('The Windows file-action helper is missing. Run npm run build:file-actions locally; no path-based fallback is used.');
  }
  const helperArguments = restoreRequest ? ['--restore'] : createFolder ? ['--create-folder'] : [];
  const child = spawn(executable, helperArguments, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  let processError;
  let timedOut = false;
  let stderr = '';
  let ready = false;
  let committed = false;
  let recycleIssued = false;
  let succeeded = false;
  let refused = false;
  let inputError;
  let hasClosed = false;
  let warning;
  let completedResponse;
  const closed = new Promise(resolve => {
    child.once('error', error => { processError = error; });
    child.once('close', (code, signal) => {
      hasClosed = true;
      resolve({ code, signal });
    });
  });
  child.stdin.on('error', error => { inputError = error; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 30000);
  try {
    child.stdin.write(JSON.stringify(restoreRequest || {
      root, target, newName, entries, mode: recycleGuard ? 'recycle-guard' : createFolder ? 'create-folder' : 'rename'
    }) + '\n');
    for await (const line of lines) {
      if (line.length > 262144) throw new Error('Invalid Windows helper response.');
      const response = JSON.parse(line);
      if (response.error) {
        refused = true;
        const error = new Error(response.error);
        if (response.restored || response.outcomeUncertain === true) error.outcomeUncertain = true;
        throw error;
      }
      if (response.ready === true && !ready) {
        if (!recycleGuard && (createFolder ? response.createFolderUsesStandardRights !== true
          : response.renameUsesStandardRights !== true)) {
          throw new Error(`The Windows helper did not confirm standard-user ${action} rights. Run npm run build:file-actions; elevated fallback is not allowed.`);
        }
        ready = true;
        // Never expire the guard while an issued shell operation is still pending.
        if (recycleGuard) {
          clearTimeout(timer);
          committed = true;
        }
        await beforeCommit(() => { recycleIssued = true; });
        if (timedOut || inputError || hasClosed) throw inputError || new Error('Windows file-action helper stopped before completion.');
        committed = true;
        child.stdin.end(recycleGuard ? 'release\n' : 'commit\n');
      } else if (response.success === true && committed && !succeeded) {
        succeeded = true;
        warning = response.warning;
        completedResponse = response;
      } else {
        throw new Error('Unexpected Windows helper response.');
      }
    }
    const result = await closed;
    if (processError) throw processError;
    if (inputError) throw inputError;
    if (timedOut || result.code !== 0 || !succeeded) {
      throw new Error(`Windows ${action.toLowerCase()} did not report completion.${committed ? ' The outcome is uncertain; Rescan before another file action.' : ''}${stderr ? ` ${stderr}` : ''}`);
    }
    return { ...completedResponse, warning };
  } catch (error) {
    child.stdin.destroy();
    child.kill();
    await closed;
    if ((recycleGuard ? recycleIssued : committed) && !refused) {
      error.outcomeUncertain = true;
      error.message += ` ${action} completion is uncertain. Rescan before another file action.`;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    lines.close();
  }
}

function renameWithHandles(root, target, newName, entries, beforeCommit = () => {}) {
  return runWithHandles(root, target, newName, entries, beforeCommit, false);
}

function createFolderWithHandles(root, target, newName, entries, beforeCommit = () => {}) {
  return runWithHandles(root, target, newName, entries, beforeCommit, false, null, true);
}

function recycleWithPinnedAncestors(root, target, entries, operation) {
  return runWithHandles(root, target, null, entries, operation, true);
}

function restoreWithHandles(request, beforeCommit) {
  return runWithHandles(path.parse(request.target).root, request.target,
    path.basename(request.destination), request.entries, beforeCommit, false, request);
}

module.exports = {
  getFileActionHelperPath, renameWithHandles, createFolderWithHandles,
  recycleWithPinnedAncestors, restoreWithHandles
};
