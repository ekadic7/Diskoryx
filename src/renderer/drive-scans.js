let selectedDrivePaths = [];
const chooseDrivesDialog = document.getElementById('choose-drives-dialog');
const driveChecklist = document.getElementById('drive-checklist');
const savedScansSelect = document.getElementById('saved-scans-select');
let savedScansRequest = 0;

function hasChosenDrives() {
  return selectedDrivePaths.length > 0 || Boolean(driveSelect.value);
}

function updateDriveSelection() {
  const count = selectedDrivePaths.length || (driveSelect.value ? 1 : 0);
  document.getElementById('drive-selection-summary').textContent = count
    ? `${count} selected: ${selectedDrivePaths.length ? selectedDrivePaths.join(', ') : driveSelect.value}`
    : 'Choose one or more drives';
  scanDriveButton.textContent = count > 1 ? `Scan ${count} drives` : 'Scan drive';
  scanDriveButton.disabled = !count || scanInProgress || fileActionInProgress;
  document.getElementById('choose-drives-btn').textContent = count
    ? (selectedDrivePaths.length > 1 ? `${count} drives selected` : selectedDrivePaths[0] || driveSelect.value)
    : 'Choose drives';
}

driveSelect.addEventListener('change', () => {
  selectedDrivePaths = [];
  updateDriveSelection();
});

document.getElementById('choose-drives-btn').addEventListener('click', async () => {
  if (scanInProgress || fileActionInProgress || folderDialogOpen) return;
  folderDialogOpen = true;
  try {
    const result = await window.electronAPI.listDrives();
    if (!Array.isArray(result.drives)) throw new Error(result.error || 'Drive list is unavailable.');
    driveChecklist.replaceChildren();
    for (const drive of result.drives) {
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = drive.path;
      checkbox.checked = selectedDrivePaths.length ? selectedDrivePaths.includes(drive.path) : drive.path === driveSelect.value;
      const name = document.createElement('span');
      name.textContent = `${drive.label} (${drive.path})`;
      label.append(checkbox, name);
      driveChecklist.append(label);
    }
    if (!result.drives.length) throw new Error('No accessible drives were found.');
    chooseDrivesDialog.showModal();
  } catch (error) {
    showAppMessage(`Unable to choose drives: ${error.message}`);
  } finally {
    folderDialogOpen = false;
  }
});
for (const [id, checked] of [['select-all-drives', true], ['select-no-drives', false]]) {
  document.getElementById(id).addEventListener('click', () => {
    for (const input of driveChecklist.querySelectorAll('input')) input.checked = checked;
  });
}
document.getElementById('cancel-choose-drives').addEventListener('click', () => chooseDrivesDialog.close());
document.getElementById('choose-drives-form').addEventListener('submit', event => {
  event.preventDefault();
  selectedDrivePaths = Array.from(driveChecklist.querySelectorAll('input:checked'), input => input.value);
  driveSelect.value = selectedDrivePaths[0] || '';
  updateDriveSelection();
  chooseDrivesDialog.close();
});

async function scanChosenDrives() {
  const paths = selectedDrivePaths.length ? [...selectedDrivePaths] : [driveSelect.value].filter(Boolean);
  if (!paths.length) return;
  await runScan(async requestId => {
    let lastResult;
    for (let index = 0; index < paths.length; index++) {
      if (cancellationRequested) return { cancelled: true };
      document.getElementById('drive-selection-summary').textContent = `Scanning ${index + 1}/${paths.length}: ${paths[index]}`;
      let result;
      try {
        result = await window.electronAPI.scanFolder(paths[index], currentScanFilters, requestId);
      } catch (error) {
        result = { error: error.message };
      }
      if (result.cancelled || cancellationRequested) return { cancelled: true };
      if (!result.success) {
        showAppMessage(`${paths[index]}: ${result.error || 'Scan failed.'}\nRemaining drives were not scanned. Completed results are kept.`, 'Drive scan stopped');
        return lastResult || currentResult || result;
      }
      lastResult = result;
      if (index < paths.length - 1) renderResult(result);
    }
    return lastResult;
  });
  updateDriveSelection();
}

async function updateSavedScans() {
  const request = ++savedScansRequest;
  try {
    const result = await window.electronAPI.listSavedScans();
    if (request !== savedScansRequest) return;
    if (!result.success) throw new Error(result.error || 'Saved scans are unavailable.');
    savedScansSelect.replaceChildren();
    for (const scan of result.scans) {
      const option = document.createElement('option');
      option.value = scan.folderPath;
      const label = /^[A-Za-z]:\\$/.test(scan.folderPath)
        ? scan.folderPath : `${scan.folderPath.replace(/\\$/, '').split('\\').at(-1)} (${scan.folderPath.slice(0, 2)})`;
      option.textContent = `${label} - ${scan.fileCount.toLocaleString()} files`;
      option.title = scan.folderPath;
      option.selected = scan.active;
      savedScansSelect.append(option);
      if (scan.active) savedScansSelect.title = scan.folderPath;
    }
    savedScansSelect.disabled = scanInProgress || fileActionInProgress || !result.scans.length;
    if (!result.scans.length) {
      const option = document.createElement('option');
      option.textContent = 'No scanned locations';
      option.value = '';
      savedScansSelect.append(option);
    }
  } catch (error) {
    showAppMessage(`Unable to list saved scans: ${error.message}`);
  }
}
savedScansSelect.addEventListener('change', async () => {
  if (scanInProgress || fileActionInProgress || folderDialogOpen) return;
  const folderPath = savedScansSelect.value;
  setFileActionBusy(true);
  ++sortRequestId;
  fileContextMenu.hidden = true;
  document.dispatchEvent(new Event('diskoryx:scan-start'));
  try {
    const result = await window.electronAPI.activateSavedScan(folderPath);
    if (!result.success) throw new Error(result.error || 'Saved scan is unavailable.');
    currentSearchQuery = '';
    document.getElementById('search-input').value = '';
    renderResult(result);
  } catch (error) {
    showAppMessage(error.message, 'Saved scan not opened');
  } finally {
    setFileActionBusy(false);
    await updateSavedScans();
  }
});
document.addEventListener('diskoryx:result', () => { void updateSavedScans(); });
