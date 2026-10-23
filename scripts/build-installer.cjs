const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('The Diskoryx installer must be built on Windows x64.');
}

const root = path.join(__dirname, '..');
const packageInfo = require(path.join(root, 'package.json'));
const outputDirectory = path.join(root, 'Installation files');
const stagingDirectory = path.join(outputDirectory, '.build');
const withPortable = process.argv.includes('--portable');
const artifactNames = [
  `Diskoryx-Setup-${packageInfo.version}.exe`,
  ...(withPortable ? [`Diskoryx-Portable-${packageInfo.version}.exe`] : [])
];

fs.rmSync(stagingDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

const builderCli = require.resolve('electron-builder/cli.js', { paths: [root] });
const electronDirectory = path.dirname(require('electron'));
const result = spawnSync(process.execPath, [
  builderCli, '--win', 'nsis', ...(withPortable ? ['portable'] : []), '--x64',
  `--config.electronDist=${electronDirectory}`
], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: false
});
if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status || 1;
else {
  for (const name of artifactNames) {
    const stagedArtifact = path.join(stagingDirectory, name);
    const bytes = fs.readFileSync(stagedArtifact);
    if (bytes.length < 1024 * 1024 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
      throw new Error(`The generated ${name} is invalid.`);
    }
  }
  for (const name of artifactNames) {
    const finalArtifact = path.join(outputDirectory, name);
    fs.copyFileSync(path.join(stagingDirectory, name), finalArtifact);
    console.log(`Release artifact ready: ${path.relative(root, finalArtifact)} (${fs.statSync(finalArtifact).size.toLocaleString()} bytes).`);
  }
  console.log('The .build staging directory is retained for packaged-app validation and can be removed afterward.');
}
