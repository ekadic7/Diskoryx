const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EXIT, parseArgs, runCli } = require('../src/main/cli');

function capture() {
  const out = [];
  const err = [];
  return {
    stdout: { write: (text) => out.push(text) },
    stderr: { write: (text) => err.push(text) },
    out: () => out.join(''),
    err: () => err.join('')
  };
}

test('parseArgs accepts scan, csv and force, and rejects missing or unknown arguments', () => {
  assert.deepEqual(parseArgs(['scan', 'C:\\data', '--csv', 'out.csv', '--force']), { folder: 'C:\\data', csv: 'out.csv', force: true, help: false });
  assert.throws(() => parseArgs(['scan', 'C:\\data']), /--csv/);
  assert.throws(() => parseArgs(['scan', '--csv', 'out.csv']), /folder path/);
  assert.throws(() => parseArgs(['scan', 'a', 'b', '--csv', 'x.csv']), /Unexpected argument/);
  assert.throws(() => parseArgs(['scan', 'a', '--csv', 'x.csv', '--delete']), /Unknown option/);
  assert.throws(() => parseArgs(['scan', 'a', '--csv']), /requires a file path/);
});

test('help prints usage and exits 0 without scanning', async () => {
  const io = capture();
  assert.equal(await runCli(['--help'], io), EXIT.OK);
  assert.match(io.out(), /Usage: diskoryx-cli scan/);
  assert.equal(io.err(), '');
});

test('invalid arguments exit with usage code and diagnostics on stderr only', async () => {
  const io = capture();
  assert.equal(await runCli(['scan'], io), EXIT.USAGE);
  assert.equal(io.out(), '');
  assert.match(io.err(), /Error: A folder path is required/);
});

test('scan writes a BOM CSV with a JSON summary and refuses to overwrite without --force', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diskoryx cli ünï '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source folder');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'a.txt'), '12345');
  const csv = path.join(dir, 'out ünï.csv');

  const first = capture();
  assert.equal(await runCli(['scan', source, '--csv', csv], first), EXIT.OK);
  const summary = JSON.parse(first.out());
  assert.equal(summary.ok, true);
  assert.equal(summary.fileCount, 1);
  assert.equal(summary.totalSizeBytes, 5);
  const text = await fs.readFile(csv, 'utf8');
  assert.equal(text.charCodeAt(0), 0xfeff);
  assert.match(text, /"a\.txt"/);

  const second = capture();
  assert.equal(await runCli(['scan', source, '--csv', csv], second), EXIT.OUTPUT_EXISTS);
  assert.match(second.err(), /already exists/);
  assert.equal(await fs.readFile(csv, 'utf8'), text);

  assert.equal(await runCli(['scan', source, '--csv', csv, '--force'], capture()), EXIT.OK);
});

test('missing folder and missing output directory report distinct exit codes', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diskoryx-cli-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const missing = capture();
  assert.equal(await runCli(['scan', path.join(dir, 'nope'), '--csv', path.join(dir, 'x.csv')], missing), EXIT.SCAN_FAILED);
  assert.match(missing.err(), /Error:/);
  const noDir = capture();
  assert.equal(await runCli(['scan', dir, '--csv', path.join(dir, 'no-such', 'x.csv')], noDir), EXIT.WRITE_FAILED);
  await fs.access(path.join(dir, 'no-such')).then(() => assert.fail('must not create folders'), () => {});
});

test('an aborted export leaves no CSV and no partial file', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diskoryx-cli-cancel-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'src');
  await fs.mkdir(source);
  await Promise.all(Array.from({ length: 50 }, (_, i) => fs.writeFile(path.join(source, `${i}.txt`), 'x')));
  const csv = path.join(dir, 'cancel.csv');
  const controller = new AbortController();
  controller.abort();
  const io = capture();
  assert.equal(await runCli(['scan', source, '--csv', csv], { ...io, signal: controller.signal }), EXIT.CANCELLED);
  assert.match(io.err(), /Cancelled/);
  const entries = await fs.readdir(dir);
  assert.deepEqual(entries.filter(name => name.includes('cancel')), []);
});
