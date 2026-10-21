(() => {
  const dialog = document.getElementById('history-dialog');
  const rows = document.getElementById('history-rows');
  const status = document.getElementById('history-status');
  let loading = false;
  function cell(row, text) {
    const node = document.createElement('td');
    node.textContent = text;
    row.append(node);
    return node;
  }
  function location(cell, label, fullPath) {
    const block = document.createElement('div');
    block.className = 'history-location';
    const caption = document.createElement('span');
    caption.className = 'history-location-label';
    caption.textContent = label;
    const name = document.createElement('strong');
    name.textContent = fullPath.split('\\').pop() || fullPath;
    const value = document.createElement('span');
    value.className = 'history-path';
    value.textContent = fullPath;
    value.title = fullPath;
    block.append(caption, name, value);
    cell.append(block);
  }
  async function load() {
    rows.replaceChildren();
    status.textContent = 'Loading history...';
    const result = await window.electronAPI.actionHistory();
    if (!result.success) throw new Error(result.error || 'Unable to load history.');
    status.textContent = result.entries.length ? `${result.entries.length} actions` : 'No recorded file actions yet.';
    for (const entry of result.entries) {
      const row = document.createElement('tr');
      const time = cell(row, '');
      const date = new Date(entry.time);
      const day = document.createElement('span');
      day.textContent = date.toLocaleDateString();
      const clock = document.createElement('span');
      clock.className = 'history-clock';
      clock.textContent = date.toLocaleTimeString();
      time.append(day, clock);
      const kind = cell(row, '');
      const badge = document.createElement('span');
      badge.className = `history-kind is-${entry.kind}`;
      badge.textContent = entry.kind === 'rename' ? 'Rename' : entry.kind === 'copy' ? 'Copy' : entry.kind === 'move' ? 'Move' : 'Recycle';
      kind.append(badge);
      const paths = cell(row, '');
      location(paths, entry.kind === 'rename' ? 'Original' : 'From', entry.source);
      if (entry.destination) location(paths, entry.kind === 'rename' ? 'Renamed to' : 'To', entry.destination);
      const action = cell(row, '');
      const state = document.createElement('span');
      state.className = `history-state is-${entry.state}`;
      state.textContent = entry.state === 'restored' ? 'Restored from Recycle Bin' : entry.state === 'undone'
        ? entry.kind === 'copy' ? 'Copy moved to Recycle Bin' : entry.kind === 'move' ? 'Returned to original location' : 'Original name restored' : 'Completed';
      action.append(state);
      if (entry.canRestore) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = entry.state === 'done' ? 'Restore name' : 'Redo rename';
        button.addEventListener('click', async () => {
          if (loading || scanInProgress || fileActionInProgress) return;
          loading = true;
          button.disabled = true;
          setFileActionBusy(true);
          try {
            const restored = await window.electronAPI.restoreName(entry.id, currentScanId);
            if (restored.refreshRequired) invalidateFileActionView();
            if (!restored.success) throw new Error(restored.error || 'Unable to restore name.');
            if (!restored.unchanged) await refreshAfterFileAction(restored);
            await load();
          } catch (error) {
            showAppMessage(error.message, 'Name not restored');
          } finally {
            loading = false;
            button.disabled = false;
            setFileActionBusy(false);
          }
        });
        action.append(button);
      }
      if (entry.kind === 'copy' || entry.kind === 'move') {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = entry.kind === 'move'
          ? entry.state === 'done' ? 'Return to original location' : 'Redo move'
          : entry.state === 'done' ? 'Undo copy (Recycle Bin)' : 'Redo copy';
        button.addEventListener('click', async () => {
          if (loading || scanInProgress || fileActionInProgress) return;
          if (entry.kind === 'move') {
            await runCopyOperation(() => window.electronAPI.moveHistoryAction(entry.id));
          } else if (entry.state === 'undone') {
            await runCopyOperation(() => window.electronAPI.copyHistoryAction(entry.id));
          } else {
            loading = true; setFileActionBusy(true);
            try { await handleCopyResult(await (entry.kind === 'move'
              ? window.electronAPI.moveHistoryAction(entry.id)
              : window.electronAPI.copyHistoryAction(entry.id))); }
            catch (error) { showAppMessage(error.message, 'Copy undo refused'); }
            finally { loading = false; setFileActionBusy(false); }
          }
          try { await load(); } catch (error) { status.textContent = error.message; }
        });
        action.append(button);
      }
      if (entry.kind === 'recycle' && entry.state === 'done') {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Restore from Recycle Bin';
        button.addEventListener('click', async () => {
          if (loading || scanInProgress || fileActionInProgress) return;
          loading = true; setFileActionBusy(true); button.disabled = true;
          status.textContent = 'Finding the exact item in your Recycle Bin...';
          try { await handleCopyResult(await window.electronAPI.restoreRecycledItem(entry.id)); }
          catch (error) { showAppMessage(error.message, 'Restore not completed'); }
          finally { loading = false; setFileActionBusy(false); button.disabled = false; }
          try { await load(); } catch (error) { status.textContent = error.message; }
        });
        action.append(button);
      }
      rows.append(row);
    }
  }
  document.getElementById('history-btn').addEventListener('click', async () => {
    if (scanInProgress || fileActionInProgress || loading) return;
    dialog.showModal();
    document.getElementById('history-close').focus();
    try { await load(); } catch (error) { status.textContent = error.message; }
  });
})();
