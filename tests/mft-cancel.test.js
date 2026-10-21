const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');

const root = path.join(__dirname, '..', 'src', 'main');
const rootRequire = createRequire(path.join(root, 'mft-scanner.js'));

function loadScanner(t, script, missingExecutable = false, finalizeDelayMs = 0) {
  let child;
  let closed = false;
  let spawnCount = 0;
  const launcher = {
    spawn() {
      spawnCount++;
      child = missingExecutable
        ? spawn(path.join(root, 'nonexistent-helper.exe'), [], { windowsHide: true })
        : spawn(process.execPath, ['-e', script], {
          windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
        });
      child.once('close', () => { closed = true; });
      return child;
    }
  };
  const sessionContext = {
    module: { exports: {} },
    require: name => name === 'node:child_process' ? launcher : rootRequire(name)
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'mft-session.js'), 'utf8'), sessionContext);
  const context = {
    __dirname: root, module: { exports: {} }, process, setImmediate, setTimeout,
    console: { ...console, info() {} },
    require(name) {
      if (name === 'node:fs') return { existsSync: () => true };
      if (name === './mft-broker') return { startBrokerMftSession: sessionContext.module.exports.startMftSession };
      return rootRequire(name);
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'mft-scanner.js'), 'utf8'), context);
  if (finalizeDelayMs) vm.runInNewContext(`
    const originalBuilder = createTreeBuilder;
    createTreeBuilder = (...args) => {
      const tree = originalBuilder(...args);
      const finish = tree.finish;
      tree.finish = async (...values) => {
        await new Promise(resolve => setTimeout(resolve, ${finalizeDelayMs}));
        return finish(...values);
      };
      return tree;
    };
  `, context);
  t.after(() => { if (child && !closed) child.kill(); });
  return {
    scan: context.module.exports.scanMftVolume,
    get closed() { return closed; },
    get spawnCount() { return spawnCount; }
  };
}

test('MFT cancellation terminates only its owned helper and waits for close', { timeout: 10000 }, async t => {
  const scanner = loadScanner(t, `
    process.stderr.write('Progress: 1/100 MFT records, 1 files, 0 folders\\n');
    setInterval(() => {}, 1000);
  `);
  const controller = new AbortController();
  let progressCount = 0;
  const running = scanner.scan('C:\\', progress => {
    progressCount++;
    if (progress.scannedEntries > 0) controller.abort();
  }, {}, false, controller.signal);
  await assert.rejects(running, { name: 'AbortError' });
  assert.equal(scanner.closed, true, 'scan must not settle before helper close');
  assert.equal(scanner.spawnCount, 1);
  assert.equal(progressCount, 2);
  await assert.rejects(scanner.scan('C:\\', () => {}, {}, false, controller.signal), { name: 'AbortError' });
  assert.equal(scanner.spawnCount, 1, 'pre-cancelled scan must not spawn a helper');
});

test('MFT helper output still builds the same file totals without cancellation', { timeout: 10000 }, async t => {
  const records = [
    { type: 'entry', path: 'C:\\data\\one.txt', size: 12, isDirectory: false },
    { type: 'entry', path: 'C:\\data\\two.txt', size: 8, isDirectory: false },
    { type: 'summary', elapsedMs: 1 }
  ];
  const scanner = loadScanner(t, `process.stdout.write(${JSON.stringify(records.map(r => JSON.stringify(r)).join('\n') + '\n')});`);
  const result = await scanner.scan('C:\\', () => {}, {}, false, new AbortController().signal);
  assert.equal(scanner.closed, true);
  assert.equal(result.success, true);
  assert.equal(result.fileCount, 2);
  assert.equal(result.folderCount, 1);
  assert.equal(result.totalSizeBytes, 20);
  assert.equal(result.folderNodes[0].fileCount, 2);
  assert.equal(result.largestFiles[0].rawSize, 12);
});

test('MFT import errors terminate the helper before rejecting', { timeout: 10000 }, async t => {
  const scanner = loadScanner(t, `
    process.stdout.write('invalid json\\n');
    setInterval(() => {}, 1000);
  `);
  await assert.rejects(scanner.scan('C:\\', () => {}), /JSON|Unexpected/);
  assert.equal(scanner.closed, true);
});

test('MFT spawn failures release the scan instead of hanging', { timeout: 10000 }, async t => {
  const scanner = loadScanner(t, '', true);
  await assert.rejects(scanner.scan('C:\\', () => {}), /ENOENT/);
  assert.equal(scanner.closed, true);
});

test('an initial progress consumer failure closes the owned MFT session before rejecting', { timeout: 10000 }, async t => {
  const scanner = loadScanner(t, 'setInterval(() => {}, 1000);');
  await assert.rejects(scanner.scan('C:\\', () => { throw new Error('Progress consumer failed'); }),
    /Progress consumer failed/);
  assert.equal(scanner.closed, true);
  assert.equal(scanner.spawnCount, 1);
});

test('MFT displayed duration includes aggregation and throughput uses the same complete interval', async t => {
  const records = [
    { type: 'entry', path: 'C:\\one.txt', size: 8, isDirectory: false },
    { type: 'summary', elapsedMs: 1 }
  ];
  const scanner = loadScanner(t,
    `process.stdout.write(${JSON.stringify(records.map(record => JSON.stringify(record)).join('\n') + '\n')});`,
    false, 80);
  const result = await scanner.scan('C:\\', () => {});
  assert(result.scanDurationMs >= 80, 'must include the delayed tree finalization');
  assert.equal(result.entriesPerSecond, 1 / Math.max(result.scanDurationMs / 1000, 0.001));
});

test('chunked MFT import preserves fragmented Unicode, CRLF, no final newline and alias accounting', async t => {
  const records = [
    { type: 'entry', path: 'C:\\日本語\\emoji-😀.txt', size: 12, modifiedMs: 1600000000000 },
    { type: 'entry', path: 'C:\\日本語\\alias.txt', size: 12, sizeOwner: false, hardLinkCount: 2 },
    { type: 'entry', path: 'C:\\日本語', isDirectory: true },
    { type: 'summary', elapsedMs: 1, corruptRecords: 2, unresolvedPaths: 1 }
  ];
  const output = records.map(record => JSON.stringify(record)).join('\r\n');
  const scanner = loadScanner(t, `
    const data = Buffer.from(${JSON.stringify(output)});
    let index = 0;
    function write() {
      if (index === data.length) return;
      process.stdout.write(data.subarray(index, ++index));
      setImmediate(write);
    }
    write();
  `);
  const result = await scanner.scan('C:\\', () => {});
  assert.equal(result.fileNodes[0].path, records[0].path);
  assert.equal(result.fileCount, 2);
  assert.equal(result.totalSizeBytes, 12);
  assert.equal(result.folderCount, 1);
  assert.equal(result.skippedCount, 3);
});

test('chunked MFT import rejects oversized unterminated records and drains the owned helper', async t => {
  const scanner = loadScanner(t, `
    process.stdout.write('x'.repeat(1048577));
    setInterval(() => {}, 1000);
  `);
  await assert.rejects(scanner.scan('C:\\', () => {}), /size limit/);
  assert.equal(scanner.closed, true);
});
