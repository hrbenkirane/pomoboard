'use strict';

const COLORS = ['yellow', 'orange', 'red', 'pink', 'purple', 'blue', 'cyan', 'green', 'gray', 'white'];
// What each colour means. Editable per board from the legend under the top bar.
const DEFAULT_LABELS = {
  yellow: '1pm', orange: '2pm', red: '3pm', pink: '4pm', purple: '5pm',
  blue: '6pm', cyan: '7pm', green: '8pm', gray: '9pm', white: '10pm',
};
const colorLabel = c => ({ ...DEFAULT_LABELS, ...((state.board && state.board.colorLabels) || {}) })[c] || c;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid);
  return n;
}

const state = {
  boards: [],
  board: null,
  tasks: [],
  filter: '',
  settings: { pomodoro: 25, shortBreak: 5, longBreak: 15, longEvery: 4 },
  stats: { seconds: 0, pomodoros: 0 },
};

// ---------- helpers ----------
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    toast(err.error || `Request failed (${res.status})`);
    throw new Error(err.error || res.statusText);
  }
  return res.status === 204 ? null : res.json();
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

function fmtDur(seconds) {
  const m = Math.max(1, Math.round(seconds / 60));
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
}

function fmtClock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = String(m).padStart(2, '0'), ss = String(sec).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function dayLabel(iso) {
  const d = new Date(iso), now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  const opts = { weekday: 'long', day: 'numeric', month: 'long' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-GB', opts);
}

// Small replacement for prompt()/confirm(). Resolves to text, true, or null when cancelled.
function ask(title, value = '', opts = {}) {
  return new Promise(resolve => {
    const d = $('#ask'), input = $('#ask-input'), ok = $('#ask-ok');
    $('#ask-title').textContent = title;
    input.hidden = !!opts.confirm;
    input.value = value;
    ok.textContent = opts.ok || 'OK';
    ok.classList.toggle('danger', !!opts.danger);
    d.returnValue = '';
    d.onclose = () => resolve(d.returnValue === 'ok' ? (opts.confirm ? true : input.value.trim()) : null);
    d.showModal();
    if (!opts.confirm) input.select();
  });
}
$('#ask-cancel').onclick = () => $('#ask').close('cancel');

function showMenu(anchor, items) {
  const menu = $('#menu');
  menu.replaceChildren(...items.filter(Boolean).map(([label, fn]) =>
    el('button', { onclick: () => { menu.hidden = true; fn(); } }, label)));
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.left = `${Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)}px`;
}
document.addEventListener('click', e => {
  if (!e.target.closest('#menu, .col-menu, #board-menu')) $('#menu').hidden = true;
  if (!e.target.closest('#timer-panel, #timer-pill, .card-play, dialog')) $('#timer-panel').hidden = true;
});

// ---------- boards ----------
async function loadBoards(selectId) {
  state.boards = await api('GET', '/api/boards');
  if (!state.boards.length) state.boards = [await api('POST', '/api/boards', { name: 'My board' })];
  const wanted = selectId || localStorage.getItem('pb.board');
  state.board = state.boards.find(b => b._id === wanted) || state.boards[0];
  localStorage.setItem('pb.board', state.board._id);
  const sel = $('#board-select');
  sel.replaceChildren(...state.boards.map(b => el('option', { value: b._id }, b.name)));
  sel.value = state.board._id;
  await loadTasks();
}

async function loadTasks() {
  state.tasks = await api('GET', `/api/boards/${state.board._id}/tasks`);
  renderBoard();
}

async function saveColumns(columns) {
  state.board = await api('PATCH', `/api/boards/${state.board._id}`, { columns });
  const i = state.boards.findIndex(b => b._id === state.board._id);
  state.boards[i] = state.board;
  await loadTasks();
}

$('#board-select').onchange = e => loadBoards(e.target.value);
$('#search').oninput = e => { state.filter = e.target.value.trim().toLowerCase(); renderBoard(); };

$('#board-menu').onclick = e => showMenu(e.currentTarget, [
  ['New board…', async () => {
    const name = await ask('New board name');
    if (name) loadBoards((await api('POST', '/api/boards', { name }))._id);
  }],
  ['Rename board…', async () => {
    const name = await ask('Rename board', state.board.name);
    if (name) { await api('PATCH', `/api/boards/${state.board._id}`, { name }); loadBoards(state.board._id); }
  }],
  ['Add column…', addColumn],
  state.boards.length > 1 && ['Delete board…', async () => {
    if (await ask(`Delete board "${state.board.name}" and all its tasks?`, '', { confirm: true, ok: 'Delete', danger: true })) {
      await api('DELETE', `/api/boards/${state.board._id}`);
      localStorage.removeItem('pb.board');
      loadBoards();
    }
  }],
]);

async function addColumn() {
  const name = await ask('New column name');
  if (name) saveColumns([...state.board.columns, { name, isDone: false }]);
}

function columnMenu(anchor, col) {
  const cols = state.board.columns, i = cols.indexOf(col);
  const swap = j => { const next = [...cols]; [next[i], next[j]] = [next[j], next[i]]; saveColumns(next); };
  showMenu(anchor, [
    ['Rename…', async () => {
      const name = await ask('Rename column', col.name);
      if (name) saveColumns(cols.map(c => (c === col ? { ...c, name } : c)));
    }],
    i > 0 && ['Move left', () => swap(i - 1)],
    i < cols.length - 1 && ['Move right', () => swap(i + 1)],
    [col.isDone ? 'Stop treating as Done column' : 'Use as Done column',
      () => saveColumns(cols.map(c => (c === col ? { ...c, isDone: !c.isDone } : c)))],
    cols.length > 1 && ['Delete column…', async () => {
      const n = state.tasks.filter(t => t.columnId === col.id).length;
      const msg = `Delete column "${col.name}"` + (n ? ` and its ${n} task${n > 1 ? 's' : ''}?` : '?');
      if (await ask(msg, '', { confirm: true, ok: 'Delete', danger: true })) saveColumns(cols.filter(c => c !== col));
    }],
  ]);
}

async function renameColor(c) {
  const name = await ask(`What does ${c} mean?`, colorLabel(c));
  if (name === null) return;
  const colorLabels = Object.fromEntries(COLORS.map(k => [k, k === c ? name : colorLabel(k)]));
  state.board = await api('PATCH', `/api/boards/${state.board._id}`, { colorLabels });
  state.boards[state.boards.findIndex(b => b._id === state.board._id)] = state.board;
  renderBoard();
  if (dlg.open) renderSwatches();
}

function renderLegend() {
  $('#legend').replaceChildren(
    el('span', { class: 'legend-title' }, 'Colours:'),
    ...COLORS.map(c => el('button', {
      class: `chip c-${c}`, title: `${c} — click to rename`, onclick: () => renameColor(c),
    }, colorLabel(c))));
}

// ---------- board rendering ----------
function columnTasks(col) {
  const list = state.tasks.filter(t => t.columnId === col.id);
  if (col.isDone) list.sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0));
  else list.sort((a, b) => a.position - b.position);
  return list;
}

