(() => {
  const panel = document.getElementById('duplicates-panel');
  const driveSelect = document.getElementById('duplicates-drive-select');
  const scopeSelect = document.getElementById('duplicates-scope-select');
  const button = document.getElementById('find-duplicates-btn');
  const count = document.getElementById('duplicates-count');
  const status = document.getElementById('duplicates-status');
  const error = document.getElementById('duplicates-error');
  const rows = document.getElementById('duplicates-rows');
  const results = document.getElementById('duplicates-results');
  const chart = document.getElementById('duplicates-chart');
  const query = document.getElementById('duplicates-query');
  const sort = document.getElementById('duplicates-sort');
  const previous = document.getElementById('duplicates-prev');
  const next = document.getElementById('duplicates-next');
  const pageLabel = document.getElementById('duplicates-page');
  const PAGE_SIZE = 50;
  let groups = [];
  let filtered = [];
  let offset = 0;
  let requestId = null;
  let drivesLoaded = false;
  let loadingDrives = false;

  function formatBytes(bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return `${value.toFixed(unit && value < 10 ? 1 : 0)} ${units[unit]}`;
  }

  function clearResults() {
    groups = [];
    filtered = [];
    offset = 0;
    query.value = '';
    chart.replaceChildren();
    results.hidden = true;
    rows.replaceChildren();
    count.textContent = 'Choose a drive to start duplicate analysis.';
    status.textContent = '';
    error.hidden = true;
    error.textContent = '';
  }

  function fileName(group) {
    return group.paths[0].split(/[\\/]/).pop();
  }

  function renderPage(selectedGroup = null) {
    const page = filtered.slice(offset, offset + PAGE_SIZE);
    rows.replaceChildren(...page.map(group => {
      const row = document.createElement('tr');
      for (const text of [group.copyCount.toLocaleString(), formatBytes(group.sizeBytes),
        formatBytes(group.duplicateLogicalBytes)]) {
        const cell = document.createElement('td');
        cell.textContent = text;
        row.append(cell);
      }
      const cell = document.createElement('td');
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = `${fileName(group)} (${group.paths.length.toLocaleString()} paths)`;
      details.append(summary);
      let loaded = false;
      const showPaths = () => {
        if (loaded || !details.open) return;
        loaded = true;
        const list = document.createElement('div');
        list.className = 'duplicate-paths';
        for (const filePath of group.paths) {
          const item = document.createElement('span');
          item.textContent = filePath;
          list.append(item);
        }
        details.append(list);
      };
      details.addEventListener('toggle', showPaths);
      if (group === selectedGroup) {
        details.open = true;
        showPaths();
      }
      cell.append(details);
      row.append(cell);
      return row;
    }));
    pageLabel.textContent = filtered.length
      ? `${offset + 1}–${Math.min(offset + PAGE_SIZE, filtered.length)} of ${filtered.length.toLocaleString()} groups`
      : 'No matching duplicate groups.';
    previous.disabled = offset === 0;
    next.disabled = offset + PAGE_SIZE >= filtered.length;
    if (selectedGroup) {
      const row = rows.children[page.indexOf(selectedGroup)];
      row?.scrollIntoView({ block: 'nearest' });
      row?.querySelector('summary')?.focus();
    }
  }

  function updateList() {
    const text = query.value.trim().toLowerCase();
    filtered = groups.filter(group => !text || group.paths.some(filePath => filePath.toLowerCase().includes(text)));
    filtered.sort((left, right) => sort.value === 'name'
      ? fileName(left).localeCompare(fileName(right))
      : sort.value === 'copies' ? right.copyCount - left.copyCount
        : right.duplicateLogicalBytes - left.duplicateLogicalBytes);
    offset = 0;
    const top = [...filtered].sort((left, right) => right.duplicateLogicalBytes - left.duplicateLogicalBytes).slice(0, 10);
    const maximum = top[0]?.duplicateLogicalBytes || 0;
    chart.replaceChildren(...top.map(group => {
      const bar = document.createElement('button');
      bar.type = 'button';
      bar.className = 'duplicate-bar';
      bar.title = group.paths[0];
      const label = document.createElement('span');
      label.className = 'duplicate-bar-label';
      label.textContent = fileName(group);
      const track = document.createElement('span');
      track.className = 'duplicate-bar-track';
      track.setAttribute('aria-hidden', 'true');
      const fill = document.createElement('span');
      fill.className = 'duplicate-bar-fill';
      fill.style.width = `${maximum ? group.duplicateLogicalBytes / maximum * 100 : 0}%`;
      track.append(fill);
      const value = document.createElement('span');
      value.className = 'duplicate-bar-value';
      value.textContent = formatBytes(group.duplicateLogicalBytes);
      bar.setAttribute('aria-label', `${fileName(group)}, ${group.copyCount} copies, ${value.textContent} extra logical bytes. Show paths.`);
      bar.append(label, track, value);
      bar.addEventListener('click', () => {
        offset = Math.floor(filtered.indexOf(group) / PAGE_SIZE) * PAGE_SIZE;
        renderPage(group);
      });
      return bar;
    }));
    renderPage();
  }

  query.addEventListener('input', updateList);
  sort.addEventListener('change', updateList);
  previous.addEventListener('click', () => {
    offset = Math.max(0, offset - PAGE_SIZE);
    renderPage();
  });
  next.addEventListener('click', () => {
    if (offset + PAGE_SIZE < filtered.length) offset += PAGE_SIZE;
    renderPage();
  });

  function updateAvailability() {
    const busy = scanInProgress || fileActionInProgress;
    driveSelect.disabled = !drivesLoaded || busy;
    scopeSelect.disabled = busy;
    button.disabled = !driveSelect.value || busy;
  }

  async function loadDrives() {
    if (drivesLoaded || loadingDrives) return;
    loadingDrives = true;
    driveSelect.disabled = true;
    error.hidden = true;
    error.textContent = '';
    try {
      const result = await window.electronAPI.listDrives();
      if (!Array.isArray(result.drives)) throw new Error(result.error || 'Drive list is unavailable.');
      driveSelect.replaceChildren();
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = result.drives.length ? 'Choose a drive...' : 'No drives found';
      driveSelect.append(placeholder);
      for (const drive of result.drives) {
        const option = document.createElement('option');
        option.value = drive.path;
        option.textContent = drive.label;
        option.title = drive.path;
        driveSelect.append(option);
      }
      drivesLoaded = true;
      count.textContent = result.drives.length
        ? 'Choose a drive to start duplicate analysis.'
        : 'No accessible local drives were found.';
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
      count.textContent = 'Unable to list local drives.';
    } finally {
      loadingDrives = false;
      updateAvailability();
    }
  }

  function renderResult(result) {
    groups = result.groups;
    results.hidden = false;
    query.value = '';
    document.getElementById('duplicates-bytes').textContent = formatBytes(result.duplicateLogicalBytes);
    document.getElementById('duplicates-groups').textContent = groups.length.toLocaleString();
    document.getElementById('duplicates-files').textContent = result.filesScanned.toLocaleString();
    count.textContent = `${result.skippedCount.toLocaleString()} skipped · ${result.unverified.length.toLocaleString()} unverified`;
    status.textContent = `${result.scopePath} · ${result.scope === 'user' ? 'User files' : 'Entire drive'}${result.inventoryReused ? ' · Based on last drive scan; Rescan for newer files.' : ''}`;
    status.title = `${result.excludedFileCount.toLocaleString()} system/application files excluded. Extra logical bytes are not an estimate of physical disk space freed.`;
    updateList();
  }

  if (window.electronAPI?.onDuplicateProgress) {
    window.electronAPI.onDuplicateProgress(progress => {
      if (progress.requestId !== requestId || cancellationRequested) return;
      status.textContent = progress.stage === 'hash'
        ? `Verifying file contents: ${progress.completed.toLocaleString()} of ${progress.total.toLocaleString()} candidate files.`
        : progress.stage === 'sample'
          ? `Comparing small content samples: ${progress.completed.toLocaleString()} of ${progress.total.toLocaleString()} candidate files.`
        : progress.stage === 'validate'
          ? `Validating files from the scan: ${progress.filesScanned.toLocaleString()} checked. No directory rescan.`
          : `Building the full-drive inventory for ${progress.scopePath}: ${progress.filesScanned.toLocaleString()} files visited.`;
    });
  }

  driveSelect.addEventListener('change', () => {
    clearResults();
    if (driveSelect.value) count.textContent = `Ready to analyze ${driveSelect.value}.`;
    updateAvailability();
  });
  scopeSelect.addEventListener('change', () => {
    clearResults();
    updateAvailability();
  });

  button.addEventListener('click', async () => {
    const drivePath = driveSelect.value;
    const scope = scopeSelect.value;
    if (!drivePath || scanInProgress || fileActionInProgress) return;
    requestId = ++scanRequestId;
    scanOperation = 'duplicates';
    scanInProgress = true;
    cancellationRequested = false;
    setScanControls(true);
    updateAvailability();
    clearResults();
    count.textContent = `Preparing a duplicate analysis for ${drivePath}...`;
    status.textContent = 'Reading file contents only because you started this analysis. Online-only cloud files may be downloaded by Windows.';
    try {
      const result = await window.electronAPI.findDuplicates(drivePath, requestId, scope);
      if (result.cancelled) {
        count.textContent = 'Duplicate analysis cancelled. No incomplete results are shown.';
        status.textContent = '';
        return;
      }
      if (!result.success) throw new Error(result.error || 'Duplicate analysis did not finish.');
      if (drivePath !== driveSelect.value) return;
      renderResult(result);
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
      count.textContent = 'Unable to finish duplicate analysis.';
      status.textContent = '';
    } finally {
      requestId = null;
      scanInProgress = false;
      cancellationRequested = false;
      scanOperation = 'scan';
      setScanControls(false);
      updateAvailability();
    }
  });

  document.addEventListener('diskoryx:duplicates-view', () => {
    panel.hidden = false;
    updateAvailability();
    void loadDrives();
  });
  document.addEventListener('diskoryx:view', event => {
    if (event.detail !== 'duplicates') panel.hidden = true;
  });
  document.addEventListener('diskoryx:result', () => {
    clearResults();
    updateAvailability();
  });
  document.addEventListener('diskoryx:scan-start', () => {
    panel.hidden = true;
    clearResults();
    updateAvailability();
  });
  document.addEventListener('diskoryx:files-changed', () => {
    clearResults();
    count.textContent = 'The live scan changed. Run duplicate analysis again for an up-to-date result.';
  });

  updateAvailability();
})();
