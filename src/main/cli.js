const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { scanFolder } = require('./scanner');
const { iterateScanTree, serializeCsvHeader, serializeCsvRow } = require('./csv-export');

const EXIT = { OK: 0, USAGE: 2, SCAN_FAILED: 3, OUTPUT_EXISTS: 4, WRITE_FAILED: 5, CANCELLED: 130 };

const USAGE = `Usage: diskoryx-cli scan <folder> --csv <output.csv> [--force]

Read-only scan of a folder with CSV export. Nothing is deleted, moved or changed.

Options:
  --csv <file>   Write the scan tree to this CSV file (required).
  --force        Replace the output file if it already exists.
  --help         Show this help.

Exit codes: 0 success, 2 invalid arguments, 3 scan failed, 4 output exists,
            5 write failed, 130 cancelled with Ctrl+C.
Diagnostics are written to stderr; progress is never printed to stdout.
Without --force, output publication requires a filesystem supporting hard links;
unsupported filesystems fail with exit 5 rather than risk overwriting a file.
The command makes no network requests.`;

function parseArgs(argv) {
  const options = { folder: null, csv: null, force: false, help: false };
  const args = [...argv];
  if (args[0] === 'scan') args.shift();
  while (args.length) {
    const arg = args.shift();
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--csv') {
      if (!args.length || args[0].startsWith('--')) throw new Error('--csv requires a file path.');
      options.csv = args.shift();
    } else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    else if (options.folder === null) options.folder = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (options.help) return options;
  if (!options.folder) throw new Error('A folder path is required.');
  if (!options.csv) throw new Error('--csv <output.csv> is required.');
  return options;
}

async function writeCsvAtomically(scan, outputPath, force, signal) {
  const resolved = path.resolve(outputPath);
  const directory = path.dirname(resolved);
  const stat = await fsp.stat(directory).catch(() => null);
  if (!stat || !stat.isDirectory()) throw Object.assign(new Error(`Output folder does not exist: ${directory}`), { exitCode: EXIT.WRITE_FAILED });
  if (!force && fs.existsSync(resolved)) {
    throw Object.assign(new Error(`Output file already exists: ${resolved} (use --force to replace it)`), { exitCode: EXIT.OUTPUT_EXISTS });
  }

  const temporary = `${resolved}.${process.pid}.${Date.now()}.partial`;
  const handle = await fsp.open(temporary, 'wx');
  try {
    const chunks = [`\uFEFF${serializeCsvHeader()}`];
    let buffered = 0;
    const flush = async () => {
      if (!chunks.length) return;
      const text = chunks.join('');
      chunks.length = 0;
      buffered = 0;
      await handle.writeFile(text, 'utf8');
    };
    for (const item of iterateScanTree(scan)) {
      signal?.throwIfAborted();
      const row = serializeCsvRow(item);
      chunks.push(row);
      buffered += row.length;
      if (buffered > 1 << 20) await flush();
    }
    await flush();
    await handle.close();
    signal?.throwIfAborted();
    if (force) {
      await fsp.rename(temporary, resolved);
    } else {
      // A hard link publishes the complete file atomically without replacing a
      // destination created since the precheck. Unsupported filesystems fail closed.
      try {
        await fsp.link(temporary, resolved);
      } catch (error) {
        if (error.code === 'EEXIST') {
          throw Object.assign(new Error(`Output file already exists: ${resolved} (use --force to replace it)`), { exitCode: EXIT.OUTPUT_EXISTS });
        }
        throw error;
      }
      await fsp.unlink(temporary);
    }
  } catch (error) {
    await handle.close().catch(() => {});
    await fsp.rm(temporary, { force: true }).catch(() => {});
    if (error.name === 'AbortError') throw error;
    throw Object.assign(error, { exitCode: error.exitCode || EXIT.WRITE_FAILED });
  }
  return resolved;
}

async function runCli(argv, { stdout = process.stdout, stderr = process.stderr, signal } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr.write(`Error: ${error.message}\n\n${USAGE}\n`);
    return EXIT.USAGE;
  }
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return EXIT.OK;
  }

  const controller = new AbortController();
  const onSigint = () => controller.abort();
  const abortSignal = signal ?? controller.signal;
  process.once('SIGINT', onSigint);
  try {
    const scan = await scanFolder(options.folder, () => {}, {}, abortSignal);
    if (!scan.success) {
      stderr.write(`Error: ${scan.error}\n`);
      return EXIT.SCAN_FAILED;
    }
    if (scan.skippedCount) stderr.write(`Warning: ${scan.skippedCount} entries could not be read and were skipped.\n`);
    const written = await writeCsvAtomically(scan, options.csv, options.force, abortSignal);
    stdout.write(`${JSON.stringify({ ok: true, folder: scan.folderPath, csv: written, fileCount: scan.fileCount, folderCount: scan.folderCount, totalSizeBytes: scan.totalSizeBytes, skippedCount: scan.skippedCount })}\n`);
    return EXIT.OK;
  } catch (error) {
    if (error.name === 'AbortError') {
      stderr.write('Cancelled. No output file was written.\n');
      return EXIT.CANCELLED;
    }
    stderr.write(`Error: ${error.message}\n`);
    return error.exitCode || EXIT.SCAN_FAILED;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

if (require.main === module) {
  runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { EXIT, parseArgs, runCli, writeCsvAtomically };
