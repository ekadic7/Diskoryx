# Diskoryx v1.0.3 local verification

Date: 2026-10-23. Scope: the Buffer candidate only. No original-project transfer, commit, tag, push or publication was performed.

## Review and fixes

The review covered changed/new main-process modules, preload contracts, native scanner/broker changes and their relevant renderer integrations. Four confirmed regressions were corrected with targeted tests:

| Area | Correction |
| --- | --- |
| Live updates after Copy/Move | Final source/destination events reconcile instead of ignoring entire subtrees for five seconds; staging-directory exclusions remain. |
| Saved-scan provenance | Re-saving an archive retains its original volume identity. Live scans bind volume identity at scan boundaries, rather than treating the disk present at save-time as provenance. |
| Compare cancellation | Renderer, preload, progress and backend use the same numeric request ID, so Stop reaches the active comparison. |
| CLI no-overwrite | Non-force publication is atomic and no-replace on hard-link-capable output filesystems; a racing destination returns exit code 4. Unsupported filesystems fail explicitly. |

Reused duplicate inventories deliberately remain last-scan snapshots, avoiding another full enumeration. A concise result status warns that Rescan is needed to include newer files. Full-file hashing and identity/change checks remain necessary even when an inventory is reused.

No AI self-credit, model signature or generated-by attribution was found in the 56 changed/new source, script and test files checked. Existing third-party licenses and old Git history were preserved.

## Automated and actual-interface evidence

| Check | Result and boundary |
| --- | --- |
| Node regression suite | 406/406 passed after the archive security fix, no skipped tests. |
| Rust scanner | 6/6 tests; offline Clippy with warnings denied passed. |
| Expanded real Electron UI suite | 28/28 scenario groups passed after the fixes; exit 0, zero captured renderer errors or external network attempts. |
| Real Windows notifications | External creation/resize/rename/deletion and folder arrival; paused-watcher snapshot browsing; independent creation immediately after Copy appeared in 252 ms and deletion reconciled without Rescan. |
| Real Windows Recycle Bin | Disposable file/folder recycle and identity-bound restore passed; occupied destinations were preserved. Only owned fixtures were affected; the Bin was not emptied. |
| Real MFT/UAC | Three real C: scans per version passed with 0 skipped entries; user approved each version's scanner. [Raw benchmark and screenshots](benchmarks/v1.0.3/README.md). |
| CSV CLI | Verified JSON summary/CSV export and exit 4 for existing output; targeted tests cover a destination appearing during publication. |
| Packaged startup | Actual `win-unpacked\Diskoryx.exe` and actual portable executable launched one at a time; secure renderer, local fonts/icons, four sidebar views, real drive chooser and restored theme state passed; each exited 0. No runtime errors or HTTP requests were observed during the connected checks. |
| Actual Windows file choosers | The packaged executable opened the real folder chooser (Cancel and Select Folder), CSV Save, scan Save and scan Open dialogs. Process-scoped UI Automation located the owned native controls; Win32 edit/button messages entered only disposable fixture paths. The real scan, exported CSV, archive and reopened read-only badge were verified. No chooser result was stubbed in this check. |
| Payload | All 51 application source/assets matched the packaged archive; three native images matched; local Font Awesome fonts and D3 were present. Installer and portable contained the same compressed application payload. |
| Build | Both unsigned Windows x64 artifacts built using local Electron/tool caches with outbound download proxies blocked. Authenticode reports `NotSigned`. |

The 28 UI groups cover startup/single-instance lock; drive select-all/clear/subset; sequential fixture scans; folder browse/cancel; Stop; tree paging/expansion/sorts; treemap/Inspector/layout/themes; Largest/File types/drilldown; search/advanced filters; text paging; native Rename and history; Create folder; native Copy and Undo/Redo; native Move and return/redo; recycle confirmation; scan filters; archive save/open/read-only behavior; Compare changes/filter/sort/paging; CSV export; duplicate scope/graph/search/sort/paging; duplicate cancellation; offline/error handling; Compare Stop; malformed archive recovery; destination paging/New folder/Up/location switching/Cancel; collision/rename refusal; binary-preview refusal; Support/Explorer handoff; and real fixture live updates.

UI operations were performed by real DOM control clicks/input/context menus/keyboard events in Electron, not by using unit-test success as proof of interface behavior. Native fixture file operations were checked against the filesystem.

## Simulation boundaries and remaining acceptance

The source UI harness redirects invented drive roots to disposable folders and supplies controlled paths/cancellation for native Open/Save dialogs. It intercepts external browser/Explorer launches and normally substitutes private fixture relocation for recycling; real Recycle Bin behavior was exercised separately. Controlled delays make Stop tests deterministic. Most groups disable live monitoring; dedicated groups use the production Windows watcher.

This is automated interface coverage, not exhaustive human certification. Actual Windows file choosers were exercised separately as recorded above, but their full keyboard/accessibility behavior was not audited. The real UAC-decline path, physical removable-media disconnects, localization and every mid-copy failure variation were not certified here. Installation/uninstallation was not performed on the shared Windows account. The installer payload was extracted and verified, its executable was launched, and the self-extracting portable executable itself was launched; those are not substitutes for an install/uninstall acceptance test on a disposable account.

The benchmark uses a live, changing volume and does not prove old/new output parity. Cached inventories and best-effort notifications are not atomic filesystem snapshots. Allocated-size reporting is not implemented or approximated.

## Security-review follow-up

The offline full-folder inventory covered 10,182 files; 68 first-party production text files were read in full. Third-party dependencies were inventoried and their package manifests inspected, not individually source-audited or checked against an online vulnerability database. Binary hash/payload checks do not establish compiler reproducibility or binary-level security.

A low-severity saved-archive resource-amplification finding was fixed with depth, total expanded-path, aggregate extension-entry/key and work budgets, plus cooperative cancellation. Resource-heavy archives now fail explicitly before dangerous aggregation; previous active results remain usable. Six additional regression tests bring the suite to 406. Installer and portable were rebuilt from the corrected original checkout; old artifact checksums no longer apply.

The known low-severity shell-recycle leaf/descendant race remains open and documented. The user chose to preserve Recycle/Undo-copy behavior for this release rather than disable it or introduce an unreviewed quarantine redesign. A concurrent process with relevant ordinary-user directory modification rights can still change the selected pathname or contents between validation and the shell operation. This is not claimed fixed, identity-atomic, or a demonstrated privilege escalation.

The [acceptance checklist](manual-test-checklist.md) identifies the remaining manual checks before publication. No claim is made that this candidate has already been publicly released.
