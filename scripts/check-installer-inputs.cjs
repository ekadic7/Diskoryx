const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('The Diskoryx installer must be built on Windows x64.');
}

const root = path.join(__dirname, '..');
const scanner = path.join(root, 'native', 'mft-scanner', 'bin', 'diskoryx-mft-scanner.exe');
const identitySource = fs.readFileSync(path.join(root, 'native', 'scan-broker', 'ScannerIdentity.cs'), 'utf8');
const expected = /Sha256\s*=\s*"([A-Fa-f0-9]{64})"/.exec(identitySource)?.[1];
if (!expected) throw new Error('The approved MFT scanner SHA-256 is missing from ScannerIdentity.cs.');

for (const file of [
  scanner,
  path.join(root, 'native', 'file-actions', 'bin', 'diskoryx-file-actions.exe'),
  path.join(root, 'native', 'scan-broker', 'bin', 'diskoryx-scan-broker.exe')
]) {
  if (!fs.existsSync(file)) throw new Error(`Required installer resource is missing: ${path.relative(root, file)}`);
  const bytes = fs.readFileSync(file);
  if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw new Error(`Invalid Windows executable: ${path.relative(root, file)}`);
}

const actual = crypto.createHash('sha256').update(fs.readFileSync(scanner)).digest('hex');
if (actual.toLowerCase() !== expected.toLowerCase()) {
  throw new Error(`The bundled MFT scanner does not match the reviewed SHA-256 in ScannerIdentity.cs.`);
}

console.log('Installer inputs verified; the bundled MFT scanner matches its pinned identity.');
