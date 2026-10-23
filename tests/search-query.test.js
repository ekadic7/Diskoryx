const assert = require('node:assert/strict');
const test = require('node:test');
const { parseSearchQuery } = require('../src/main/search-query');

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

test('plain words match a substring of the file name, case-insensitively', () => {
  assert.deepEqual(names('REPORT'), ['report.pdf', 'report-old.pdf']);
});

test('* and ? match the whole file name', () => {
  assert.deepEqual(names('report*.pdf'), ['report.pdf', 'report-old.pdf']);
  assert.deepEqual(names('photo.jp?'), ['photo.jpg']);
  assert.deepEqual(names('report.pd?'), ['report.pdf']);
});

test('regular expression characters in a term are literal', () => {
  assert.deepEqual(names('(report)'), []);
});

test('size filters compare raw byte sizes with units', () => {
  assert.deepEqual(names('size:>10MB'), ['photo.jpg']);
  assert.deepEqual(names('size:<=1KB'), ['report-old.pdf', 'notes.txt']);
});

test('modified filters compare dates and exclude files without a date', () => {
  assert.deepEqual(names('modified:>=2025-01-01'), ['report.pdf', 'photo.jpg']);
  assert.deepEqual(names('modified:<2025-01-01'), ['report-old.pdf']);
});

test('terms are combined with AND by default and OR splits alternatives', () => {
  assert.deepEqual(names('report size:>1MB'), ['report.pdf']);
  assert.deepEqual(names('photo OR notes'), ['photo.jpg', 'notes.txt']);
  assert.deepEqual(names('report AND size:<1KB'), ['report-old.pdf']);
});

test('NOT excludes the next term', () => {
  assert.deepEqual(names('report NOT old'), ['report.pdf']);
  assert.deepEqual(names('NOT report.pdf OR photo.jpg'), ['report-old.pdf', 'photo.jpg', 'notes.txt']);
});

test('empty input is reported as empty, not as an error', () => {
  assert.deepEqual(parseSearchQuery('   '), { empty: true });
});

test('invalid syntax returns a clear error', () => {
  assert.match(parseSearchQuery('size:>big').error, /Invalid size filter/);
  assert.match(parseSearchQuery('modified:>yesterday').error, /Invalid modified filter/);
  assert.match(parseSearchQuery('OR photo').error, /OR needs/);
  assert.match(parseSearchQuery('photo OR').error, /OR needs/);
  assert.match(parseSearchQuery('photo NOT').error, /NOT needs/);
  assert.match(parseSearchQuery('NOT NOT photo').error, /NOT cannot/);
});
