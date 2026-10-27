'use strict';

// The camera recorder's Electron boundary. Only Switchboard's main document may
// send bytes; neither an embedded player nor a renderer-supplied path can choose a
// destination. The renderer stops MediaRecorder before acknowledging a close.
const { createRecordingStore } = require('./recordings');

function createRecordingSession({
  ipcMain,
  getWindow,
  directory,
  rendererUrl,
  systemPreferences,
  shell,
  platform = process.platform,
  flushTimeout = 10000,
  store = createRecordingStore({ directory }),
}) {
  let closing = false;
  let flushing = null;
  let flushRequest = null;
  let flushId = 0;
  let interrupting = null;
  let permissions = null;
  let lastPath = null;

  function trusted(event) {
    const win = getWindow();
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false;
    return event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame &&
      typeof event.senderFrame?.url === 'string' &&
      event.senderFrame.url.split('#')[0] === rendererUrl;
  }

  function register(name, action) {
    ipcMain.handle(`sb:recording:${name}`, async (event, ...args) => {
      if (!trusted(event)) return { ok: false, error: 'Recording is available only in Switchboard.' };
      try {
        return await action(...args);
      } catch (error) {
        return { ok: false, error: error?.message || 'The recording could not be saved.' };
      }
    });
  }

  function remember(result) {
    const kept = result?.ok ? result.data?.path : result?.recoveryPath;
    if (typeof kept === 'string') lastPath = kept;
    return result;
  }

  function startAllowed() {
    return !closing && !interrupting;
  }

  function closingError() {
    return { ok: false, error: 'Switchboard is closing. Start a recording after reopening it.' };
  }

  async function requestPermissions() {
    if (platform !== 'darwin') return { ok: true, data: null };
    if (!systemPreferences?.getMediaAccessStatus || !systemPreferences?.askForMediaAccess) {
      return { ok: false, error: 'Camera access is unavailable in this build of Switchboard.' };
    }
    for (const type of ['camera', 'microphone']) {
      if (!startAllowed()) return closingError();
      const status = systemPreferences.getMediaAccessStatus(type);
      const granted = status === 'granted' ||
        (status !== 'denied' && status !== 'restricted' && await systemPreferences.askForMediaAccess(type));
      if (!startAllowed()) return closingError();
      if (!granted) {
        const pane = type === 'camera' ? 'Camera' : 'Microphone';
        return {
          ok: false,
          error: `Allow Switchboard to use your ${type} in System Settings > Privacy & Security > ${pane}, then try again.`,
        };
      }
    }
    return { ok: true, data: null };
  }

  register('permissions', () => {
    if (!startAllowed()) return closingError();
    if (!permissions) permissions = requestPermissions().finally(() => { permissions = null; });
    return permissions;
  });
  register('start', mimeType => startAllowed() ? store.start({ mimeType }) : closingError());
  // Writes and Finish remain available while closing: they drain the recorder's
  // final dataavailable event, including a short recording's very first chunk.
  register('append', (id, sequence, bytes) => store.append(id, sequence, bytes));
  register('finish', async id => remember(await store.finish(id)));
  register('reveal', () => {
    if (!lastPath) return { ok: false, error: 'There is no saved recording to show yet.' };
    shell.showItemInFolder(lastPath);
    return { ok: true, data: null };
  });
  register('flushed', (id, result) => {
    if (flushRequest && id === flushRequest.id) {
      flushRequest.done(result?.ok === true ? { ok: true } : {
        ok: false,
        error: typeof result?.error === 'string'
          ? result.error.slice(0, 600) : 'The recording could not finish saving.',
      });
    }
    return { ok: true, data: null };
  });

  function flush() {
    if (flushing) return flushing;
    closing = true;
    const win = getWindow();
    const live = win && !win.isDestroyed() && !win.webContents.isDestroyed();
    const acknowledgment = !live ? Promise.resolve({ ok: true }) : new Promise(resolve => {
      const id = ++flushId;
      let timer;
      const done = result => {
        if (flushRequest?.id !== id) return;
        clearTimeout(timer);
        flushRequest = null;
        resolve(result);
      };
      flushRequest = { id, done };
      timer = setTimeout(() => done({
        ok: false,
        error: 'The camera recorder did not finish saving in time. Any saved portion is kept in the recordings folder.',
      }), flushTimeout);
      try { win.webContents.send('sb:evt:recordingFlush', id); }
      catch (_) { done({ ok: false, error: 'The camera recorder was interrupted while saving.' }); }
    });

    flushing = acknowledgment.then(async result => {
      // Also catches a file open that was already in flight when Start was canceled.
      const disposed = remember(await store.dispose());
      if (!disposed.ok) return { ok: false, error: disposed.error };
      if (disposed.data?.bytes > 0 && result.ok) {
        return { ok: false, error: 'The recording was interrupted. Its saved portion is kept in the recordings folder.' };
      }
      return result;
    }).catch(error => ({ ok: false, error: error?.message || 'The recording could not finish saving.' }))
      .finally(() => { flushing = null; });
    return flushing;
  }

  function interrupt() {
    if (interrupting) return interrupting;
    closing = true;
    // No renderer remains to answer a pending close. Finish its cleanup before a
    // replacement renderer can create a new file in this same store.
    flushRequest?.done({ ok: true });
    interrupting = (async () => {
      if (flushing) await flushing;
      return remember(await store.dispose());
    })().finally(() => {
      interrupting = null;
      closing = false;
    });
    return interrupting;
  }

  return {
    flush,
    resume() { closing = false; },
    interrupt,
  };
}

module.exports = { createRecordingSession };
