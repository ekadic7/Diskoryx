const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');

const root = path.join(__dirname, '..', 'src', 'main');
const rootRequire = createRequire(path.join(root, 'mft-scanner.js'));

function writeUInt64LE(buffer, value, offset) {
  buffer.writeUInt32LE(value % 4294967296, offset);
  buffer.writeUInt32LE(Math.floor(value / 4294967296), offset + 4);
}

function mftBinary({ folders = [], files = [], summary = {}, rawSummary }) {
  const parts = [];
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x324d5844, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(folders.length, 8);
  parts.push(header);
  for (const [parent, name, attributes = 0] of folders) {
    const nameBytes = Buffer.from(name, 'utf8');
    const record = Buffer.alloc(10);
    record.writeUInt32LE(parent, 0);
    record.writeUInt32LE(attributes, 4);
    record.writeUInt16LE(nameBytes.length, 8);
    parts.push(record, nameBytes);
  }
  const count = Buffer.alloc(4);
  count.writeUInt32LE(files.length, 0);
  parts.push(count);
  for (const [parent, name, size = 0, modifiedMs = null, attributes = 0, hardLinks = 1, sizeOwner = true] of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const record = Buffer.alloc(29);
    record.writeUInt32LE(parent, 0);
    writeUInt64LE(record, size, 4);
    record.writeBigInt64LE(BigInt(modifiedMs === null ? 0 : modifiedMs), 12);
    record.writeUInt32LE(attributes, 20);
    record.writeUInt16LE(hardLinks, 24);
    record[26] = (sizeOwner ? 1 : 0) | (modifiedMs === null ? 0 : 2);
    record.writeUInt16LE(nameBytes.length, 27);
    parts.push(record, nameBytes);
  }
  parts.push(Buffer.from(rawSummary ?? JSON.stringify({
    type: 'summary', recordSlots: folders.length + files.length + 1,
    files: files.length, directories: folders.length,
    logicalBytes: files.reduce((total, file) => total + (file[6] === false ? 0 : file[2] || 0), 0),
    unresolvedPaths: 0, corruptRecords: 0, memoryBytes: 0, elapsedMs: 1, ...summary
  }), 'utf8'));
  return Buffer.concat(parts);
}

function scriptWriting(data, { byteByByte = false, tail = '' } = {}) {
  const encoded = JSON.stringify(data.toString('base64'));
  if (!byteByByte) return `process.stdout.write(Buffer.from(${encoded}, 'base64'));${tail}`;
  return `
    const data = Buffer.from(${encoded}, 'base64');
    let index = 0;
    function write() {
      if (index === data.length) return;
      process.stdout.write(data.subarray(index, ++index));
      setImmediate(write);
    }
    write();${tail}
  `;
}

function loadScanner(t, script, missingExecutable = false, finalizeDelayMs = 0, onYield) {
  let child;
  let closed = false;
  let spawnCount = 0;
  let yieldCount = 0;
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
    __dirname: root, module: { exports: {} }, process, setTimeout,
    setImmediate(callback) {
      yieldCount++;
      return setImmediate(() => { onYield?.(); callback(); });
    },
    Buffer,
    console: { ...console, info() {} },
    require(name) {
      if (name === 'node:fs') return { existsSync: () => true };
      if (name === './mft-broker') return { startBrokerMftSession: sessionContext.module.exports.startMftSession };
      return rootRequire(name);
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'mft-scanner.js'), 'utf8'), context);
  if (finalizeDelayMs) vm.runInNewContext(`
    const originalFinalize = finalizeScan;
    finalizeScan = async (...args) => {
      await new Promise(resolve => setTimeout(resolve, ${finalizeDelayMs}));
      return originalFinalize(...args);
    };
  `, context);
  t.after(() => { if (child && !closed) child.kill(); });
  return {
    scan: context.module.exports.scanMftVolume,
    get closed() { return closed; },
    get spawnCount() { return spawnCount; },
    get yieldCount() { return yieldCount; }
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
  const data = mftBinary({
    folders: [[0, 'data']],
    files: [[1, 'one.txt', 12], [1, 'two.txt', 8]],
    summary: { elapsedMs: 1 }
  });
  const scanner = loadScanner(t, scriptWriting(data));
  const result = await scanner.scan('C:\\', () => {}, {}, false, new AbortController().signal);
  assert.equal(scanner.closed, true);
  assert.equal(result.success, true);
  assert.equal(result.fileCount, 2);
  assert.equal(result.folderCount, 1);
  assert.equal(result.totalSizeBytes, 20);
  assert.equal(result.folderNodes[1].path, 'C:\\data');
  assert.equal(result.fileNodes[0].path, 'C:\\data\\one.txt');
  assert.equal(result.folderNodes[0].fileCount, 2);
  assert.equal(result.largestFiles[0].rawSize, 12);
});

