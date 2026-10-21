const { randomUUID } = require('node:crypto');

function createRecycleConfirmation(ipcMain) {
  let pending = null;
  ipcMain.handle('confirm-recycle', (event, requestId, accepted) => {
    if (!pending || pending.sender !== event.sender || pending.requestId !== requestId
      || typeof accepted !== 'boolean') {
      return { error: 'This confirmation is no longer active.' };
    }
    pending.finish(accepted);
    return { success: true };
  });

  return (sender, itemPath) => new Promise((resolve, reject) => {
    if (pending) return reject(new Error('Another confirmation is already open.'));
    const requestId = randomUUID();
    const closed = () => finish(false);
    const finish = accepted => {
      clearTimeout(timer);
      sender.removeListener('destroyed', closed);
      sender.removeListener('did-start-loading', closed);
      pending = null;
      if (!sender.isDestroyed()) sender.send('recycle-confirmation-closed', requestId);
      resolve(accepted);
    };
    const timer = setTimeout(() => finish(false), 120000);
    pending = { sender, requestId, finish };
    sender.once('destroyed', closed);
    sender.once('did-start-loading', closed);
    try {
      sender.send('recycle-confirmation', { requestId, path: itemPath });
    } catch (error) {
      clearTimeout(timer);
      sender.removeListener('destroyed', closed);
      sender.removeListener('did-start-loading', closed);
      pending = null;
      reject(error);
    }
  });
}

module.exports = { createRecycleConfirmation };
