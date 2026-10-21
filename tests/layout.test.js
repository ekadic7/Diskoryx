const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL, fileURLToPath } = require('node:url');

const root = path.join(__dirname, '..');
const renderer = path.join(root, 'src', 'renderer', 'index.html');

test('Electron entry, preload, renderer and native helper resolve within the reorganized application', () => {
  const entry = require('../package.json').main;
  assert.equal(entry, 'src/main/main.js');
  assert(fs.statSync(path.join(root, entry)).isFile());
  assert(fs.statSync(path.join(root, 'src', 'preload', 'preload.js')).isFile());
  assert(fs.statSync(renderer).isFile());
  assert.equal(require('../src/main/mft-scanner').getMftScannerPath(false),
    path.join(root, 'native', 'mft-scanner', 'bin', 'diskoryx-mft-scanner.exe'));
  for (const file of ['main.js', 'preload.js', 'app.js', 'index.html', 'style.css']) {
    assert(!fs.existsSync(path.join(root, file)), `Stale root entry: ${file}`);
  }
});

test('all renderer scripts/styles and bundled font files resolve locally', () => {
  const html = fs.readFileSync(renderer, 'utf8');
  const assets = [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"/g)];
  for (const [, reference] of assets) {
    const url = new URL(reference, pathToFileURL(renderer));
    assert.equal(url.protocol, 'file:');
    const file = fileURLToPath(url);
    assert(fs.statSync(file).isFile(), `Missing asset: ${reference}`);
    if (!file.endsWith('.css')) continue;
    const css = fs.readFileSync(file, 'utf8');
    for (const [, font] of css.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
      if (font.startsWith('data:')) continue;
      const fontUrl = new URL(font, url);
      assert.equal(fontUrl.protocol, 'file:');
      assert(fs.statSync(fileURLToPath(fontUrl)).isFile(), `Missing font: ${font}`);
    }
  }
});

test('Windows app and taskbar use the bundled Diskoryx icon', () => {
  const pkg = require('../package.json');
  const icon = path.join(root, 'src', 'assets', 'diskoryx.ico');
  const iconBytes = fs.readFileSync(icon);
  assert.equal(pkg.build.win.icon, 'src/assets/diskoryx.ico');
  assert.equal(iconBytes.readUInt16LE(0), 0);
  assert.equal(iconBytes.readUInt16LE(2), 1);
  assert(iconBytes.readUInt16LE(4) > 0, 'ICO must contain at least one image');
  const main = fs.readFileSync(path.join(root, 'src', 'main', 'main.js'), 'utf8');
  assert.match(main, /setAppUserModelId\('com\.diskoryx\.desktop'\)/);
  assert.equal((main.match(/icon: APP_ICON/g) || []).length, 2);
});

test('Explorer location and scan controls are grouped and Create folder is a context action', () => {
  const html = fs.readFileSync(renderer, 'utf8');
  assert.match(html, /class="explorer-header-controls"[\s\S]*id="saved-scans-select"[\s\S]*class="sort-controls"/);
  assert.doesNotMatch(html, /id="create-folder-btn"/);
  assert.match(html, /data-file-action="create-folder"[^>]*hidden/);
});

test('Live monitor status and preview badge are not rendered in the app chrome', () => {
  const html = fs.readFileSync(renderer, 'utf8');
  assert.doesNotMatch(html, /id="live-status"|class="preview-label"/);
});
