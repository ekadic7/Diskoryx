const assert = require('node:assert/strict');
const test = require('node:test');
const {
  checkSourceIdentity, compareScans, filtersMatch, pageChanges
} = require('../src/main/scan-compare');

function file(path, rawSize, options = {}) {
  return { path, rawSize, date: options.date ?? '2026-01-01T00:00:00.000Z', hardLinkCount: options.links ?? 1 };
}

function scan(files, options = {}) {
  return {
    fileNodes: files,
    totalSizeBytes: files.reduce((total, item) => total + item.rawSize, 0),
    scanStartedAt: options.scanStartedAt ?? Date.parse('2026-02-01T00:00:00.000Z'),
    archive: options.archive,
    scanFilters: options.scanFilters ?? {}
  };
}

test('identical snapshots report no differences', async () => {
  const files = [file('C:\\a.txt', 10), file('C:\\b.txt', 20)];
  const diff = await compareScans(scan(files), scan(files.map(item => ({ ...item }))));
  assert.equal(diff.identical, true);
  assert.deepEqual(diff.counts, { added: 0, removed: 0, changed: 0 });
  assert.equal(diff.deltaBytes, 0);
});

test('classifies added, removed and changed files with deltas and hard-link counts', async () => {
  const before = scan([file('C:\\keep.txt', 10), file('C:\\gone.txt', 40), file('C:\\grow.txt', 5, { links: 2 })]);
  const after = scan([file('C:\\keep.txt', 10), file('C:\\new.txt', 7), file('C:\\grow.txt', 25, { links: 2 })]);
  const diff = await compareScans(before, after);
  assert.deepEqual(diff.counts, { added: 1, removed: 1, changed: 1 });
  assert.equal(diff.lists.added[0].deltaBytes, 7);
  assert.equal(diff.lists.removed[0].deltaBytes, -40);
  assert.equal(diff.lists.changed[0].deltaBytes, 20);
  assert.equal(diff.netAddedBytes, 7);
  assert.equal(diff.netRemovedBytes, -40);
  assert.equal(diff.hardLinks.changed, 1);
  assert.equal(diff.deltaBytes, 42 - 55);
});

test('paging keeps every difference: more than 500 changes are all reachable', async () => {
  const before = [];
  const after = [];
  for (let index = 0; index < 1200; index++) {
    after.push(file(`C:\\bulk\\file-${String(index).padStart(4, '0')}.bin`, 1));
  }
  const diff = await compareScans(scan(before), scan(after));
  assert.equal(diff.counts.added, 1200);
  assert.equal(diff.netAddedBytes, 1200);
  const seen = new Set();
  for (let offset = 0; offset < 1200; offset += 500) {
    const page = pageChanges(diff, 'added', { offset, limit: 500 });
    assert.equal(page.totalCount, 1200);
    for (const row of page.rows) seen.add(row.path);
  }
  assert.equal(seen.size, 1200);
});

test('search and sort run over the complete list, not a prefix', async () => {
  const after = [];
  for (let index = 0; index < 600; index++) after.push(file(`C:\\d\\f${index}.txt`, index));
  after.push(file('C:\\d\\needle.log', 999999));
  const diff = await compareScans(scan([]), scan(after));
  const found = pageChanges(diff, 'added', { query: 'needle' });
  assert.equal(found.totalCount, 1);
  const bySize = pageChanges(diff, 'added', { sortBy: 'size', limit: 1 });
  assert.equal(bySize.rows[0].path, 'C:\\d\\needle.log');
});

test('pageChanges rejects unknown lists and clamps the page size', async () => {
  const diff = await compareScans(scan([]), scan([file('C:\\x', 1)]));
  assert.throws(() => pageChanges(diff, 'bogus'), /Choose Added, Removed or Changed/);
  assert.equal(pageChanges(diff, 'added', { limit: 100000 }).limit, 500);
});

test('identity: matching volumes verified, different volumes refused, missing identity unverified', () => {
  assert.deepEqual(checkSourceIdentity(111, 111), { ok: true, verified: true });
  const refused = checkSourceIdentity(111, 222);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /different volume/);
  assert.deepEqual(checkSourceIdentity(null, 222), { ok: true, verified: false });
  assert.deepEqual(checkSourceIdentity(undefined, undefined), { ok: true, verified: false });
});

test('filters: content filters must match, order does not matter', () => {
  const a = { includeExtensions: ['.txt'], excludeExtensions: ['.tmp'], excludeFolderNames: ['node_modules', 'cache'] };
  const b = { includeExtensions: ['.txt'], excludeExtensions: ['.tmp'], excludeFolderNames: ['cache', 'node_modules'] };
  assert.equal(filtersMatch(a, b), true);
  assert.equal(filtersMatch(a, { ...b, excludeFolderNames: ['cache'] }), false);
});

test('cancellation during a large comparison throws and returns no result', async () => {
  const controller = new AbortController();
  const many = [];
  for (let index = 0; index < 20000; index++) many.push(file(`C:\\big\\${index}`, 1));
  const pending = compareScans(scan([]), scan(many), { signal: controller.signal });
  controller.abort(new Error('cancelled by user'));
  await assert.rejects(pending, /cancelled by user/);
});
