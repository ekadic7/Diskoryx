# Diskoryx installer

After building the Windows x64 installer for this V1 release, it is placed in this folder as:

`Diskoryx-Setup-1.0.0.exe`

The installer is generated locally with `npm run build:installer:win`. The generated executable is intentionally not committed to the source repository; publish it as an asset attached to a GitHub Release after testing it. The installer is unsigned, so Windows may show a SmartScreen warning.

This is a per-user installer and does not require administrator rights to install. Diskoryx itself must be started as a normal user; the separate MFT scan broker requests UAC only when scanning an NTFS drive.

Before sharing, install on a test account or Windows machine, launch Diskoryx, scan a disposable location, test guarded file actions only on disposable files, and uninstall from Windows Settings. The app's saved history is retained on uninstall.
