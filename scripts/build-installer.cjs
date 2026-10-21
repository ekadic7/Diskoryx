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
const installerName = `Diskoryx-Setup-${packageInfo.version}.exe`;
const stagedInstaller = path.join(stagingDirectory, installerName);
const finalInstaller = path.join(outputDirectory, installerName);

fs.rmSync(stagingDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

const builderCli = require.resolve('electron-builder/cli.js', { paths: [root] });
const result = spawnSync(process.execPath, [builderCli, '--win', 'nsis', '--x64'], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: false
});
if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status || 1;
else {
  if (!fs.existsSync(stagedInstaller)) {
    throw new Error(`electron-builder completed without creating ${path.relative(root, stagedInstaller)}.`);
  }
  const bytes = fs.readFileSync(stagedInstaller);
  if (bytes.length < 1024 * 1024 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    throw new Error('The generated Diskoryx installer is missing or invalid.');
  }
  fs.copyFileSync(stagedInstaller, finalInstaller);
  console.log(`Installer ready: ${path.relative(root, finalInstaller)} (${bytes.length.toLocaleString()} bytes).`);
  console.log('The .build staging directory is retained for packaged-app validation and can be removed afterward.');
}
