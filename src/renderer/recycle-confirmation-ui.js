(() => {
  const dialog = document.getElementById('recycle-dialog');
  const cancel = document.getElementById('recycle-cancel');
  const confirm = document.getElementById('recycle-confirm');
  const error = document.getElementById('recycle-error');
  let requestId = null;
  let sending = null;

  async function respond(accepted) {
    if (!requestId || sending) return;
    const respondingTo = requestId;
    sending = respondingTo;
    cancel.disabled = confirm.disabled = true;
    try {
      const result = await window.electronAPI.confirmRecycle(respondingTo, accepted);
      if (requestId !== respondingTo) return;
      if (!result.success) throw new Error(result.error || 'Unable to confirm this action.');
      requestId = null;
      dialog.close();
    } catch (failure) {
      if (requestId !== respondingTo) return;
      error.textContent = failure.message;
      error.hidden = false;
    } finally {
      if (sending === respondingTo) {
        sending = null;
        cancel.disabled = confirm.disabled = false;
      }
    }
  }

  window.electronAPI.onRecycleConfirmation(request => {
    requestId = request.requestId;
    sending = null;
    cancel.disabled = confirm.disabled = false;
    document.getElementById('recycle-path').textContent = request.path;
    error.hidden = true;
    dialog.showModal();
    cancel.focus();
  });
  window.electronAPI.onRecycleConfirmationClosed(id => {
    if (id !== requestId) return;
    requestId = null;
    sending = null;
    cancel.disabled = confirm.disabled = false;
    dialog.close();
  });
  cancel.addEventListener('click', () => respond(false));
  confirm.addEventListener('click', () => respond(true));
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    void respond(false);
  });
  dialog.addEventListener('close', () => {
    if (!dialog.open && requestId) void respond(false);
  });
})();