function matches(t) {
  return !state.filter || t.name.toLowerCase().includes(state.filter) ||
    (t.description || '').toLowerCase().includes(state.filter);
}

function cardEl(t) {
  const subs = t.subtasks || [];
  const meta = [
    t.timeSpent > 0 && el('span', { title: 'Time spent' }, `⏱ ${fmtDur(t.timeSpent)}`),
    t.pomodoros > 0 && el('span', { title: 'Pomodoros' }, `🍅 ${t.pomodoros}`),
    subs.length > 0 && el('span', { title: 'Subtasks' }, `☑ ${subs.filter(s => s.done).length}/${subs.length}`),
    t.description && el('span', { title: 'Has a description' }, '≡'),
  ].filter(Boolean);
  const card = el('article', {
    class: `card c-${t.color}${T.taskId === t._id ? ' active' : ''}${state.selected === t._id ? ' selected' : ''}`,
    draggable: 'true', 'data-id': t._id,
    title: colorLabel(t.color),
    onclick: () => selectCard(t._id),
    ondblclick: () => openTask(t),
    ondragstart: e => {
      dragId = t._id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', t._id);
      setTimeout(() => card.classList.add('dragging'));
    },
    ondragend: endDrag,
  },
    el('div', { class: 'card-name' }, t.name),
    meta.length > 0 && el('div', { class: 'card-meta' }, meta),
    el('button', {
      class: 'card-edit', title: 'Edit task',
      onclick: e => { e.stopPropagation(); openTask(t); },
    }, '✎'),
    el('button', {
      class: 'card-del', title: 'Delete task',
      onclick: e => { e.stopPropagation(); deleteTask(t); },
    }, '🗑'),
    el('button', {
      class: 'card-play', title: 'Start the timer on this task',
      onclick: e => { e.stopPropagation(); startOn(t); },
    }, '▶'));
  return card;
}

