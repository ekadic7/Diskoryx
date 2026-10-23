const copyDialog = document.getElementById('copy-dialog');
const copyStatus = document.getElementById('copy-status');
const copyCancel = document.getElementById('copy-cancel');
let copiedItemName = null;
let copiedItemPath = null;
let transferMode = 'copy';
let copySelectionToken = 0;

function updatePasteAvailability() {
  const busy = scanInProgress || fileActionInProgress;
  const selection = document.getElementById('transfer-selection');
  selection.hidden = !copiedItemName;
  selection.textContent = copiedItemName ? `${transferMode === 'move' ? 'Move' : 'Copy'}: ${copiedItemName}` : '';
  selection.title = selection.textContent;
  document.querySelector('label[for="saved-scans-select"]').textContent = 'Location';
  const chooseDestination = document.getElementById('choose-destination');
  chooseDestination.hidden = !copiedItemName;
  chooseDestination.disabled = busy;
  chooseDestination.textContent = transferMode === 'move' ? 'Choose where to move...' : 'Choose where to copy...';
  document.getElementById('clear-transfer').hidden = !copiedItemName;
  for (const button of fileContextMenu.querySelectorAll('[data-file-action="create-folder"]')) {
    button.disabled = !currentScanId || busy;
  }
  for (const button of fileContextMenu.querySelectorAll('[data-file-action="paste"]')) {
    button.disabled = !copiedItemName || !currentScanId || busy;
  }
}

async function pasteIntoFolder(folderId, scanId = currentScanId) {
  if (!copiedItemName) { showAppMessage('Choose Copy or Move on a file or folder first.'); return; }
  const token = copySelectionToken;
  await runCopyOperation(() => window.electronAPI.pasteItem(scanId, folderId), token);
}

function showFolderPasteMenu(event) {
  if (event.target.closest('.virtual-tree-row, .treemap-tile, button') || scanInProgress ||
    fileActionInProgress || !currentScanId) return;
  event.preventDefault();
  contextFile = { type: 'folder', folderId: diskTreemap?.frame?.folderId || 0 };
  contextScanId = currentScanId;
  for (const button of fileContextMenu.querySelectorAll('[data-file-action]')) {
    button.hidden = button.dataset.fileAction !== 'paste' && button.dataset.fileAction !== 'create-folder';
  }
  updatePasteAvailability();
  fileContextMenu.hidden = false;
  const bounds = fileContextMenu.getBoundingClientRect();
  fileContextMenu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - bounds.width - 8))}px`;
  fileContextMenu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - bounds.height - 8))}px`;
  fileContextMenu.querySelector('[data-file-action="create-folder"]').focus();
}

async function handleCopyResult(result, token) {
  if (result.refreshRequired) invalidateFileActionView();
  if (result.cancelled) { showActionToast('Transfer cancelled; original unchanged'); return; }
  if (!result.success) throw new Error(result.error || 'Copy did not complete.');
  if (token !== undefined && token === copySelectionToken) { copiedItemName = null; copiedItemPath = null; }
  if (result.snapshotChanged) await refreshAfterFileAction(result, { successDialog: true });
  else {
    showSuccessDialog(result.actionLabel || 'Item copied outside this scan', 'Copied successfully');
    if (result.historyWarning) showAppMessage(result.historyWarning, 'Action completed; check history');
  }
}

async function runCopyOperation(operation, token) {
  if (scanInProgress || fileActionInProgress) return;
  setFileActionBusy(true);
  document.getElementById('copy-title').textContent = 'Transfer file / folder';
  copyStatus.textContent = 'Preparing transfer and verifying paths...';
  copyCancel.disabled = false;
  copyDialog.showModal();
  try { await handleCopyResult(await operation(), token); }
  catch (error) { showAppMessage(error.message, 'Transfer not completed'); }
  finally { copyDialog.close(); setFileActionBusy(false); updatePasteAvailability(); }
}

window.electronAPI.onCopyProgress(progress => {
  if (progress.phase === 'finishing-move') {
    copyCancel.disabled = true;
    copyStatus.textContent = 'Destination verified. Finishing source cleanup; cancellation is no longer available.';
    return;
  }
  const mib = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  copyStatus.textContent = `${mib(progress.bytes)} of ${mib(progress.totalBytes)} copied. Checking and publishing only after completion.`;
});
async function cancelCopyOperation() {
  if (copyCancel.disabled) return;
  copyCancel.disabled = true;
  try {
    const result = await window.electronAPI.cancelCopy();
    if (!result.success) {
      copyStatus.textContent = result.error || 'No copy is running.';
      copyCancel.disabled = false;
    } else copyStatus.textContent = 'Cancelling and cleaning this copy staging area...';
  } catch (error) {
    copyStatus.textContent = error.message;
    copyCancel.disabled = false;
  }
}
copyCancel.addEventListener('click', cancelCopyOperation);
copyDialog.addEventListener('cancel', event => { event.preventDefault(); void cancelCopyOperation(); });
treeContainer.addEventListener('contextmenu', showFolderPasteMenu);
treemapCanvas.addEventListener('contextmenu', showFolderPasteMenu);
document.addEventListener('diskoryx:result', updatePasteAvailability);
updatePasteAvailability();
document.getElementById('clear-transfer').addEventListener('click', async () => {
  try {
    const result = await window.electronAPI.clearCopySelection();
    if (!result.success) throw new Error(result.error || 'Unable to clear the transfer selection.');
    copiedItemName = null;
    updatePasteAvailability();
  } catch (error) { showAppMessage(error.message); }
});
