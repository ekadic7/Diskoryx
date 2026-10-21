const assert = require('node:assert/strict');
const test = require('node:test');
const { createTreeBuilder } = require('../src/main/mft-scanner');
const { prepareScanMutation } = require('../src/main/scan-mutations');
const { iterateScanTree } = require('../src/main/csv-export');

async function fixture() {
  const builder = createTreeBuilder('C:\\', {});
  for (const record of [
    { path: 'C:\\java\\README.txt', size: 100, sizeOwner: true, hardLinkCount: 2 },
    { path: 'C:\\alias.txt', size: 100, sizeOwner: false, hardLinkCount: 2 },
    { path: 'C:\\java\\nested\\config.json', size: 25 },
    { path: 'C:\\keep.log', size: 10 }
  ]) builder.addRecord({ ...record, modifiedMs: 0 });
  return builder.finish({}, 100);
}

test('prepared updates leave the snapshot intact until filesystem success and preserve MFT counted bytes', async () => {
  const scan = await fixture();
  const java = scan.folderNodes.find(folder => folder.name === 'java');
  const apply = await prepareScanMutation(scan, java);
  assert.equal(scan.totalSizeBytes, 135);
  assert.equal(scan.fileCount, 4);
  assert.equal(scan.folderCount, 2);
  apply();
  assert.equal(scan.totalSizeBytes, 10);
  assert.equal(scan.fileCount, 2);
  assert.equal(scan.folderCount, 0);
  assert.equal(scan.oldFilesCount, 2);
  assert.equal(scan.folderNodes[0].extensionStats.txt.totalSizeBytes, 0);
  assert.equal(scan.fileNodes.find(file => file.name === 'alias.txt').aggregateSize, 0);
  assert.deepEqual([...iterateScanTree(scan)].map(item => item.name).sort(), ['C:', 'alias.txt', 'keep.log']);
  assert(scan.largestFiles.every(file => !file.path.startsWith('C:\\java\\')));
});

test('file extension rename updates every ancestor and repeated deletes reach empty totals', async () => {
  const scan = await fixture();
  const config = scan.fileNodes.find(file => file.name === 'config.json');
  (await prepareScanMutation(scan, config, 'C:\\java\\nested\\config.txt'))();
  assert.equal(config.extension, 'txt');
  assert.equal(scan.filesByType.json, undefined);
  assert.equal(scan.filesByType.txt, 3);
  assert.equal(scan.folderNodes[0].extensionStats.txt.totalSizeBytes, 125);
  for (const folder of scan.folderNodes.filter(folder => folder?.name === 'nested')) {
    assert.equal(folder.extensionStats.json, undefined);
    assert.equal(folder.extensionStats.txt.fileCount, 1);
  }
  for (const file of [...scan.fileNodes]) (await prepareScanMutation(scan, file))();
  assert.equal(scan.fileCount, 0);
  assert.equal(scan.totalSizeBytes, 0);
  assert.equal(scan.oldFilesCount, 0);
  assert.deepEqual(scan.filesByType, {});
  const java = scan.folderNodes.find(folder => folder?.name === 'java');
  (await prepareScanMutation(scan, java))();
  assert.equal(scan.folderCount, 0);
  assert.equal(scan.folderNodes[0].children.length, 0);
});