test('MFT import errors terminate the helper before rejecting', { timeout: 10000 }, async t => {
  const scanner = loadScanner(t, `
    process.stdout.write('invalid binary stream');
    setInterval(() => {}, 1000);
  `);
  await assert.rejects(scanner.scan('C:\\', () => {}), /Unsupported MFT scanner output/);
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
  const data = mftBinary({
    files: [[0, 'one.txt', 8]],
    summary: { elapsedMs: 1 }
  });
  const scanner = loadScanner(t, scriptWriting(data), false, 80);
  const result = await scanner.scan('C:\\', () => {});
  assert(result.scanDurationMs >= 80, 'must include the delayed tree finalization');
  assert.equal(result.entriesPerSecond, 1 / Math.max(result.scanDurationMs / 1000, 0.001));
});

test('chunked MFT import preserves fragmented Unicode, CRLF, no final newline and alias accounting', async t => {
  const data = mftBinary({
    folders: [[0, '日本語']],
    files: [
      [1, 'emoji-😀.txt', 12, 1600000000000],
      [1, 'alias.txt', 12, null, 0, 2, false]
    ],
    summary: { elapsedMs: 1, corruptRecords: 2, unresolvedPaths: 1 }
  });
  const scanner = loadScanner(t, scriptWriting(data, { byteByByte: true }));
  const result = await scanner.scan('C:\\', () => {});
  assert.equal(result.fileNodes[0].path, 'C:\\日本語\\emoji-😀.txt');
  assert.equal(result.fileNodes[1].path, 'C:\\日本語\\alias.txt');
  assert.equal(result.fileCount, 2);
  assert.equal(result.totalSizeBytes, 12);
  assert.equal(result.folderCount, 1);
  assert.equal(result.skippedCount, 3);
  assert.equal(result.fileNodes[1].sizeOwner, false);
  assert.equal(result.fileNodes[1].hardLinkCount, 2);
});

test('binary MFT scans still apply excluded folder names to the whole subtree', { timeout: 10000 }, async t => {
  const data = mftBinary({
    folders: [[0, 'skip'], [0, 'keep'], [1, 'nested']],
    files: [[1, 'ignored.txt', 100], [3, 'ignored-too.txt', 50], [2, 'kept.txt', 7]]
  });
  const scanner = loadScanner(t, scriptWriting(data));
  const result = await scanner.scan('C:\\', () => {}, { excludeFolderNames: ['skip'] });
  assert.equal(result.fileCount, 1);
  assert.equal(result.folderCount, 1);
  assert.equal(result.excludedFolderCount, 1);
  assert.equal(result.totalSizeBytes, 7);
  assert.equal(result.fileNodes[0].path, 'C:\\keep\\kept.txt');
  assert.equal(result.folderNodes[0].children.some(item => item.name === 'skip'), false);
});

test('a truncated MFT stream is refused instead of returning a partial tree', { timeout: 10000 }, async t => {
  const full = mftBinary({ folders: [[0, 'data']], files: [[1, 'one.txt', 4]] });
  // Header plus one complete folder record, but the declared file section is missing.
  const header = full.subarray(0, 12);
  const folderRecord = full.subarray(12, 12 + 10 + Buffer.byteLength('data'));
  const count = Buffer.alloc(4);
  count.writeUInt32LE(2, 0);
  const scanner = loadScanner(t, scriptWriting(Buffer.concat([header, folderRecord, count])));
  await assert.rejects(scanner.scan('C:\\', () => {}), /ended before all records/);
  assert.equal(scanner.closed, true);
});

test('binary MFT refuses missing, malformed and inconsistent summary fields', async t => {
  const invalid = [
    { rawSummary: '{}' }, { rawSummary: 'null' }, { rawSummary: '[]' },
    { summary: { type: 'entry' } }, { summary: { files: 2 } },
    { summary: { directories: 1 } }, { summary: { unresolvedPaths: -1 } },
    { summary: { corruptRecords: '0' } }, { summary: { elapsedMs: -1 } },
    { summary: { logicalBytes: null } }, { summary: { recordSlots: 0.5 } },
    { summary: { memoryBytes: null } }
  ];
  for (const options of invalid) {
    await t.test(JSON.stringify(options), async sub => {
      const scanner = loadScanner(sub, scriptWriting(mftBinary({ files: [[0, 'one.txt', 8]], ...options })));
      await assert.rejects(scanner.scan('C:\\', () => {}), /Invalid MFT summary/);
      assert.equal(scanner.closed, true);
    });
  }
});

test('binary MFT bounds its trailing summary and terminates a still-running helper', { timeout: 10000 }, async t => {
  const data = mftBinary({ rawSummary: '' });
  const scanner = loadScanner(t, scriptWriting(data, {
    tail: "process.stdout.write(' '.repeat(65537));setInterval(() => {}, 1000);"
  }));
  await assert.rejects(scanner.scan('C:\\', () => {}), /MFT summary exceeds/);
  assert.equal(scanner.closed, true);
});

