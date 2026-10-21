const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'diskoryx-smoke-'));
const captureProduct = process.argv.includes('--capture-product');
const captureDirectory = path.join(__dirname, '..', 'docs', 'screenshots');
if (captureProduct) fs.mkdirSync(captureDirectory, { recursive: true });
try {
  const result = spawnSync(require('electron'), [path.join(__dirname, 'electron-smoke.cjs')], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: process.argv.includes('--mft') ? 180000 : 60000,
    env: {
      ...process.env, DISKORYX_SMOKE_ROOT: temporaryRoot,
      DISKORYX_SMOKE_REAL_RECYCLE: process.argv.includes('--real-recycle') ? '1' : '0',
      DISKORYX_SMOKE_MFT: process.argv.includes('--mft') ? '1' : '0',
      DISKORYX_SMOKE_MFT_REPEAT: process.argv.includes('--mft-repeat') ? '1' : '0',
      DISKORYX_SMOKE_LIVE: process.argv.includes('--live') || process.argv.includes('--live-pause') ? '1' : '0',
      DISKORYX_SMOKE_LIVE_PAUSE: process.argv.includes('--live-pause') ? '1' : '0',
      DISKORYX_SMOKE_PASTE_UI: process.argv.includes('--paste-ui') ? '1' : '0',
      DISKORYX_SMOKE_MULTI_DRIVE: process.argv.includes('--multi-drive') ? '1' : '0',
      DISKORYX_SMOKE_STARTUP_ERROR: process.argv.includes('--startup-error') ? '1' : '0',
      DISKORYX_SMOKE_CAPTURE_PRODUCT: captureProduct ? '1' : '0',
      DISKORYX_SMOKE_PRODUCT_CAPTURE_DIR: captureDirectory
    }
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  process.exitCode = result.status === 0 ? 0 : 1;
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
