(() => {
  let pending;
  let applying = false;
  async function apply() {
    if (!pending || applying) return;
    if (scanInProgress || fileActionInProgress || renameDialog.open || messageDialog.open ||
      document.getElementById('history-dialog').open || copyDialog.open || !fileContextMenu.hidden) {
      setTimeout(apply, 100); return;
    }
    const update = pending;
    pending = null;
    if (update.folderPath !== currentFolderPath || update.scanId <= currentScanId) return;
    applying = true;
    setFileActionBusy(true);
    try {
      await refreshAfterFileAction({
        scanId: update.scanId, parentFolderId: 0, item: null, silent: true
      });
    } finally {
      setFileActionBusy(false); applying = false;
      if (pending) void apply();
    }
  }
  window.electronAPI.onLiveUpdate(update => {
    if (update.status?.state === 'stale') {
      pending = null;
    }
    if (update.snapshotChanged) { pending = update; void apply(); }
  });
})();
