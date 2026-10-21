const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const { PAGE_BYTES, readTextPage, supportsTextPreview } = require('../src/main/text-preview');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diskoryx-preview-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('common text, config and extensionless names are supported; executables are not', () => {
  for (const name of ['a.TXT', 'app.log', 'settings.json', 'a.yaml', 'a.ini', 'a.config', 'a.toml', '.env', '.env.local', '.gitignore', 'Dockerfile', 'a.csv', 'a.xml']) {
    assert(supportsTextPreview(name), name);
  }
  for (const name of ['a.exe', 'a.dll', 'a.png', 'a.pdf', 'app.log.exe']) assert(!supportsTextPreview(name));
});

test('numbered logs and additional text formats are supported without allowing binary suffixes', () => {
  for (const name of [
    'log', 'log1', 'log.1', 'app.log1', 'app.log.1', 'app.LOG.123',
    'index.html', 'index.HTM', 'page.xhtml', 'style.css', 'style.scss',
    'style.sass', 'style.less', 'app.js', 'app.mjs', 'app.cjs', 'app.jsx',
    'app.ts', 'app.tsx', 'app.vue', 'app.svelte', 'query.sql', 'run.sh',
    'run.bash', 'run.ps1', 'module.psm1', 'module.psd1', 'run.bat', 'run.cmd',
    'app.py', 'app.rb', 'app.php', 'App.java', 'app.c', 'app.h', 'app.cpp',
    'app.hpp', 'app.cs', 'app.rs', 'app.go', 'app.swift', 'app.kt',
    'app.kts', 'app.lua'
  ]) assert(supportsTextPreview(name), name);
  for (const name of [
    'catalog1', 'app.log.old', 'app.log.1.gz', 'app.log1.exe',
    'app.log.1.dll', 'page.html.exe', 'app.dll', 'app.exe'
  ]) assert(!supportsTextPreview(name), name);
});

test('numbered logs retain complete paging and reject binary content', async t => {
  const root = await fixture(t);
  const text = 'a'.repeat(PAGE_BYTES - 1) + '\ud83d\ude03' + '\r\nEND';
  for (const name of ['log1', 'app.log1', 'app.log.1']) {
    const file = path.join(root, name);
    await fs.writeFile(file, text);
    const first = await readTextPage(file, root);
    const last = await readTextPage(file, root, 1, first.revision);
    assert.equal(first.pageCount, 2);
    assert.equal(first.text + last.text, text);
    await fs.writeFile(file, Buffer.from([65, 0, 66]));
    await assert.rejects(readTextPage(file, root), /binary|encoding/);
  }
});

test('HTML and script source are returned literally without loading referenced resources', async t => {
  const root = await fixture(t);
  for (const name of ['index.html', 'page.htm', 'page.xhtml', 'app.js', 'run.ps1']) {
    const file = path.join(root, name);
    const text = '<script>throw new Error("must not execute")</script>\r\n' +
      '<img src="https://example.invalid/image.png"><iframe src="file:///C:/private.txt"></iframe>';
    await fs.writeFile(file, text);
    assert.equal((await readTextPage(file, root)).text, text);
  }
});

test('small and empty files are shown completely; HTML remains plain text', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'settings.txt');
  const text = '<script>alert("not executed")</script>\r\nhello \u017e\u4f60\ud83d\ude03';
  await fs.writeFile(file, text);
  const result = await readTextPage(file, root);
  assert.equal(result.text, text);
  assert.equal(result.pageCount, 1);
  assert.equal(result.fileSize, Buffer.byteLength(text));
  await fs.writeFile(file, '');
  const empty = await readTextPage(file, root);
  assert.equal(empty.text, '');
  assert.equal(empty.pageCount, 1);
  assert.equal(empty.endByte, 0);
});

