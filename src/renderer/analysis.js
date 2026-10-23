(() => {
  const panel = document.getElementById('analysis-panel');
  const rows = document.getElementById('analysis-rows');
  const more = document.getElementById('analysis-more');
  const error = document.getElementById('analysis-error');
  const order = document.getElementById('analysis-order');
  const minimum = document.getElementById('analysis-min');
  const query = document.getElementById('analysis-query');
  let view = 'explorer';
  let request = 0;
  let loaded = 0;
  let extension = '';
  const chart = document.getElementById('largest-chart');

  function drawChart(items) {
    chart.replaceChildren();
    chart.hidden = view !== 'largest' || order.value !== 'size' || !items.length;
    if (chart.hidden) return;
    const maximum = Math.max(...items.map(item => item.rawSize), 1);
    for (const item of items.slice(0, 8)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'largest-chart-row';
      button.title = item.path;
      const name = document.createElement('span');
      name.textContent = item.name;
      const track = document.createElement('span');
      track.className = 'largest-chart-track';
      const bar = document.createElement('span');
      bar.style.width = `${item.rawSize / maximum * 100}%`;
      track.append(bar);
      const size = document.createElement('span');
      size.textContent = item.size;
      button.append(name, track, size);
      button.addEventListener('click', () => {
        select('explorer'); showFileDetails(item); void syncTreeToMapItem(item);
      });
      button.addEventListener('contextmenu', event => showFileContextMenu(item, event));
      chart.append(button);
    }
  }

  function cell(row, text) {
    const td = document.createElement('td');
    td.textContent = text;
    row.append(td);
    return td;
  }

  async function load(append = false) {
    const token = ++request;
    const scanId = currentScanId;
    more.hidden = true;
    more.disabled = true;
    error.hidden = true;
    if (!append) { rows.replaceChildren(); chart.hidden = true; loaded = 0; }
    if (!scanId || !currentResult) {
      document.getElementById('analysis-count').textContent = 'Scan a location first.';
      return;
    }
    document.getElementById('analysis-count').textContent = 'Loading cached scan...';
    try {
      const result = await window.electronAPI.analysisPage(scanId, {
        view, offset: append ? loaded : 0, order: order.value, query: query.value,
        minBytes: Number(minimum.value) * 1024 * 1024, extension, scanFilters: currentScanFilters
      });
      if (token !== request || scanId !== currentScanId || view === 'explorer') return;
      if (!result.success) throw new Error(result.error);
      if (!append) drawChart(result.items);
      for (const item of result.items) {
        const row = document.createElement('tr');
        if (view === 'largest') {
          const name = document.createElement('button');
          name.type = 'button';
          name.textContent = item.name;
          name.title = 'Open in Disk overview and Inspector';
          name.addEventListener('click', () => {
            select('explorer');
            showFileDetails(item);
            void syncTreeToMapItem(item);
          });
          name.addEventListener('contextmenu', event => showFileContextMenu(item, event));
          cell(row, '').append(name);
          cell(row, item.path);
          cell(row, item.size);
          cell(row, item.date ? new Date(item.date).toLocaleString() : '--');
          cell(row, item.isHardLinkAlias ? 'Alias (0 counted)' : item.hardLinkCount > 1 ? `${item.hardLinkCount} links` : '');
        } else {
          const drill = document.createElement('button');
          drill.type = 'button';
          drill.textContent = item.name;
          drill.title = 'Show matching files in Largest files';
          drill.addEventListener('click', () => { extension = item.extension; select('largest', true); });
          cell(row, '').append(drill);
          cell(row, item.count.toLocaleString());
          cell(row, item.size);
          cell(row, `${item.percent.toFixed(2)}%`);
          cell(row, item.largest);
        }
        rows.append(row);
      }
      loaded += result.items.length;
      document.getElementById('analysis-count').textContent =
        `${loaded.toLocaleString()} of ${result.totalCount.toLocaleString()} ${view === 'types' ? 'types' : 'files'}${extension ? ` | .${extension}` : ''}`;
      more.hidden = loaded >= result.totalCount;
    } catch (failure) {
      if (token === request) {
        error.textContent = failure.message;
        error.hidden = false;
        document.getElementById('analysis-count').textContent = 'Unable to load view';
      }
    } finally { if (token === request) more.disabled = false; }
  }

  function select(next, drill = false) {
    if (!['explorer', 'largest', 'types', 'duplicates'].includes(next) || scanInProgress || fileActionInProgress) return;
    view = next;
    ++request;
    if (!drill) extension = '';
    const analysis = view !== 'explorer';
    panel.hidden = !analysis || view === 'duplicates';
    document.getElementById('duplicates-panel').hidden = view !== 'duplicates';
    document.body.classList.toggle('analysis-active', analysis);
    document.body.classList.toggle('duplicates-active', view === 'duplicates');
    const title = view === 'largest' ? 'Largest files' : view === 'types' ? 'File types'
      : view === 'duplicates' ? 'Duplicate finder' : 'Disk overview';
    document.querySelector('.header-left h1').textContent = title;
    document.getElementById('analysis-title').textContent = title;
    document.querySelectorAll('[data-view]').forEach(button => {
      const active = button.dataset.view === view;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    if (!analysis) return;
    if (view === 'duplicates') {
      document.dispatchEvent(new CustomEvent('diskoryx:duplicates-view'));
      return;
    }
    order.querySelector('option[value="date"]').disabled = view === 'types';
    if (view === 'types' && order.value === 'date') order.value = 'size';
    const head = document.getElementById('analysis-head');
    head.replaceChildren();
    const row = document.createElement('tr');
    for (const label of view === 'largest' ? ['Name', 'Full path', 'Logical size', 'Modified', 'Hard links']
      : ['Extension', 'Files', 'Counted size', 'Of matched size', 'Largest logical file']) {
      const th = document.createElement('th');
      th.textContent = label;
      row.append(th);
    }
    head.append(row);
    void load();
  }
  document.addEventListener('diskoryx:view', event => select(event.detail));
  document.addEventListener('diskoryx:result', () => {
    if (view !== 'explorer' && view !== 'duplicates') void load();
  });
  document.addEventListener('diskoryx:files-changed', () => {
    ++request;
    rows.replaceChildren();
    chart.replaceChildren();
    chart.hidden = true;
    more.hidden = true;
    document.getElementById('analysis-count').textContent = 'Updating scan snapshot...';
  });
  document.addEventListener('diskoryx:scan-start', () => {
    // The event occurs after scanInProgress is set; only presentation is reset.
    view = 'explorer'; ++request; panel.hidden = true;
    document.getElementById('duplicates-panel').hidden = true;
    document.body.classList.remove('analysis-active');
    document.body.classList.remove('duplicates-active');
    document.querySelector('.header-left h1').textContent = 'Disk overview';
    document.querySelectorAll('[data-view]').forEach(button => {
      button.classList.toggle('is-active', button.dataset.view === 'explorer');
      button.setAttribute('aria-pressed', String(button.dataset.view === 'explorer'));
    });
  });
  document.getElementById('analysis-filters').addEventListener('submit', event => {
    event.preventDefault();
    if (!scanInProgress && !fileActionInProgress) void load();
  });
  more.addEventListener('click', () => { if (!scanInProgress && !fileActionInProgress) void load(true); });
  document.getElementById('analysis-reset').addEventListener('click', () => {
    if (scanInProgress || fileActionInProgress) return;
    query.value = ''; minimum.value = '0'; order.value = 'size'; extension = ''; void load();
  });
})();