// Clicking a card selects it; the selected card shows a pencil icon that opens the editor.
function selectCard(id) {
  state.selected = id;
  $$('.card.selected').forEach(c => c.classList.remove('selected'));
  if (id) $$('.card').filter(c => c.dataset.id === id).forEach(c => c.classList.add('selected'));
}
document.addEventListener('click', e => {
  if (state.selected && !e.target.closest('.card, dialog')) selectCard(null);
});
document.addEventListener('keydown', e => {
  if (!state.selected || e.target.closest('input, textarea, select, dialog')) return;
  const task = state.tasks.find(t => t._id === state.selected);
  if (e.key === 'Enter' && task) { e.preventDefault(); openTask(task); }
  if (e.key === 'Escape') selectCard(null);
});

function renderBoard() {
  renderLegend();
  const root = $('#board');
  const scroll = { x: root.scrollLeft, cols: Object.fromEntries($$('.cards', root).map(c => [c.dataset.col, c.scrollTop])) };
  root.replaceChildren(...state.board.columns.map(col => {
    const all = columnTasks(col), shown = all.filter(matches);
    const list = el('div', { class: 'cards', 'data-col': col.id });
    let lastDay = null;
    for (const t of shown) {
      if (col.isDone && t.completedAt) {
        const day = dayLabel(t.completedAt);
        if (day !== lastDay) list.append(el('div', { class: 'group' }, (lastDay = day)));
      }
      list.append(cardEl(t));
    }
    list.addEventListener('dragover', e => onDragOver(e, list));
    list.addEventListener('dragleave', e => { if (!list.contains(e.relatedTarget)) list.classList.remove('over'); });
    list.addEventListener('drop', e => onDrop(e, list, col));
    return el('section', { class: 'column' },
      el('header', {},
        el('h2', { title: col.name }, col.name),
        el('span', { class: 'count' }, state.filter ? `${shown.length}/${all.length}` : String(all.length)),
        el('div', { class: 'spacer' }),
        el('button', { class: 'icon-btn col-add', title: 'Add task', onclick: () => openTask(null, col.id) }, '+'),
        el('button', { class: 'icon-btn col-menu', title: 'Column options', onclick: e => columnMenu(e.currentTarget, col) }, '⋯')),
      list);
  }), el('button', { class: 'add-column', onclick: addColumn }, '+ Add column'));
  root.scrollLeft = scroll.x;
  $$('.cards', root).forEach(c => (c.scrollTop = scroll.cols[c.dataset.col] || 0));
}

// ---------- drag & drop ----------
let dragId = null;
const placeholder = el('div', { class: 'placeholder' });

function endDrag() {
  dragId = null;
  placeholder.remove();
  $$('.dragging').forEach(c => c.classList.remove('dragging'));
  $$('.cards.over').forEach(c => c.classList.remove('over'));
}

function onDragOver(e, list) {
  if (!dragId) return;
  e.preventDefault();
  list.classList.add('over');
  const col = state.board.columns.find(c => c.id === list.dataset.col);
  if (col.isDone) { list.prepend(placeholder); return; } // Done is ordered by completion date
  const after = $$('.card:not(.dragging)', list).find(c => {
    const r = c.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2;
  });
  if (after) list.insertBefore(placeholder, after); else list.append(placeholder);
}

async function onDrop(e, list, col) {
  if (!dragId) return;
  e.preventDefault();
  const id = dragId;
  // translate the visual drop position into an index among the column's real (unfiltered) tasks
  const siblings = columnTasks(col).filter(t => t._id !== id);
  let next = placeholder.nextElementSibling;
  while (next && !(next.matches('.card') && next.dataset.id !== id)) next = next.nextElementSibling;
  let index = next ? siblings.findIndex(t => t._id === next.dataset.id) : siblings.length;
  if (index < 0) index = siblings.length;
  endDrag();
  await api('POST', `/api/tasks/${id}/move`, { columnId: col.id, index });
  await loadTasks();
}

// ---------- task dialog ----------
const dlg = $('#task-dlg');
let editing = null; // { id, color, subtasks, minutes }

function renderSwatches() {
  $('#task-colors').replaceChildren(...COLORS.map(c => el('button', {
    class: `swatch-opt${editing.color === c ? ' on' : ''}`, title: c, type: 'button',
    onclick: () => { editing.color = c; renderSwatches(); },
  }, el('span', { class: `swatch c-${c}` }), el('span', { class: 'swatch-label' }, colorLabel(c)))));
}