test('all UTF-8 pages reassemble the entire log without lost or duplicate multibyte characters', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'large.log');
  const text = 'a'.repeat(PAGE_BYTES - 1) + '\ud83d\ude03' + '\u4f60\u017e\r\n'.repeat(15000) + 'LAST LINE';
  await fs.writeFile(file, text);
  const first = await readTextPage(file, root);
  assert(first.pageCount > 2);
  let combined = first.text;
  let previousEnd = first.endByte;
  for (let page = 1; page < first.pageCount; page++) {
    const result = await readTextPage(file, root, page, first.revision);
    assert.equal(result.startByte, previousEnd);
    assert(Buffer.byteLength(result.text) <= PAGE_BYTES + 3);
    combined += result.text;
    previousEnd = result.endByte;
  }
  assert.equal(combined, text);
  assert.equal(previousEnd, first.fileSize);
  assert((await readTextPage(file, root, first.pageCount - 1)).text.endsWith('LAST LINE'));
});

test('UTF-8 BOM and UTF-16 LE/BE pages preserve surrogate pairs across page boundaries', async t => {
  const root = await fixture(t);
  const utf8 = path.join(root, 'utf8.txt');
  await fs.writeFile(utf8, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello')]));
  assert.equal((await readTextPage(utf8, root)).text, 'hello');
  for (const bigEndian of [false, true]) {
    const file = path.join(root, bigEndian ? 'be.log' : 'le.log');
    const text = 'a'.repeat(PAGE_BYTES / 2 - 1) + '\ud83d\ude03' + 'z'.repeat(PAGE_BYTES) + 'END';
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    if (bigEndian) bytes.swap16();
    await fs.writeFile(file, bytes);
    const first = await readTextPage(file, root);
    let combined = '';
    let end = 2;
    for (let page = 0; page < first.pageCount; page++) {
      const result = await readTextPage(file, root, page, first.revision);
      assert.equal(result.startByte, end);
      end = result.endByte;
      combined += result.text;
    }
    assert.equal(combined, text);
    assert.equal(end, bytes.length);
  }
});

test('binary data, invalid encoding, unsupported extensions and invalid pages fail explicitly', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'data.log');
  for (const bytes of [Buffer.from([65, 0, 66]), Buffer.from([0xff, 0xff, 65])]) {
    await fs.writeFile(file, bytes);
    await assert.rejects(readTextPage(file, root), /binary|encoding/);
  }
  await fs.writeFile(file, 'okay');
  for (const page of [-1, 1.1, NaN, '1']) await assert.rejects(readTextPage(file, root, page), /valid page/);
  await assert.rejects(readTextPage(file, root, 1), /out of range/);
  await assert.rejects(readTextPage(path.join(root, 'app.exe'), root), /text, log/);
  await assert.rejects(readTextPage(root, root), /text, log|outside/);
});

test('changed, replaced and deleted files cannot silently continue an old preview', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'change.log');
  await fs.writeFile(file, 'a'.repeat(PAGE_BYTES + 5));
  const first = await readTextPage(file, root);
  await fs.appendFile(file, 'appended line');
  await assert.rejects(readTextPage(file, root, 1, first.revision), /changed/);
  const fresh = await readTextPage(file, root);
  assert.notEqual(fresh.revision, first.revision);
  await fs.unlink(file);
  await assert.rejects(readTextPage(file, root), /ENOENT/);
});

test('paths outside the scanned root and links are rejected', async t => {
  const root = await fixture(t);
  const selected = path.join(root, 'selected');
  await fs.mkdir(selected);
  const outside = path.join(root, 'outside.txt');
  await fs.writeFile(outside, 'outside');
  await assert.rejects(readTextPage(outside, selected), /outside/);
  const junction = path.join(selected, 'escape');
  await fs.symlink(root, junction, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readTextPage(path.join(junction, 'outside.txt'), selected), /outside/);
  await fs.unlink(junction);
});

test('last-page navigation in a large sparse log reads only a bounded page', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'huge.log');
  const handle = await fs.open(file, 'w');
  const size = 128 * 1024 * 1024 + 7;
  try {
    await handle.write(Buffer.from('start\n'), 0, 6, 0);
    await handle.write(Buffer.from('a'.repeat(PAGE_BYTES)), 0, PAGE_BYTES, 0);
    await handle.write(Buffer.from('THE END'), 0, 7, size - 7);
  } finally {
    await handle.close();
  }
  const lastPage = Math.ceil(size / PAGE_BYTES) - 1;
  const result = await readTextPage(file, root, lastPage);
  assert.equal(result.text, 'THE END');
  assert.equal(result.endByte, size);
  assert.equal(result.text.length, 7);
});
