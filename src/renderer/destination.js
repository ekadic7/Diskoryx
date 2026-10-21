(() => {
  const dialog = document.getElementById('destination-dialog');
  const locations = document.getElementById('destination-location');
  const folders = document.getElementById('destination-folders');
  const confirm = document.getElementById('destination-confirm');
  const cancel = document.getElementById('destination-cancel');
  const up = document.getElementById('destination-up');
  const more = document.getElementById('destination-more');
  const createFolder = document.getElementById('destination-create-folder');
  const status = document.getElementById('destination-status');
  const error = document.getElementById('destination-error');
  const pathLabel = document.getElementById('destination-path');
  let trail = [];
  let revision = null;
  let offset = 0;
  let request = 0;
  let loading = false;
  let switching = false;
  let creating = false;
  let ready = false;

  function controls() {
    confirm.disabled = loading || switching || creating || !ready || revision !== currentScanId;
    locations.disabled = loading || switching || creating;
    up.disabled = loading || switching || creating || trail.length < 2;
    more.disabled = loading || switching || creating;
    createFolder.disabled = loading || switching || creating;
    cancel.disabled = switching || creating;
    for (const button of folders.querySelectorAll('button')) button.disabled = loading || switching || creating;
  }

  function fail(failure) {
    error.textContent = failure.message;
    error.hidden = false;
    ready = false;
  }

  async function load(append = false) {
    const token = ++request;
    const scanId = currentScanId;
    loading = true;
    ready = false;
    error.hidden = true;
    more.hidden = true;
    if (!append) {
      folders.replaceChildren();
      offset = 0;
      folders.scrollTop = 0;
    }
    const target = trail.at(-1);
    pathLabel.textContent = target.path;
    confirm.textContent = transferMode === 'move' ? 'Move here' : 'Copy here';
    status.textContent = 'Loading subfolders...';
    controls();
    try {
      const result = await window.electronAPI.getFolderPage(scanId, target.folderId, offset, 200, 'name', [], {});
      if (!dialog.open || token !== request) return;
      if (scanId !== currentScanId) throw new Error('The scan changed. Close and reopen the destination picker.');
      if (!result.success) throw new Error(result.error || 'Unable to list destination folders.');
      for (const item of result.items.filter(item => item.type === 'folder')) {
        const button = document.createElement('button');
        button.type = 'button';
        button.title = `Open ${item.path}`;
        const icon = document.createElement('i');
        icon.className = 'fas fa-folder';
        icon.setAttribute('aria-hidden', 'true');
        const name = document.createElement('span');
        name.textContent = item.name;
        button.append(icon, name);
        button.addEventListener('click', () => {
          if (loading || switching) return;
          trail.push({ folderId: item.folderId, path: item.path });
          void load();
        });
        folders.append(button);
      }
      offset = result.offset + result.items.length;
      // Name ordering places folders before files; no file pages need to be fetched.
      more.hidden = offset >= result.totalCount || result.items.some(item => item.type !== 'folder');
      status.textContent = folders.children.length
        ? 'Click a folder to open it, or confirm the destination shown above.'
        : 'No subfolders in this snapshot. You can use this folder as the destination.';
      revision = scanId;
      ready = true;
    } catch (failure) {
      if (dialog.open && token === request) {
        fail(failure);
        status.textContent = 'Destination unavailable.';
      }
    } finally {
      if (token === request) { loading = false; controls(); }
    }
  }

  document.getElementById('choose-destination').addEventListener('click', async () => {
    if (!copiedItemName || scanInProgress || fileActionInProgress || dialog.open) return;
    dialog.showModal();
    cancel.focus();
    ready = false;
    loading = true;
    trail = [];
    error.hidden = true;
    folders.replaceChildren();
    locations.replaceChildren();
    pathLabel.textContent = '';
    document.getElementById('destination-source').textContent =
      `${transferMode === 'move' ? 'Moving' : 'Copying'}: ${copiedItemPath || copiedItemName}`;
    status.textContent = 'Loading scanned locations...';
    controls();
    const token = ++request;
    try {
      const result = await window.electronAPI.listSavedScans();
      if (!dialog.open || token !== request) return;
      if (!result.success) throw new Error(result.error || 'Unable to list scanned locations.');
      for (const scan of result.scans) {
        const option = document.createElement('option');
        option.value = scan.folderPath;
        option.textContent = scan.folderPath;
        option.selected = scan.active;
        locations.append(option);
      }
      if (!result.scans.some(scan => scan.active)) throw new Error('Scan a destination location first.');
      trail = [{ folderId: 0, path: currentFolderPath }];
      await load();
    } catch (failure) {
      if (dialog.open && token === request) { fail(failure); loading = false; controls(); }
    }
  });

  locations.addEventListener('change', async () => {
    if (loading || switching || creating) return;
    switching = true;
    ready = false;
    controls();
    setFileActionBusy(true);
    try {
      const result = await window.electronAPI.activateSavedScan(locations.value);
      if (!result.success) throw new Error(result.error || 'Unable to open this scanned location.');
      ++sortRequestId;
      currentSearchQuery = '';
      document.getElementById('search-input').value = '';
      renderResult(result);
      trail = [{ folderId: 0, path: result.folderPath }];
      await load();
    } catch (failure) { fail(failure); }
    finally { switching = false; setFileActionBusy(false); controls(); }
  });
  up.addEventListener('click', () => {
    if (loading || switching || creating || trail.length < 2) return;
    trail.pop();
    void load();
  });
  more.addEventListener('click', () => { if (!loading && !switching && !creating) void load(true); });
  createFolder.addEventListener('click', async () => {
    if (loading || switching || creating || !ready || revision !== currentScanId || scanInProgress || fileActionInProgress) return;
    creating = true;
    controls();
    error.hidden = true;
    try {
      const parent = trail.at(-1);
      const result = await createFolderInScan(parent.folderId, failure => fail(new Error(failure)));
      if (!result) return;
      if (result.item) {
        trail.push({ folderId: result.item.folderId, path: result.path });
        await load();
      } else if (result.hiddenByFilters) {
        error.hidden = true;
        ready = true;
        status.textContent = 'Folder created, but excluded by the active scan filters. Adjust filters to browse it.';
      } else if (result.refreshRequired) {
        fail(new Error(result.warning || 'Folder was created. Rescan to refresh this destination.'));
        status.textContent = 'Destination must be rescanned before continuing.';
      } else {
        status.textContent = result.actionLabel || 'Folder created.';
        await load();
      }
    } finally {
      creating = false;
      controls();
    }
  });
  confirm.addEventListener('click', async () => {
    if (confirm.disabled || !ready) return;
    if (revision !== currentScanId) {
      fail(new Error('The scan changed. Close and reopen the destination picker.'));
      controls();
      return;
    }
    const folderId = trail.at(-1).folderId;
    const scanId = revision;
    ready = false;
    confirm.disabled = true;
    dialog.close();
    await pasteIntoFolder(folderId, scanId);
  });
  cancel.addEventListener('click', () => { if (!switching) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (switching) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    ++request; ready = false; loading = false;
  });
  document.addEventListener('diskoryx:files-changed', () => {
    if (!dialog.open || switching || creating || !trail.length) return;
    ++request;
    ready = false;
    loading = true;
    status.textContent = 'Refreshing destination snapshot...';
    controls();
  });
  document.addEventListener('diskoryx:result', () => {
    if (!dialog.open || switching || creating || !trail.length) return;
    if (trail[0].path !== currentFolderPath) {
      trail = [{ folderId: 0, path: currentFolderPath }];
    }
    void load();
  });
})();
