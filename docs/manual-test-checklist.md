# Diskoryx v1.0.3 acceptance checklist

The earlier implementation-status checklist is superseded by the [current verification record](release-verification-1.0.3.md). Saved scans, advanced search, Compare, Duplicate Finder, source CLI and the install-free launcher are implemented. Allocated "Size on disk" remains deliberately deferred; the app reports logical file sizes.

## Already exercised locally

- Automated interaction with the real Electron main/preload/renderer: 28 passing scenario groups, including actual native fixture Rename/Create/Copy/Move, Undo/Redo, preview, archives, Compare cancellation, duplicate hashing, destination navigation, paging and error dialogs.
- Real C: MFT scanning with user-approved UAC in v1.0.1 and the v1.0.3 candidate, three runs each; no content hashing for the benchmark.
- Actual Windows notification reconciliation on disposable fixtures, including independent changes immediately after Copy.
- Real Windows Recycle Bin and identity-bound restoration of disposable fixtures, including occupied-path refusal.
- Packaged executable and actual portable launcher: startup, local fonts/icons, sidebar navigation, real drive chooser, themes and clean exit.
- Packaged executable with actual Windows dialogs: Browse Folder cancel/selection, CSV export, scan save and scan reopen using only disposable fixture paths.

These checks are not a claim that every Windows configuration or failure path is certified. Source-suite OS file choosers return controlled fixture paths, while the separate packaged check uses the actual Windows dialogs. Browser/Explorer launches are intercepted.

## Before publishing

1. On a disposable Windows account or VM, install `Diskoryx-Setup-1.0.3.exe`, check shortcut/icon/startup, and uninstall through Windows Settings. Verify that retaining the app's settings/history is expected.
2. Launch `Diskoryx-Portable-1.0.3.exe` from a writable location without installation. It uses `%APPDATA%\Diskoryx V1`; it is not a USB-local/leave-no-trace profile.
3. Confirm the native Browse, Save/Open scan and CSV dialogs on that test account as well. The packaged candidate passed these dialogs on the development host; account-specific permissions and keyboard/accessibility behavior still need acceptance.
4. Start a real drive scan, decline UAC once and check recovery; then approve it, stop a scan and scan again. Only the separate scanner should elevate.
5. If relevant, test selected physical drives and removable-media Copy/Move on owned disposable files. Same-volume fixture tests do not establish USB/disconnection behavior.
6. Try Support and Open in Explorer with the actual external programs. Support is optional; it is the only deliberate browser navigation, not part of offline disk analysis.

Do not rename system files, empty the Recycle Bin, or use private data for destructive acceptance checks. Hide private paths before sharing screenshots or scan archives.
