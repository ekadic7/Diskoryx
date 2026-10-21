const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { createTreeBuilder } = require('../src/main/mft-scanner');
const { createTreeBuilder: baselineBuilder } = require('../tests/fixtures/baseline/mft-scanner');

const count = Number(process.argv[2] || 250000);
if (!Number.isSafeInteger(count) || count < 1 || count > 1000000) {
  throw new Error('Pass a synthetic file count between 1 and 1000000.');
}

function record(index) {
  return {
    path: `C:\\fixture\\data\\cache\\resources\\compiled\\nested\\group-${Math.floor(index / 4)}\\file-${index}.${index % 2 ? 'txt' : 'log'}`,
    size: index % 65536, sizeOwner: index % 11 !== 0, hardLinkCount: index % 11 === 0 ? 2 : 1,
    isDirectory: false, modifiedMs: 1600000000000 + index
  };
}

async function measure(build, label) {
  global.gc?.();
  const builder = build('C:\\', {});
  const start = performance.now();
  for (let index = 0; index < count; index++) {
    const file = record(index);
    builder.addRecord(file);
    if (index % 4 === 3 || index === count - 1) builder.addRecord({
      path: file.path.slice(0, file.path.lastIndexOf('\\')), isDirectory: true
    });
  }
  const imported = performance.now();
  const result = await builder.finish({}, 1);
  const finished = performance.now();
  assert.equal(result.fileCount, count);
  let counted = 0;
  for (let index = 0; index < count; index++) if (index % 11 !== 0) counted += index % 65536;
  assert.equal(result.totalSizeBytes, counted);
  return {
    implementation: label, files: count, folders: result.folderCount,
    countedBytes: result.totalSizeBytes,
    importMs: Math.round(imported - start), finalizeMs: Math.round(finished - imported),
    totalMs: Math.round(finished - start)
  };
}

(async () => {
  console.log('Synthetic JS indexing only; not native disk read, broker transfer, UI readiness or a real-drive speed claim.');
  const first = await measure(baselineBuilder, 'frozen-baseline');
  const second = await measure(createTreeBuilder, 'current');
  assert.equal(second.folders, first.folders);
  assert.equal(second.countedBytes, first.countedBytes);
  console.log(JSON.stringify([first, second], null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