function renderSubs() {
  $('#task-subs').replaceChildren(...editing.subtasks.map(s => el('div', { class: `sub${s.done ? ' done' : ''}` },
    el('input', { type: 'checkbox', checked: s.done, onchange: e => { s.done = e.target.checked; renderSubs(); } }),
    el('input', { type: 'text', value: s.text, maxlength: 300, oninput: e => (s.text = e.target.value) }),
    el('button', {
      class: 'icon-btn', title: 'Remove subtask', type: 'button',
      onclick: () => { editing.subtasks = editing.subtasks.filter(x => x !== s); renderSubs(); },
    }, '✕'))));
}

function openTask(task, columnId) {
  const minutes = task ? Math.round(task.timeSpent / 60) : 0;
  editing = {
    id: task ? task._id : null,
    color: task ? task.color : localStorage.getItem('pb.color') || 'yellow',
    subtasks: task ? (task.subtasks || []).map(s => ({ ...s })) : [],
    minutes,
  };
  $('#task-name').value = task ? task.name : '';
  $('#task-desc').value = task ? task.description || '' : '';
  $('#task-sub-new').value = '';
  $('#task-min').value = minutes;
  $('#task-pomos').textContent = task && task.pomodoros ? `🍅 ${task.pomodoros} pomodoro${task.pomodoros > 1 ? 's' : ''}` : '';
  const sel = $('#task-column');
  sel.replaceChildren(...state.board.columns.map(c => el('option', { value: c.id }, c.name)));
  sel.value = task ? task.columnId : columnId;
  $('#task-time-row').hidden = !task;
  $('#task-delete').hidden = !task;
  $('#task-timer').hidden = !task;
  $('#task-save-more').hidden = !!task;
  renderSwatches();
  renderSubs();
  if (!dlg.open) dlg.showModal();
  $('#task-name').focus();
}

function commitNewSub() {
  const input = $('#task-sub-new'), text = input.value.trim();
  if (text) { editing.subtasks.push({ id: crypto.randomUUID(), text, done: false }); input.value = ''; renderSubs(); }
}

async function saveTask(addMore) {
  const name = $('#task-name').value.trim();
  if (!name) { $('#task-name').focus(); toast('Give the task a name first'); return null; }
  commitNewSub();
  const columnId = $('#task-column').value;
  const body = {
    name, color: editing.color, description: $('#task-desc').value,
    subtasks: editing.subtasks.filter(s => s.text.trim()),
  };
  let task;
  if (editing.id) {
    const minutes = Math.max(0, Math.round(Number($('#task-min').value) || 0));
    if (minutes !== editing.minutes) body.timeSpent = minutes * 60;
    task = await api('PATCH', `/api/tasks/${editing.id}`, body);
    if (task.columnId !== columnId) {
      const count = state.tasks.filter(t => t.columnId === columnId).length;
      task = await api('POST', `/api/tasks/${task._id}/move`, { columnId, index: count });
    }
    if (T.taskId === task._id) { T.taskName = task.name; saveTimer(); }
  } else {
    task = await api('POST', '/api/tasks', { ...body, boardId: state.board._id, columnId });
    localStorage.setItem('pb.color', editing.color);
  }
  await loadTasks();
  if (addMore) openTask(null, columnId); else dlg.close();
  return task;
}

$('#task-save').onclick = () => saveTask(false);
$('#task-save-more').onclick = () => saveTask(true);
$('#task-close').onclick = () => dlg.close();
// Asks first; returns true when the task was deleted.
async function deleteTask(task) {
  if (!(await ask(`Delete "${task.name}"?`, '', { confirm: true, ok: 'Delete', danger: true }))) return false;
  if (T.taskId === task._id) { T.taskId = null; T.taskName = ''; saveTimer(); }
  if (state.selected === task._id) state.selected = null;
  await api('DELETE', `/api/tasks/${task._id}`);
  await loadTasks();
  return true;
}

$('#task-delete').onclick = async () => {
  const task = state.tasks.find(t => t._id === editing.id);
  if (task && await deleteTask(task)) dlg.close();
};
$('#task-timer').onclick = async () => {
  const task = await saveTask(false);
  if (task) startOn(task);
};
$('#task-sub-new').onkeydown = e => {
  if (e.key === 'Enter' && !e.ctrlKey) { e.preventDefault(); commitNewSub(); }
};
dlg.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (e.ctrlKey || e.metaKey) { e.preventDefault(); saveTask(e.shiftKey && !editing.id); }
  else if (e.target.id === 'task-name') { e.preventDefault(); saveTask(false); }
});

