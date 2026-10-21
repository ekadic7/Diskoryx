# Diskoryx

A free disk space analyzer for Windows. See what's taking up room, find large files, and explore your drives without sending your files anywhere.

[Download for Windows x64](https://github.com/ekadic7/Diskoryx/releases) · [Report a bug](https://github.com/ekadic7/Diskoryx/issues) · [Support on Ko-fi](https://ko-fi.com/edi969247)

![Diskoryx disk overview in dark mode](docs/screenshots/overview-dark.png)

## What it does

- Scan NTFS drives using the MFT, or browse an individual folder.
- Explore a visual space map, file tree, largest files, and file types.
- Search scanned files and preview text files and logs.
- Rename, recycle, copy, and move files, with action history.
- Switch between dark and light themes.

Disk analysis works offline. The optional support button opens Ko-fi in your browser only when you click it.

<p align="center">
  <img src="docs/screenshots/largest-files-dark.png" alt="Largest files, with sizes and full paths" width="49%">
  <img src="docs/screenshots/file-types-dark.png" alt="Storage usage grouped by file type" width="49%">
</p>

Screenshots use sample files, not private user data. [See the light theme](docs/screenshots/overview-light.png).

## Try it

Download the setup `.exe` from [Releases](https://github.com/ekadic7/Diskoryx/releases), install it, and launch Diskoryx normally. No Node.js needed.

**This is an early testing release.** The installer is unsigned, so Windows SmartScreen may show a warning. NTFS drive scans may ask for administrator approval for the separate scanner; the app and file actions run as your normal user.

Keep backups, and try file actions on disposable files first. Diskoryx reports logical file sizes, not allocated "Size on disk"; it isn't a backup tool.

## Feedback

Found a bug or something awkward? [Open an issue](https://github.com/ekadic7/Diskoryx/issues). Include your Diskoryx and Windows versions, what you tried, and what happened. Please hide private filenames and paths in screenshots.

## Run from source

Built with Electron and a Rust MFT scanner. On Windows x64 with Node.js 22 or later, run from a normal PowerShell:

```powershell
npm ci
npm test
npm run build:file-actions
npm run build:scan-broker
npm start
```

Build both native helpers in a fresh checkout or after updating their sources or the bundled scanner. For installer builds, file-action limits, and testing details, see the [technical guide](docs/technical-guide.md). Code contributions are welcome; please read [CONTRIBUTING.md](CONTRIBUTING.md).

## Support

Diskoryx is free. If it's useful to you, you can [support development on Ko-fi](https://ko-fi.com/edi969247) via PayPal. It's completely optional; no features are locked behind a payment.

## License

[MIT](LICENSE).
