const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'win32') throw new Error('The scanner broker must be built on Windows.');
const directory = path.join(__dirname, '..', 'native', 'scan-broker');
const compiler = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
if (!fs.existsSync(compiler)) throw new Error('The local .NET Framework compiler is unavailable. No download was attempted.');
fs.mkdirSync(path.join(directory, 'bin'), { recursive: true });
const result = spawnSync(compiler, [
  '/nologo', '/target:exe', '/platform:x64', '/optimize+', '/reference:System.Web.Extensions.dll',
  `/out:${path.join(directory, 'bin', 'diskoryx-scan-broker.exe')}`,
  path.join(directory, 'Program.cs'), path.join(directory, 'ScannerIdentity.cs')
], { encoding: 'utf8', windowsHide: true });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
process.exitCode = result.status === 0 ? 0 : 1;