test('binary MFT rejects unsafe path components rather than publishing invalid paths', async t => {
  for (const name of ['', '.', '..', '..\\outside.txt', 'other/path', 'C:drive', 'nul\u0000.txt']) {
    for (const type of ['file', 'folder']) {
      await t.test(`${type}: ${JSON.stringify(name)}`, async sub => {
        const options = type === 'file' ? { files: [[0, name, 1]] } : { folders: [[0, name]] };
        const scanner = loadScanner(sub, scriptWriting(mftBinary(options)));
        await assert.rejects(scanner.scan('C:\\', () => {}), /Invalid MFT name/);
        assert.equal(scanner.closed, true);
      });
    }
  }
});

test('binary MFT refuses invalid UTF-8, unknown flags and zero hard-link counts', async t => {
  for (const kind of ['utf8', 'flags', 'links', 'parent', 'date']) {
    await t.test(kind, async sub => {
      const data = mftBinary({ files: [[0, 'x.txt', 1]] });
      const start = 16;
      if (kind === 'utf8') data[start + 29] = 0xff;
      if (kind === 'flags') data[start + 26] = 0x80;
      if (kind === 'links') data.writeUInt16LE(0, start + 24);
      if (kind === 'parent') data.writeUInt32LE(1, start);
      if (kind === 'date') {
        data[start + 26] |= 2;
        data.writeBigInt64LE(8640000000000001n, start + 12);
      }
      const scanner = loadScanner(sub, scriptWriting(data));
      await assert.rejects(scanner.scan('C:\\', () => {}), /Invalid MFT|folder is missing/);
      assert.equal(scanner.closed, true);
    });
  }
});

test('binary MFT preserves signed timestamps and deduplicated totals across deep folders', async t => {
  const dates = [-11644473600000, -1, 0, 1600000000123, 253402300799999];
  const folders = Array.from({ length: 50 }, (_, index) => [index, `folder-${index}`]);
  const files = dates.map((date, index) => [50, `file-${index}.txt`, index + 1, date]);
  files.push([1, 'alias.txt', 5, dates[4], 0, 2, false]);
  const scanner = loadScanner(t, scriptWriting(mftBinary({ folders, files })));
  const result = await scanner.scan('C:\\', () => {});
  assert.equal(result.totalSizeBytes, 15);
  assert.equal(result.fileCount, 6);
  assert.equal(result.folderCount, 50);
  assert.deepEqual(Array.from(result.fileNodes.slice(0, 5), file => file.date),
    dates.map(date => new Date(date).toISOString()));
  for (let index = 1; index < 50; index++) {
    assert.equal(result.folderNodes[index].rawSize, 15);
    assert.equal(result.folderNodes[index].parentFolderId, index - 1);
  }
});

function largeBinaryScript(tail = '') {
  return `
    const writeUInt64LE = ${writeUInt64LE.toString()};
    const mftBinary = ${mftBinary.toString()};
    const folders = [[0, 'skip'], [0, 'keep'],
      ...Array.from({length:6000}, (_,index) => [index%2 ? 2 : 1, 'folder-'+index])];
    const files = Array.from({length:24000},
      (_,index) => [3+index%6000, 'file-'+index+'.txt', index%17, 0]);
    process.stdout.write(mftBinary({folders, files}));
    ${tail}
  `;
}

test('large binary MFT import yields and keeps compact folder IDs correct after exclusions', { timeout: 15000 }, async t => {
  const scanner = loadScanner(t, largeBinaryScript());
  const result = await scanner.scan('C:\\', () => {}, { excludeFolderNames: ['skip'] });
  assert.equal(result.fileCount, 12000);
  assert.equal(result.folderCount, 3001);
  assert.equal(result.excludedFolderCount, 1);
  let expectedBytes = 0;
  for (let index = 1; index < 24000; index += 2) expectedBytes += index % 17;
  assert.equal(result.totalSizeBytes, expectedBytes);
  assert.equal(result.filesByType.txt, 12000);
  assert(scanner.yieldCount >= 4, 'large import and finalization must yield cooperatively');
  for (const file of result.fileNodes) {
    const parent = result.folderNodes[file.parentFolderId];
    assert.equal(file.path, parent.path + '\\' + file.name);
    assert(file.path.startsWith('C:\\keep\\'));
  }
});

test('cancelling inside binary import drains and closes its still-running helper', { timeout: 10000 }, async t => {
  const controller = new AbortController();
  const scanner = loadScanner(t, largeBinaryScript('setInterval(() => {}, 1000);'),
    false, 0, () => controller.abort());
  await assert.rejects(scanner.scan('C:\\', () => {}, {}, false, controller.signal), { name: 'AbortError' });
  assert(scanner.yieldCount > 0, 'must cancel from an actual importer event-loop yield');
  assert.equal(scanner.closed, true);
});
