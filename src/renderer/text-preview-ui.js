(() => {
  const dialog = document.getElementById('text-preview-dialog');
  const content = document.getElementById('preview-content');
  const status = document.getElementById('preview-status');
  const position = document.getElementById('preview-position');
  const input = document.getElementById('preview-page-number');
  const count = document.getElementById('preview-page-count');
  const first = document.getElementById('preview-first');
  const previous = document.getElementById('preview-previous');
  const next = document.getElementById('preview-next');
  const last = document.getElementById('preview-last');
  const reload = document.getElementById('preview-reload');
  const go = document.querySelector('#preview-page-form button');
  let selection = null;
  let result = null;
  let requestId = 0;
  let loading = false;
  let failed = false;

  function updateControls() {
    first.disabled = previous.disabled = loading || failed || !result || result.page === 0;
    next.disabled = last.disabled = loading || failed || !result || result.page + 1 >= result.pageCount;
    input.disabled = go.disabled = loading || failed || !result;
    reload.disabled = loading || !selection;
    content.setAttribute('aria-busy', String(loading));
  }

  async function loadPage(page, fresh = false) {
    if (!selection) return;
    const currentRequest = ++requestId;
    const selected = selection;
    loading = true;
    failed = false;
    content.textContent = '';
    position.textContent = '';
    status.textContent = 'Reading file page...';
    status.classList.remove('is-error');
    updateControls();
    try {
      const response = await window.electronAPI.readTextPreview(
        selected.scanId, selected.file.path, page, fresh ? null : result?.revision || null
      );
      if (currentRequest !== requestId || !dialog.open) return;
      if (!response.success) throw new Error(response.error || 'The preview could not be loaded.');
      result = response;
      content.textContent = response.text;
      content.scrollTop = content.scrollLeft = 0;
      input.value = String(response.page + 1);
      input.max = String(response.pageCount);
      count.textContent = `of ${response.pageCount.toLocaleString()}`;
      status.textContent = response.fileSize === 0
        ? 'This file is empty.'
        : response.pageCount > 1
          ? `Showing page ${response.page + 1} of ${response.pageCount.toLocaleString()}. Use navigation to read the entire file. Pages may split a line.`
          : 'Entire file shown.';
      position.textContent = `${response.encoding.toUpperCase()} · Bytes ${response.startByte.toLocaleString()}–${response.endByte.toLocaleString()} of ${response.fileSize.toLocaleString()}`;
    } catch (error) {
      if (currentRequest !== requestId || !dialog.open) return;
      failed = true;
      status.textContent = error.message;
      status.classList.add('is-error');
    } finally {
      if (currentRequest === requestId) {
        loading = false;
        updateControls();
      }
    }
  }

  first.addEventListener('click', () => loadPage(0));
  previous.addEventListener('click', () => loadPage(result.page - 1));
  next.addEventListener('click', () => loadPage(result.page + 1));
  last.addEventListener('click', () => loadPage(result.pageCount - 1));
  reload.addEventListener('click', () => loadPage(0, true));
  document.getElementById('preview-page-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!loading && !failed && result && event.target.reportValidity()) loadPage(Number(input.value) - 1);
  });
  document.getElementById('preview-word-wrap').addEventListener('change', event => {
    content.classList.toggle('no-wrap', !event.target.checked);
  });
  document.getElementById('text-preview-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    requestId++;
    content.textContent = '';
    result = null;
    loading = false;
  });
  function clearSelection() {
    if (dialog.open) dialog.close();
    selection = null;
    document.querySelector('.open-text-preview')?.remove();
  }
  document.addEventListener('diskoryx:scan-start', clearSelection);
  document.addEventListener('diskoryx:files-changed', clearSelection);
  document.addEventListener('diskoryx:selection', event => {
    const selected = event.detail;
    const panel = document.querySelector('.file-details-content');
    if (!panel) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'open-text-preview';
    button.textContent = 'Open file preview';
    button.addEventListener('click', () => {
      selection = selected;
      result = null;
      count.textContent = 'of ...';
      input.value = '1';
      document.getElementById('text-preview-title').textContent = selected.file.name;
      document.getElementById('text-preview-path').textContent = selected.file.path;
      dialog.showModal();
      void loadPage(0, true);
    });
    panel.prepend(button);
  });
})();