// ---------- timer ----------
const T = Object.assign(
  { mode: 'pomodoro', phase: 'work', taskId: null, taskName: '', running: false, startedAt: 0, acc: 0, cycle: 0 },
  JSON.parse(localStorage.getItem('pb.timer') || '{}'));

const saveTimer = () => localStorage.setItem('pb.timer', JSON.stringify(T));
const elapsed = () => T.acc + (T.running ? Date.now() - T.startedAt : 0);
const phaseMs = () => {
  const s = state.settings;
  return (T.phase === 'work' ? s.pomodoro : T.phase === 'long' ? s.longBreak : s.shortBreak) * 60000;
};

// One shared audio context, unlocked by the first click so the alarm can play later without a gesture.
let audioCtx = null;
function audio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* audio is optional */ }
  return audioCtx;
}
document.addEventListener('click', audio, true);

// Alarm: a four-note chime played three times (about 4 seconds).
function beep() {
  const ctx = audio();
  if (!ctx) return;
  const notes = [784, 988, 1175, 1568];
  for (let rep = 0; rep < 3; rep++) {
    notes.forEach((freq, i) => {
      const at = ctx.currentTime + 0.05 + rep * 1.3 + i * 0.22;
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.5, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.45);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.5);
    });
  }
}

function notify(msg) {
  beep();
  toast(msg);
  if ('Notification' in window && Notification.permission === 'granted') new Notification('PomoBoard', { body: msg });
}

async function logTime(seconds, pomodoro) {
  if (seconds < 5) return;
  const { task } = await api('POST', '/api/timelogs', { taskId: T.taskId, seconds, pomodoro, type: T.mode });
  if (task) {
    const i = state.tasks.findIndex(t => t._id === task._id);
    if (i >= 0) { state.tasks[i] = task; renderBoard(); }
  }
  loadStats();
}

function startTimer() {
  if (T.running) return;
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  T.running = true;
  T.startedAt = Date.now();
  saveTimer();
  renderTimer();
}

function pauseTimer() {
  T.acc = elapsed();
  T.running = false;
  saveTimer();
  renderTimer();
}

// Stops the current session; focus time done so far is logged to the task.
async function stopTimer() {
  const ms = elapsed(), wasWork = T.mode === 'stopwatch' || T.phase === 'work';
  T.running = false; T.acc = 0; T.phase = 'work';
  saveTimer();
  renderTimer();
  if (wasWork) await logTime(Math.round(ms / 1000), false);
}

function completePhase() {
  if (T.phase === 'work') {
    const seconds = Math.round(phaseMs() / 1000);
    T.cycle += 1;
    T.phase = T.cycle % state.settings.longEvery === 0 ? 'long' : 'short';
    T.acc = 0; T.startedAt = Date.now(); T.running = true; // break starts on its own
    saveTimer();
    logTime(seconds, true);
    notify(`Pomodoro done — time for a ${T.phase === 'long' ? 'long' : 'short'} break`);
  } else {
    T.phase = 'work'; T.acc = 0; T.running = false;
    saveTimer();
    notify('Break is over — ready for the next pomodoro?');
  }
}

async function startOn(task) {
  if (T.taskId !== task._id || T.phase !== 'work') {
    if (elapsed() > 0) await stopTimer(); // log what was running on the previous task
    T.taskId = task._id;
    T.taskName = task.name;
  }
  startTimer();
  renderBoard();
  $('#timer-panel').hidden = false;
}

async function setMode(mode) {
  if (T.mode === mode) return;
  if (elapsed() > 0) await stopTimer();
  T.mode = mode; T.phase = 'work';
  saveTimer();
  renderTimer();
}

