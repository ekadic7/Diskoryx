const divider = document.getElementById('pane-divider');
const panes = document.querySelector('.explorer-panes');
const inspectorToggle = document.getElementById('inspector-toggle');
const themeToggle = document.getElementById('theme-toggle');
let capacityRequestId = 0;

function formatCapacity(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit > 0 && value < 10 ? 1 : 0)} ${units[unit]}`;
}

function showCapacityError(message) {
  document.getElementById('capacity-free').textContent = 'Unavailable';
  document.getElementById('capacity-total').textContent = message;
  document.getElementById('capacity-volume').textContent = '';
  document.getElementById('capacity-track').hidden = true;
}

function setPaneShare(share) {
  const safeShare = Math.max(35, Math.min(70, share));
  panes.style.setProperty('--table-share', `${safeShare}fr`);
  panes.style.setProperty('--map-share', `${100 - safeShare}fr`);
  divider.setAttribute('aria-valuenow', String(Math.round(safeShare)));
}

divider.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  divider.setPointerCapture(event.pointerId);
});

divider.addEventListener('pointermove', event => {
  if (!divider.hasPointerCapture(event.pointerId)) return;
  const bounds = panes.getBoundingClientRect();
  if (bounds.width) setPaneShare((event.clientX - bounds.left) / bounds.width * 100);
});

divider.addEventListener('pointerup', event => {
  if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId);
});

divider.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
  event.preventDefault();
  const current = Number(divider.getAttribute('aria-valuenow'));
  setPaneShare(event.key === 'Home' ? 52 : current + (event.key === 'ArrowRight' ? 3 : -3));
});

inspectorToggle.addEventListener('click', () => {
  const hidden = document.body.classList.toggle('inspector-hidden');
  inspectorToggle.setAttribute('aria-expanded', String(!hidden));
});

themeToggle.addEventListener('click', () => {
  const light = document.body.dataset.theme !== 'light';
  document.body.dataset.theme = light ? 'light' : 'dark';
  const label = light ? 'Dark appearance' : 'Light appearance';
  themeToggle.querySelector('span').textContent = label;
  themeToggle.setAttribute('aria-label', `Switch to ${light ? 'dark' : 'light'} theme`);
});

document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    document.getElementById('search-input').focus();
  }
});

document.querySelectorAll('[data-view]').forEach(button => {
  button.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('diskoryx:view', { detail: button.dataset.view }));
  });
});

document.addEventListener('diskoryx:result', event => {
  const result = event.detail;
  document.getElementById('location-label').textContent = result.folderPath;
  document.getElementById('location-label').title = result.folderPath;
  document.getElementById('metric-size').textContent = result.totalSizeFormatted;
  document.getElementById('metric-files').textContent = result.fileCount.toLocaleString();
  document.getElementById('metric-folders').textContent = `${result.folderCount.toLocaleString()} folders in this scan`;
  document.getElementById('metric-duration').textContent = formatDuration(result.scanDurationMs);
  document.getElementById('metric-rate').textContent = formatRate(result.entriesPerSecond);
  document.getElementById('metric-skipped').textContent = (result.skippedCount || 0).toLocaleString();
  document.getElementById('metric-coverage').textContent = `${result.filteredCount || 0} files filtered / ${result.excludedFolderCount || 0} folders excluded`;
  const requestId = ++capacityRequestId;
  const card = document.getElementById('disk-capacity-card');
  card.hidden = false;
  document.getElementById('capacity-free').textContent = 'Checking...';
  document.getElementById('capacity-total').textContent = 'Reading current volume capacity';
  document.getElementById('capacity-track').hidden = false;
  void window.electronAPI.volumeCapacity(result.scanId).then(capacity => {
    if (requestId !== capacityRequestId) return;
    if (!capacity.success) throw new Error(capacity.error || 'Capacity information is unavailable.');
    const total = capacity.totalBytes;
    const available = capacity.availableBytes;
    if (!Number.isFinite(total) || !Number.isFinite(available) || total <= 0 || available < 0) {
      throw new Error('Windows returned invalid volume capacity.');
    }
    const free = Math.min(total, available);
    const usedPercent = Math.max(0, Math.min(100, (total - free) / total * 100));
    const volumePath = typeof capacity.volumePath === 'string' ? capacity.volumePath : '';
    document.getElementById('capacity-volume').textContent = volumePath.replace(/[\\/]+$/, '') || volumePath;
    document.getElementById('capacity-free').textContent = formatCapacity(free);
    document.getElementById('capacity-total').textContent = `free of ${formatCapacity(total)} total`;
    const track = document.getElementById('capacity-track');
    track.setAttribute('aria-valuenow', String(Math.round(usedPercent)));
    track.setAttribute('aria-valuetext', `${Math.round(usedPercent)}% used`);
    document.getElementById('capacity-fill').style.width = `${usedPercent}%`;
  }).catch(error => {
    if (requestId === capacityRequestId) showCapacityError(error.message);
  });
});
