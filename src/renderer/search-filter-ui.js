(function () {
  const SearchFilters = window.SearchFilters || globalThis.SearchFilters;
  const input = document.getElementById('search-input');
  const chips = document.getElementById('search-filter-chips');
  const dialog = document.getElementById('search-filter-dialog');
  const form = document.getElementById('search-filter-form');
  const preview = document.getElementById('search-filter-preview');
  const errorText = document.getElementById('search-filter-error');
  const sizeOperator = document.getElementById('size-operator');
  const sizeValue = document.getElementById('size-value');
  const sizeUnit = document.getElementById('size-unit');
  const modifiedOperator = document.getElementById('modified-operator');
  const modifiedValue = document.getElementById('modified-value');
  const filterButton = document.getElementById('search-filter-btn');
  let pendingCandidate = null;

  // Dialog fields: produce one token of each kind, or null if a field is empty.
  function sizeToken() {
    const value = sizeValue.value.trim();
    if (!value) return null;
    return { kind: 'size', token: SearchFilters.buildFilterToken('size', sizeOperator.value, value, sizeUnit.value) };
  }

  function modifiedToken() {
    const value = modifiedValue.value;
    if (!value) return null;
    return { kind: 'modified', token: SearchFilters.buildFilterToken('modified', modifiedOperator.value, value) };
  }

  // Collects every filled field. A field with text that does not produce a valid token is an error.
  function currentCandidates() {
    const tokens = [];
    const size = sizeToken();
    const modified = modifiedToken();
    for (const chosen of [size, modified]) {
      if (!chosen) continue;
      if (!chosen.token) return { tokens: [], error: 'That value is not valid for this filter.' };
      tokens.push(chosen.token);
    }
    if (tokens.length === 0) return { tokens: [], error: 'Fill in at least one size or date filter.' };
    return { tokens, error: '' };
  }

  function appendAll(text, tokens) {
    return tokens.reduce((current, token) => SearchFilters.appendFilter(current, token), text);
  }

  function refreshPreview() {
    const candidate = currentCandidates();
    pendingCandidate = candidate.tokens;
    errorText.textContent = candidate.error;
    errorText.hidden = !candidate.error;
    preview.textContent = candidate.tokens.length
      ? appendAll(input.value, candidate.tokens)
      : input.value.trim();
  }

  function renderChips() {
    const filters = SearchFilters.listFilters(input.value);
    chips.replaceChildren();
    for (const filter of filters) {
      const chip = document.createElement('span');
      chip.className = 'search-filter-chip';
      const label = document.createElement('span');
      label.textContent = filter.label;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = `Remove ${filter.label}`;
      remove.setAttribute('aria-label', `Remove ${filter.label}`);
      remove.addEventListener('click', () => {
        input.value = SearchFilters.removeFilterAt(input.value, filter.index);
        renderChips();
        input.focus();
      });
      chip.append(label, remove);
      chips.append(chip);
    }
    chips.hidden = filters.length === 0;
  }

  filterButton.addEventListener('click', () => {
    form.reset();
    modifiedValue.value = '';
    sizeUnit.value = 'MB';
    refreshPreview();
    dialog.showModal();
    sizeValue.focus();
  });

  for (const field of [sizeOperator, sizeValue, sizeUnit, modifiedOperator, modifiedValue]) {
    field.addEventListener('input', refreshPreview);
    field.addEventListener('change', refreshPreview);
  }

  document.getElementById('cancel-search-filter').addEventListener('click', () => dialog.close());

  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!pendingCandidate || pendingCandidate.length === 0) {
      refreshPreview();
      return;
    }
    input.value = appendAll(input.value, pendingCandidate);
    dialog.close();
    renderChips();
    input.focus();
  });

  input.addEventListener('input', renderChips);
  renderChips();
})();