function renderTimer() {
  const isBreak = T.mode === 'pomodoro' && T.phase !== 'work';
  const ms = T.mode === 'pomodoro' ? phaseMs() - elapsed() : elapsed();
  const clock = fmtClock(ms), active = T.running || elapsed() > 0;
  $('#pill-time').textContent = clock;
  $('#pill-icon').textContent = T.running ? (isBreak ? '☕' : '🍅') : '▶';
  $('#pill-task').textContent = T.taskName;
  const pill = $('#timer-pill');
  pill.classList.toggle('running', T.running && !isBreak);
  pill.classList.toggle('break', T.running && isBreak);
  $('#tp-time').textContent = clock;
  $('#tp-phase').textContent = T.mode === 'stopwatch' ? 'Stopwatch'
    : T.phase === 'work' ? `Focus · pomodoro #${T.cycle + 1}` : T.phase === 'long' ? 'Long break' : 'Short break';
  $('#tp-task').textContent = T.taskName || 'No task selected — press ▶ on a card';
  $('#tp-start').textContent = T.running ? 'Pause' : elapsed() > 0 ? 'Resume' : 'Start';
  $('#tp-stop').textContent = isBreak ? 'Skip break' : 'Stop & log';
  $('#tp-stop').disabled = !active;
  $$('#timer-panel .tabs button').forEach(b => b.classList.toggle('on', b.dataset.mode === T.mode));
  const st = state.stats;
  $('#tp-stats').textContent = `🍅 Today ${st.pomodoros} · Week ${st.week ? st.week.pomodoros : 0} · Month ${st.month ? st.month.pomodoros : 0}` +
    ` — ${st.seconds ? fmtDur(st.seconds) : '0m'} focused today`;
  document.title = active ? `${clock} · ${T.taskName || (isBreak ? 'Break' : 'Focus')}` : 'PomoBoard';
}

function tick() {
  if (T.mode === 'pomodoro' && T.running && elapsed() >= phaseMs()) completePhase();
  renderTimer();
}

// Start of today, of this week (Monday) and of this month, in local time.
function periodQuery() {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  const week = new Date(day);
  week.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  const month = new Date(day.getFullYear(), day.getMonth(), 1);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return `today=${day.getTime()}&week=${week.getTime()}&month=${month.getTime()}&tz=${encodeURIComponent(tz)}`;
}

async function loadStats() {
  state.stats = await api('GET', `/api/stats?${periodQuery()}`);
  renderTimer();
}

$('#report').onclick = e => { e.currentTarget.href = `/api/report.xlsx?${periodQuery()}`; };
$('#tp-test').onclick = beep;

// ---------- report viewer (same sheets as the Excel file) ----------
let report = null, reportTab = 0;

function renderReport() {
  $('#report-tabs').replaceChildren(...report.sheets.map((s, i) => el('button', {
    class: i === reportTab ? 'on' : '', onclick: () => { reportTab = i; renderReport(); },
  }, s.name)));
  const s = report.sheets[reportTab];
  $('#report-table').replaceChildren(s.rows.length
    ? el('table', {},
      el('thead', {}, el('tr', {}, s.columns.map(([header]) => el('th', {}, header)))),
      el('tbody', {}, s.rows.map(row => el('tr', {},
        row.map(v => el('td', { class: typeof v === 'number' ? 'num' : '' }, String(v)))))))
    : el('p', { class: 'empty' }, 'No tracked sessions in this period yet.'));
  $('#report-table').scrollTop = 0;
}

$('#report-open').onclick = async () => {
  report = await api('GET', `/api/report?${periodQuery()}`);
  reportTab = 0;
  renderReport();
  $('#report-dlg').showModal();
};
$('#report-close').onclick = () => $('#report-dlg').close();

$('#timer-pill').onclick = () => { const p = $('#timer-panel'); p.hidden = !p.hidden; };
$('#tp-start').onclick = () => (T.running ? pauseTimer() : startTimer());
$('#tp-stop').onclick = stopTimer;
$$('#timer-panel .tabs button').forEach(b => (b.onclick = () => setMode(b.dataset.mode)));
$$('[data-setting]').forEach(input => (input.onchange = async () => {
  const next = { ...state.settings, [input.dataset.setting]: Number(input.value) };
  state.settings = await api('PUT', '/api/settings', next);
  fillSettings();
  renderTimer();
}));
function fillSettings() {
  $$('[data-setting]').forEach(i => (i.value = state.settings[i.dataset.setting]));
}

// ---------- boot ----------
(async () => {
  state.settings = await api('GET', '/api/settings');
  fillSettings();
  await loadBoards();
  await loadStats();
  // Tick from a worker: browsers slow page timers in background tabs, which would delay the alarm.
  try {
    const src = URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 500)'], { type: 'text/javascript' }));
    new Worker(src).onmessage = tick;
  } catch {
    setInterval(tick, 500);
  }
  tick();
})();
