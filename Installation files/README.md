# Diskoryx Windows builds

`npm run build:release:win` generates these Windows x64 release candidates locally:

- `Diskoryx-Setup-1.0.3.exe` - per-user NSIS installer.
- `Diskoryx-Portable-1.0.3.exe` - install-free, self-extracting launcher.

`npm run build:installer:win` still builds only the installer. Generated executables are intentionally not committed. Both builds are unsigned, so Windows may show a SmartScreen warning. Building them does not publish a release.

`SHA256SUMS-1.0.3.txt` contains the checksums for the locally verified artifacts. Recompute it whenever either executable is rebuilt.

This is a per-user installer and does not require administrator rights to install. Diskoryx itself must be started as a normal user; the separate MFT scan broker requests UAC only when scanning an NTFS drive.

The portable executable needs no installation and extracts its runtime to a temporary directory. It uses the same `%APPDATA%\Diskoryx V1` settings/history as the installed app; it is not an isolated, leave-no-trace profile on a USB drive. Close one edition before starting the other.

Before sharing, install on a test account or Windows machine, launch Diskoryx, scan a disposable location, test guarded file actions only on disposable files, and uninstall from Windows Settings. The app's saved history is retained on uninstall.
