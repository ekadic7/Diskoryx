const assert = require('node:assert/strict');
const test = require('node:test');
const { parseSearchQuery } = require('../src/main/search-query');
const SearchFilters = require('../src/renderer/search-filters');

const files = [
  { name: 'report.pdf', rawSize: 5 * 1024 ** 2, date: '2025-06-01T10:00:00.000Z' },
  { name: 'report-old.pdf', rawSize: 100, date: '2023-01-01T10:00:00.000Z' },
  { name: 'photo.jpg', rawSize: 20 * 1024 ** 2, date: '2026-02-01T10:00:00.000Z' },
  { name: 'notes.txt', rawSize: 10, date: null }
];

function names(query) {
  const parsed = parseSearchQuery(query);
  assert.equal(parsed.error, undefined, parsed.error);
  return files.filter(parsed.matches).map(file => file.name);
}

test('builds only tokens the parser accepts', () => {
  assert.equal(SearchFilters.buildFilterToken('size', '>', '10', 'MB'), 'size:>10MB');
  assert.equal(SearchFilters.buildFilterToken('size', '<=', '1.5', 'GB'), 'size:<=1.5GB');
  assert.equal(SearchFilters.buildFilterToken('modified', '>=', '2025-01-01'), 'modified:>=2025-01-01');
  assert.equal(SearchFilters.buildFilterToken('size', '>', 'big', 'MB'), null);
  assert.equal(SearchFilters.buildFilterToken('size', '>', '10', 'MBS'), null);
  assert.equal(SearchFilters.buildFilterToken('modified', '>', '2025-1-1'), null);
  assert.equal(SearchFilters.buildFilterToken('size', '=', '10', 'MB'), null);
});

test('appends a filter after the user text and keeps the text unchanged', () => {
  assert.equal(SearchFilters.appendFilter('report', 'size:>10MB'), 'report size:>10MB');
  assert.equal(SearchFilters.appendFilter('  ', 'size:>10MB'), 'size:>10MB');
  assert.equal(SearchFilters.appendFilter('a OR b', 'size:>1MB'), 'a OR b size:>1MB');
});

test('a combined query matches the same files as the parser would for typed text', () => {
  const query = SearchFilters.appendFilter('report', SearchFilters.buildFilterToken('size', '>', '1', 'MB'));
  assert.deepEqual(names(query), ['report.pdf']);
  assert.deepEqual(names(SearchFilters.appendFilter('photo OR notes', 'modified:>=2025-01-01')), ['photo.jpg']);
  assert.deepEqual(names(SearchFilters.appendFilter('report NOT old', 'size:>1MB')), ['report.pdf']);
});

test('lists only standalone filter tokens and labels them', () => {
  const filters = SearchFilters.listFilters('report NOT size:>10MB modified:>=2025-01-01');
  assert.deepEqual(filters.map(filter => filter.index), [2, 3]);
  assert.equal(filters[0].label, 'Size > 10MB');
  assert.equal(filters[1].label, 'Modified >= 2025-01-01');
  assert.deepEqual(SearchFilters.listFilters('report size:>big'), []);
});

test('removing a chip removes only that condition and an attached NOT', () => {
  assert.equal(SearchFilters.removeFilterAt('report size:>10MB modified:>=2025-01-01', 1), 'report modified:>=2025-01-01');
  assert.equal(SearchFilters.removeFilterAt('report NOT size:>10MB photo', 2), 'report photo');
  assert.equal(SearchFilters.removeFilterAt('report NOT photo', 2), 'report NOT photo');
});

test('removal leaves typed text and invalid filters untouched', () => {
  assert.equal(SearchFilters.removeFilterAt('report size:>big', 1), 'report size:>big');
  assert.equal(SearchFilters.removeFilterAt('report', 5), 'report');
});

test('old queries without the panel still parse as before', () => {
  assert.deepEqual(names('REPORT'), ['report.pdf', 'report-old.pdf']);
  assert.deepEqual(names('size:>10MB'), ['photo.jpg']);
  assert.match(parseSearchQuery('size:>veliko').error, /Invalid size filter/);
});
