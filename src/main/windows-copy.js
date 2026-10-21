const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { getFileActionHelperPath } = require('./windows-rename');

async function copyWithHandles(request, { signal, onProgress = () => {}, beforeCommit = () => {} } = {}) {
  signal?.throwIfAborted();
  const child = spawn(getFileActionHelperPath(), ['--copy'], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
  });
  let processError;
  let stderr = '';
  let inputError;
  let committed = false;
  let result;
  const closed = new Promise(resolve => {
    child.once('error', error => { processError = error; });
    child.once('close', code => resolve(code));
  });
  child.stdin.on('error', error => { inputError = error; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
  const cancel = () => child.stdin.end('cancel\n');
  signal?.addEventListener('abort', cancel, { once: true });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    child.stdin.write(JSON.stringify(request) + '\n');
    if (signal?.aborted) cancel();
    for await (const line of lines) {
      if (line.length > 262144) throw new Error('Oversized Windows copy response.');
      const message = JSON.parse(line);
      if (message.ready === true && !committed) {
        if (message.copyUsesStandardRights !== true) throw new Error('Copy helper did not confirm ordinary-user rights.');
        signal?.throwIfAborted();
        await beforeCommit();
        signal?.throwIfAborted();
        committed = true;
        child.stdin.write('commit\n');
      } else if (message.progress === true && committed) {
        onProgress(message);
      } else if ((message.success === true || message.error) && !result) {
        result = message;
        child.stdin.end();
      } else throw new Error('Unexpected Windows copy response.');
    }
    const code = await closed;
    if (processError) throw processError;
    if (!result) throw new Error(`Copy completion was not confirmed.${committed ? ' Check the destination before retrying; a staging item may remain.' : ''}${inputError ? ` ${inputError.message}` : ''}${stderr ? ` ${stderr}` : ''}`);
    if (!result.success && (!result.cancelled || result.stage)) {
      const error = new Error(result.error);
      error.outcomeUncertain = result.outcomeUncertain === true;
      throw error;
    }
    if (result.success && code !== 0) throw new Error('Copy reported completion but its helper did not exit cleanly. Check the destination before retrying.');
    return result;
  } catch (error) {
    if (request.move && committed && (!result || result.success)) error.outcomeUncertain = true;
    child.stdin.end('cancel\n');
    await closed;
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    lines.close();
  }
}

module.exports = { copyWithHandles };
