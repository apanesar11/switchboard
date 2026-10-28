'use strict';

// The countdown belongs to the saved board, not to a mounted React canvas. Only its
// deadline is scheduled here; ticking never rewrites a board or adds undo entries.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function timerKey(item) {
  return crypto.createHash('sha256').update(JSON.stringify([item.boardId, item.nodeId, item.endsAt])).digest('hex');
}

function timersOf(board) {
  if (!board || board.archivedAt || !board.spec || !Array.isArray(board.spec.nodes)) return [];
  return board.spec.nodes.flatMap(node => {
    const timer = node && node.timer;
    if (!node || node.shape !== 'timer' || typeof node.id !== 'string' || !timer ||
        (timer.status !== 'running' && timer.status !== 'finished')) return [];
    const validEnd = Number.isSafeInteger(timer.endsAt) && timer.endsAt > 0 && timer.endsAt <= 8.64e15;
    if (timer.status === 'running' && !validEnd) return [];
    return [{ boardId: board.id, nodeId: node.id, boardName: board.name || 'Whiteboard',
      label: typeof node.label === 'string' && node.label.trim() ? node.label.trim() : 'Timer',
      // Imported finished states can lack a run deadline. Keep them discoverable,
      // but never invent an alarm for a run whose identity is unknown.
      endsAt: validEnd ? timer.endsAt : 0, sound: timer.sound !== false,
      finished: timer.status === 'finished' }];
  });
}

function createTimerService({ store, directory, onChanged = () => {}, onElapsed = () => {},
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  log = error => console.error('[switchboard] timers:', error) }) {
  const file = path.join(directory, 'timer-alerts.json');
  const boards = new Map();
  let alerted = new Map();
  let chain = Promise.resolve();
  let startPromise = null;
  let unsubscribe = null;
  let scheduled = null;
  let stopped = true;
  let lastShown = '';

  function list() {
    const at = now();
    return Array.from(boards.values()).flat().map(({ finished, ...item }) => ({ ...item,
      status: finished || item.endsAt <= at ? 'finished' : 'running' })).sort((a, b) => a.endsAt - b.endsAt ||
      a.boardId.localeCompare(b.boardId) || a.nodeId.localeCompare(b.nodeId));
  }

  function enqueue(work) {
    const next = chain.then(work);
    chain = next.catch(log);
    return chain;
  }

  async function loadAlerts() {
    try {
      const saved = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      if (Array.isArray(saved)) alerted = new Map(saved.filter(item => Array.isArray(item) &&
        /^[a-f0-9]{64}$/.test(item[0]) && Number.isFinite(item[1])));
    } catch (error) {
      if (error.code !== 'ENOENT') log(error);
    }
  }

  async function saveAlerts() {
    // Retain enough old runs that Undo, a relaunch, or a board imported again does
    // not repeatedly sound the same alarm. No names or paths go into this ledger.
    alerted = new Map(Array.from(alerted).sort((a, b) => b[1] - a[1]).slice(0, 10000));
    await fs.promises.mkdir(directory, { recursive: true });
    const temporary = file + '.tmp';
    await fs.promises.writeFile(temporary, JSON.stringify(Array.from(alerted)) + '\n');
    await fs.promises.rename(temporary, file);
  }

  async function readBoard(id) {
    const result = await store.get(id);
    if (result && result.ok) boards.set(id, timersOf(result.data));
    else boards.delete(id);
  }

  async function readAll() {
    const result = await store.list();
    if (!result || !result.ok) return;
    const rows = Array.isArray(result.data.boards) ? result.data.boards : [];
    const ids = new Set(rows.map(board => board.id));
    for (const id of boards.keys()) if (!ids.has(id)) boards.delete(id);
    await Promise.all(rows.map(board => readBoard(board.id)));
  }

  function schedule(items) {
    if (scheduled !== null) clearTimer(scheduled);
    scheduled = null;
    if (stopped || !items.length) return;
    // A periodic ceiling also catches wall-clock adjustments. Resume calls check()
    // explicitly, so sleeping through a deadline sounds it when the Mac wakes up.
    const future = items.filter(item => item.endsAt > now());
    const delay = future.length ? Math.min(60000, Math.max(1, future[0].endsAt - now())) : 60000;
    scheduled = setTimer(() => { scheduled = null; void check(); }, delay);
    if (scheduled && typeof scheduled.unref === 'function') scheduled.unref();
  }

  async function reconcile() {
    if (stopped) return;
    const items = list();
    const due = items.filter(item => item.status === 'finished' && item.endsAt > 0 && !alerted.has(timerKey(item)));
    if (due.length) {
      for (const item of due) alerted.set(timerKey(item), now());
      // Record before delivery: a renderer reload can never cause a second chime.
      try { await saveAlerts(); } catch (error) { log(error); }
      for (const item of due) {
        if (stopped) break;
        try { onElapsed({ ...item }); } catch (error) { log(error); }
      }
    }
    const shown = JSON.stringify(items);
    if (!stopped && shown !== lastShown) {
      lastShown = shown;
      try { onChanged(items); } catch (error) { log(error); }
    }
    schedule(items);
  }

  function refresh(boardId) {
    return enqueue(async () => {
      if (stopped) return list();
      if (boardId) await readBoard(boardId);
      else await readAll();
      await reconcile();
      return list();
    });
  }

  function check() { return enqueue(reconcile); }

  function start() {
    if (startPromise) return startPromise;
    stopped = false;
    unsubscribe = store.onChange(change => { void refresh(change && change.boardId); });
    startPromise = enqueue(async () => { await loadAlerts(); await readAll(); await reconcile(); });
    return startPromise;
  }

  function stop() {
    stopped = true;
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    if (scheduled !== null) clearTimer(scheduled);
    scheduled = null;
  }

  return { start, stop, refresh, list, check, settle: () => chain };
}

// Kept independent of Electron so its sound toggle and background delivery can be
// exercised without displaying real notifications or making the test machine beep.
function createTimerAlerts({ shell, Notification, getWindow, onElapsed, onNavigate,
  log = error => console.error('[switchboard] timer alert:', error) }) {
  const notifications = new Set();
  return item => {
    try { onElapsed(item); } catch (error) { log(error); }
    if (item.sound) {
      try { shell.beep(); } catch (error) { log(error); }
    }
    const win = getWindow();
    if (win && !win.isDestroyed() && win.isFocused() && win.isVisible()) return;
    try {
      if (!Notification.isSupported()) return;
      const notification = new Notification({ title: 'Time’s up',
        body: `${item.label} · ${item.boardName}`, silent: true });
      notifications.add(notification);
      notification.on('click', () => onNavigate({ boardId: item.boardId, nodeId: item.nodeId }));
      notification.on('close', () => notifications.delete(notification));
      notification.on('failed', () => notifications.delete(notification));
      notification.show();
    } catch (error) { log(error); }
  };
}

module.exports = { createTimerService, createTimerAlerts };
