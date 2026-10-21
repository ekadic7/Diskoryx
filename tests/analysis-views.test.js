const assert = require('node:assert/strict');
const test = require('node:test');
const { getAnalysisPage } = require('../src/main/analysis-views');
const { sortItemList } = require('../src/main/tree-sort');

function scan() {
  return {
    fileNodes: Array.from({ length: 250 }, (_, index) => ({
      name: `file-${index}`, path: `C:\\sample\\file-${index}`, rawSize: index,
      type: 'file', extension: index % 2 ? 'txt' : 'log', date: '2026-10-20',
      sizeOwner: index !== 249, aggregateSize: index === 249 ? 0 : index
    }))
  };
}
test('largest view pages every file by logical size, including aliases without inflating totals', async () => {
  const source = scan();
  const first = await getAnalysisPage(source);
  assert.equal(first.totalCount, 250);
  assert.equal(first.items.length, 100);
  assert.equal(first.items[0].rawSize, 249);
  assert.equal(first.items[0].countedSize, 0);
  const next = await getAnalysisPage(source, { offset: 100 });
  assert.equal(next.items[0].rawSize, 149);
  const last = await getAnalysisPage(source, { offset: 200 });
  assert.equal(last.items.length, 50);
  assert.equal(last.items.at(-1).rawSize, 0);
  assert.equal(source.fileNodes[0].rawSize, 0, 'must not sort snapshot in place');
});
test('file types use counted bytes, correct counts, percentages and largest logical alias size', async () => {
  const result = await getAnalysisPage(scan(), { view: 'types' });
  assert.equal(result.items.length, 2);
  assert.equal(result.totalBytes, 250 * 249 / 2 - 249);
  assert.equal(result.items.reduce((n, item) => n + item.count, 0), 250);
  assert.equal(result.items.reduce((n, item) => n + item.percent, 0), 100);
  assert.equal(result.items.find(item => item.extension === 'txt').largestBytes, 249);
});
test('analysis filters intersect scan filters, query, minimum and extension drilldown', async () => {
  const result = await getAnalysisPage(scan(), {
    extension: 'txt', minBytes: 200, query: 'file-24', scanFilters: { excludeExtensions: ['log'] }
  });
  assert.deepEqual(result.items.map(item => item.rawSize), [249, 247, 245, 243, 241]);
  const empty = await getAnalysisPage(scan(), { extension: 'txt', scanFilters: { excludeExtensions: ['txt'] } });
  assert.equal(empty.totalCount, 0);
});
test('invalid analysis requests fail explicitly', async () => {
  for (const options of [null, [], { view: 'unknown' }, { order: 'arbitrary' }, { offset: -1 },
    { minBytes: NaN }, { query: {} }, { extension: null }]) {
    await assert.rejects(getAnalysisPage(scan(), options));
  }
});

test('paging reuses one derived index while changed filters or a new revision cache rebuild it', async () => {
  const source = scan();
  const cache = {};
  await getAnalysisPage(source, {}, cache);
  const sorted = cache.value.sorted;
  await getAnalysisPage(source, { offset: 100 }, cache);
  assert.equal(cache.value.sorted, sorted);
  const filtered = await getAnalysisPage(source, { extension: 'txt' }, cache);
  assert.notEqual(cache.value.sorted, sorted);
  assert.equal(filtered.totalCount, 125);
  source.fileNodes.pop();
  const updated = await getAnalysisPage(source, {}, {});
  assert.equal(updated.totalCount, 249);
});

test('blocked analysis sort preserves stable size/name/date ties across blocks and matches existing ordering', async () => {
  const source = {
    fileNodes: Array.from({ length: 17001 }, (_, index) => ({
      type: 'file', name: `Name-${index % 317}`, rawSize: index % 13,
      date: index % 5 ? `2026-01-${String(index % 28 + 1).padStart(2, '0')}` : '',
      extension: 'txt', path: `C:\\sample\\${index}`
    }))
  };
  for (const order of ['size', 'name', 'date']) {
    const expected = await sortItemList(source.fileNodes, order);
    const cache = {};
    const first = await getAnalysisPage(source, { order }, cache);
    assert.deepEqual(cache.value.sorted, expected);
    assert.deepEqual(first.items.map(item => item.path), expected.slice(0, 100).map(item => item.path));
  }
});

test('million-file Largest Files completes within five seconds while yielding to the event loop', async () => {
  let seed = 1;
  const source = { fileNodes: Array.from({ length: 1000000 }, (_, index) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return { type: 'file', name: `file-${index}`, rawSize: seed, extension: 'txt', path: `C:\\sample\\${index}` };
  }) };
  let yielded = false;
  setImmediate(() => { yielded = true; });
  const start = performance.now();
  const result = await getAnalysisPage(source);
  const elapsed = performance.now() - start;
  assert.equal(yielded, true);
  assert.equal(result.totalCount, 1000000);
  assert.equal(result.items.length, 100);
  assert.ok(result.items.every((item, index, items) => index === 0 || items[index - 1].rawSize >= item.rawSize));
  assert.ok(elapsed < 5000, `Largest Files took ${elapsed.toFixed(0)} ms; expected less than 5000 ms.`);
});
