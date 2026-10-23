const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'diskoryx-smoke-'));
const archivePath = path.join(temporaryRoot, 'smoke-saved.diskoryxscan');
const captureProduct = process.argv.includes('--capture-product');
const captureDirectory = path.join(__dirname, '..', 'docs', 'screenshots');
if (captureProduct) fs.mkdirSync(captureDirectory, { recursive: true });

function runElectron(environment, timeout = 60000) {
  return spawnSync(require('electron'), [path.join(__dirname, 'electron-smoke.cjs')], {
    windowsHide: true,
    encoding: 'utf8',
    timeout,
    env: { ...environment, DISKORYX_SMOKE_ROOT: temporaryRoot }
  });
}

function report(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
}

let failed = false;
try {
  const first = runElectron({
    ...process.env,
    DISKORYX_SMOKE_REAL_RECYCLE: process.argv.includes('--real-recycle') ? '1' : '0',
    DISKORYX_SMOKE_MFT: process.argv.includes('--mft') ? '1' : '0',
    DISKORYX_SMOKE_MFT_REPEAT: process.argv.includes('--mft-repeat') ? '1' : '0',
    DISKORYX_SMOKE_LIVE: process.argv.includes('--live') || process.argv.includes('--live-pause') ? '1' : '0',
    DISKORYX_SMOKE_LIVE_PAUSE: process.argv.includes('--live-pause') ? '1' : '0',
    DISKORYX_SMOKE_PASTE_UI: process.argv.includes('--paste-ui') ? '1' : '0',
    DISKORYX_SMOKE_MULTI_DRIVE: process.argv.includes('--multi-drive') ? '1' : '0',
    DISKORYX_SMOKE_STARTUP_ERROR: process.argv.includes('--startup-error') ? '1' : '0',
    DISKORYX_SMOKE_DUPLICATES: process.argv.includes('--duplicates-ui') ? '1' : '0',
    DISKORYX_SMOKE_CAPTURE_PRODUCT: captureProduct ? '1' : '0',
    DISKORYX_SMOKE_PRODUCT_CAPTURE_DIR: captureDirectory,
    DISKORYX_SMOKE_ARCHIVE_SAVE: archivePath,
    DISKORYX_SMOKE_ARCHIVE_OPEN: archivePath
  }, process.argv.includes('--mft') ? 180000 : 60000);
  report(first);

  const completionMarker = process.argv.includes('--startup-error')
    ? 'PASS: isolated themed startup failure' : 'PASS: hidden Electron startup';
  if (first.status === 0 && !first.stdout?.includes(completionMarker)) {
    throw new Error('Electron smoke did not complete its expected checks.');
  }
  if (first.status !== 0) {
    failed = true;
    process.exitCode = 1;
  } else if (!process.argv.includes('--startup-error')) {
    const sums = /ARCHIVE SUMS (\{[^\n]+\})/.exec(first.stdout || '');
    if (!sums) throw new Error('Electron smoke did not write a saved scan archive.');
    // A separate Electron process reopens the archive, so persistence across an
    // application restart is verified instead of an in-memory shortcut.
    const second = runElectron({
      ...process.env,
      DISKORYX_SMOKE_ARCHIVE_OPEN_ONLY: '1',
      DISKORYX_SMOKE_ARCHIVE_OPEN: archivePath,
      DISKORYX_SMOKE_ARCHIVE_EXPECT: sums[1]
    });
    report(second);
    if (second.status !== 0 || !second.stdout?.includes('PASS: saved scan reopened in a fresh Electron process')) {
      throw new Error('Saved scan did not reopen after an application restart.');
    }
  }
  if (!failed) process.exitCode = 0;
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
