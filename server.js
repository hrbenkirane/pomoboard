'use strict';
const express = require('express');
const { MongoClient } = require('mongodb');
const ExcelJS = require('exceljs');
const path = require('path');
const { randomUUID } = require('crypto');

const PORT = process.env.PORT || 8790;
const MONGO_URL = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.MONGO_DB || 'pomoboard';
const COLORS = ['yellow', 'orange', 'red', 'pink', 'purple', 'blue', 'cyan', 'green', 'gray', 'white'];
const DEFAULT_SETTINGS = { pomodoro: 25, shortBreak: 5, longBreak: 15, longEvery: 4 };

let boards, tasks, timelogs, settings;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const wrap = fn => (req, res, next) => fn(req, res).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status });
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);

function cleanSubtasks(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 200)
    .map(s => ({ id: str(s.id, 64) || randomUUID(), text: str(s.text, 300), done: !!s.done }))
    .filter(s => s.text);
}

function cleanColumns(list) {
  if (!Array.isArray(list) || !list.length) throw fail(400, 'A board needs at least one column');
  return list.slice(0, 50).map(c => ({
    id: str(c.id, 64) || randomUUID(),
    name: str(c.name, 80) || 'Untitled',
    isDone: !!c.isDone,
  }));
}

// ---------- boards ----------
app.get('/api/boards', wrap(async (req, res) => {
  res.json(await boards.find().sort({ createdAt: 1 }).toArray());
}));

app.post('/api/boards', wrap(async (req, res) => {
  const board = {
    _id: randomUUID(),
    name: str(req.body.name, 80) || 'New board',
    columns: [
      { id: randomUUID(), name: 'To do', isDone: false },
      { id: randomUUID(), name: 'In progress', isDone: false },
      { id: randomUUID(), name: 'Done', isDone: true },
    ],
    createdAt: new Date(),
  };
  await boards.insertOne(board);
  res.status(201).json(board);
}));

app.patch('/api/boards/:id', wrap(async (req, res) => {
  const set = {};
  if (req.body.name !== undefined) set.name = str(req.body.name, 80) || 'Untitled';
  if (req.body.colorLabels !== undefined) {
    set.colorLabels = {};
    for (const c of COLORS) set.colorLabels[c] = str((req.body.colorLabels || {})[c], 30);
  }
  if (req.body.columns !== undefined) {
    set.columns = cleanColumns(req.body.columns);
    // tasks living in a removed column go away with it
    await tasks.deleteMany({ boardId: req.params.id, columnId: { $nin: set.columns.map(c => c.id) } });
  }
  const board = await boards.findOneAndUpdate({ _id: req.params.id }, { $set: set }, { returnDocument: 'after' });
  if (!board) throw fail(404, 'Board not found');
  res.json(board);
}));

app.delete('/api/boards/:id', wrap(async (req, res) => {
  await tasks.deleteMany({ boardId: req.params.id });
  await boards.deleteOne({ _id: req.params.id });
  res.status(204).end();
}));

app.get('/api/boards/:id/tasks', wrap(async (req, res) => {
  res.json(await tasks.find({ boardId: req.params.id }).sort({ position: 1 }).toArray());
}));

// ---------- tasks ----------
app.post('/api/tasks', wrap(async (req, res) => {
  const board = await boards.findOne({ _id: str(req.body.boardId, 64) });
  if (!board) throw fail(404, 'Board not found');
  const col = board.columns.find(c => c.id === req.body.columnId);
  if (!col) throw fail(400, 'Column not found');
  const name = str(req.body.name, 300);
  if (!name) throw fail(400, 'Task name is required');
  const last = await tasks.find({ boardId: board._id, columnId: col.id }).sort({ position: -1 }).limit(1).next();
  const task = {
    _id: randomUUID(),
    boardId: board._id,
    columnId: col.id,
    position: last ? last.position + 1 : 0,
    name,
    description: str(req.body.description, 20000),
    color: COLORS.includes(req.body.color) ? req.body.color : 'yellow',
    subtasks: cleanSubtasks(req.body.subtasks),
    timeSpent: 0,
    pomodoros: 0,
    createdAt: new Date(),
    completedAt: col.isDone ? new Date() : null,
  };
  await tasks.insertOne(task);
  res.status(201).json(task);
}));

app.patch('/api/tasks/:id', wrap(async (req, res) => {
  const b = req.body, set = {};
  if (b.name !== undefined) {
    set.name = str(b.name, 300);
    if (!set.name) throw fail(400, 'Task name is required');
  }
  if (b.description !== undefined) set.description = str(b.description, 20000);
  if (b.color !== undefined && COLORS.includes(b.color)) set.color = b.color;
  if (b.subtasks !== undefined) set.subtasks = cleanSubtasks(b.subtasks);
  if (b.timeSpent !== undefined) set.timeSpent = Math.max(0, Math.round(Number(b.timeSpent) || 0));
  const task = await tasks.findOneAndUpdate({ _id: req.params.id }, { $set: set }, { returnDocument: 'after' });
  if (!task) throw fail(404, 'Task not found');
  res.json(task);
}));

app.delete('/api/tasks/:id', wrap(async (req, res) => {
  await tasks.deleteOne({ _id: req.params.id });
  res.status(204).end();
}));

app.post('/api/tasks/:id/move', wrap(async (req, res) => {
  const task = await tasks.findOne({ _id: req.params.id });
  if (!task) throw fail(404, 'Task not found');
  const board = await boards.findOne({ _id: task.boardId });
  const col = board && board.columns.find(c => c.id === req.body.columnId);
  if (!col) throw fail(400, 'Column not found');

  const siblings = await tasks.find({ boardId: task.boardId, columnId: col.id, _id: { $ne: task._id } })
    .sort({ position: 1 }).toArray();
  const index = Math.min(Math.max(0, Number(req.body.index) || 0), siblings.length);
  siblings.splice(index, 0, task);

  const changedColumn = task.columnId !== col.id;
  const ops = siblings.map((s, i) => {
    const set = { position: i };
    if (s._id === task._id) {
      set.columnId = col.id;
      if (!col.isDone) set.completedAt = null;
      else if (changedColumn || !task.completedAt) set.completedAt = new Date();
    }
    return { updateOne: { filter: { _id: s._id }, update: { $set: set } } };
  });
  await tasks.bulkWrite(ops);
  res.json(await tasks.findOne({ _id: task._id }));
}));

// ---------- time tracking ----------
app.post('/api/timelogs', wrap(async (req, res) => {
  const seconds = Math.round(Number(req.body.seconds) || 0);
  if (seconds <= 0 || seconds > 24 * 3600) throw fail(400, 'Invalid duration');
  const pomodoro = !!req.body.pomodoro;
  const taskId = req.body.taskId ? str(req.body.taskId, 64) : null;
  const endedAt = new Date();
  await timelogs.insertOne({
    _id: randomUUID(), taskId, seconds, pomodoro,
    type: req.body.type === 'stopwatch' ? 'stopwatch' : 'pomodoro',
    startedAt: new Date(endedAt.getTime() - seconds * 1000), endedAt,
  });
  let task = null;
  if (taskId) {
    task = await tasks.findOneAndUpdate(
      { _id: taskId },
      { $inc: { timeSpent: seconds, pomodoros: pomodoro ? 1 : 0 } },
      { returnDocument: 'after' });
  }
  res.status(201).json({ task });
}));

// Period starts come from the browser so "today" follows the user's clock, not the container's (UTC).
function periods(query) {
  const now = new Date();
  const utcDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const ts = (v, def) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? new Date(n) : def; };
  let tz = str(query.tz, 64) || 'UTC';
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); } catch { tz = 'UTC'; }
  return {
    tz,
    today: ts(query.today, utcDay),
    week: ts(query.week, new Date(utcDay.getTime() - ((utcDay.getUTCDay() + 6) % 7) * 86400000)),
    month: ts(query.month, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))),
  };
}

const totals = (logs, since) => logs.filter(l => l.endedAt >= since).reduce(
  (acc, l) => ({ seconds: acc.seconds + l.seconds, pomodoros: acc.pomodoros + (l.pomodoro ? 1 : 0) }),
  { seconds: 0, pomodoros: 0 });

app.get('/api/stats', wrap(async (req, res) => {
  const p = periods(req.query);
  const earliest = new Date(Math.min(p.today, p.week, p.month));
  const logs = await timelogs.find({ endedAt: { $gte: earliest } }).toArray();
  res.json({ ...totals(logs, p.today), week: totals(logs, p.week), month: totals(logs, p.month) });
}));

// Builds the report once; the in-app viewer (JSON) and the Excel download share it.
async function buildReport(query) {
  const p = periods(query);
  const earliest = new Date(Math.min(p.today, p.week, p.month));
  const logs = await timelogs.find({ endedAt: { $gte: earliest } }).sort({ endedAt: 1 }).toArray();
  const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: p.tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const weekdayFmt = new Intl.DateTimeFormat('en-GB', { timeZone: p.tz, weekday: 'long' });
  const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: p.tz, hour: '2-digit', minute: '2-digit' });
  const monthFmt = new Intl.DateTimeFormat('en-GB', { timeZone: p.tz, month: 'long', year: 'numeric' });
  const mins = s => Math.round(s / 60);
  const hm = s => `${Math.floor(mins(s) / 60)}h ${String(mins(s) % 60).padStart(2, '0')}m`;

  const ids = [...new Set(logs.map(l => l.taskId).filter(Boolean))];
  const names = new Map((await tasks.find({ _id: { $in: ids } }).toArray()).map(t => [t._id, t.name]));
  const taskName = id => (id ? names.get(id) || '(deleted task)' : '(no task)');

  const sheets = [];
  const sheet = (name, columns) => {
    const s = { name, columns, rows: [], addRow(row) { this.rows.push(row); } };
    sheets.push(s);
    return s;
  };

  const summary = sheet('Summary', [['Period', 16], ['From', 20], ['Pomodoros', 12], ['Focus minutes', 15], ['Focus time', 12]]);
  for (const [label, since, from] of [
    ['Today', p.today, dayFmt.format(p.today)],
    ['This week', p.week, `since ${dayFmt.format(p.week)}`],
    ['This month', p.month, monthFmt.format(p.month)],
  ]) {
    const t = totals(logs, since);
    summary.addRow([label, from, t.pomodoros, mins(t.seconds), hm(t.seconds)]);
  }

  const byDay = new Map();
  for (const l of logs) {
    const d = byDay.get(dayFmt.format(l.endedAt)) || { seconds: 0, pomodoros: 0 };
    d.seconds += l.seconds; d.pomodoros += l.pomodoro ? 1 : 0;
    byDay.set(dayFmt.format(l.endedAt), d);
  }
  const daily = sheet('Daily', [['Date', 13], ['Weekday', 13], ['Pomodoros', 12], ['Focus minutes', 15], ['Focus time', 12]]);
  for (let t = earliest.getTime() + 12 * 3600000; t < p.today.getTime() + 24 * 3600000; t += 86400000) {
    const key = dayFmt.format(new Date(t)), d = byDay.get(key) || { seconds: 0, pomodoros: 0 };
    daily.addRow([key, weekdayFmt.format(new Date(t)), d.pomodoros, mins(d.seconds), hm(d.seconds)]);
  }

  const byTask = sheet('By task', [['Task', 40], ['Pomodoros today', 17], ['Minutes today', 15],
    ['Pomodoros this week', 20], ['Minutes this week', 18], ['Pomodoros this month', 21], ['Minutes this month', 19]]);
  for (const id of [...new Set(logs.map(l => l.taskId || null))]) {
    const own = logs.filter(l => (l.taskId || null) === id);
    const [d, w, m] = [p.today, p.week, p.month].map(since => totals(own, since));
    byTask.addRow([taskName(id), d.pomodoros, mins(d.seconds), w.pomodoros, mins(w.seconds), m.pomodoros, mins(m.seconds)]);
  }

  const log = sheet('Log', [['Date', 13], ['Ended at', 10], ['Task', 40], ['Type', 12], ['Minutes', 10], ['Full pomodoro', 14]]);
  for (const l of logs) {
    log.addRow([dayFmt.format(l.endedAt), timeFmt.format(l.endedAt), taskName(l.taskId), l.type, mins(l.seconds), l.pomodoro ? 'yes' : 'no']);
  }

  return { sheets, filename: `pomodoros-${dayFmt.format(p.today)}.xlsx` };
}

app.get('/api/report', wrap(async (req, res) => {
  res.json(await buildReport(req.query));
}));

app.get('/api/report.xlsx', wrap(async (req, res) => {
  const { sheets, filename } = await buildReport(req.query);
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    ws.columns = s.columns.map(([header, width]) => ({ header, width }));
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.addRows(s.rows);
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  await wb.xlsx.write(res);
  res.end();
}));

// ---------- settings ----------
app.get('/api/settings', wrap(async (req, res) => {
  const doc = await settings.findOne({ _id: 'timer' });
  res.json({ ...DEFAULT_SETTINGS, ...(doc || {}), _id: undefined });
}));

app.put('/api/settings', wrap(async (req, res) => {
  const num = (v, def, min, max) => Math.min(max, Math.max(min, Math.round(Number(v)) || def));
  const s = {
    pomodoro: num(req.body.pomodoro, 25, 1, 180),
    shortBreak: num(req.body.shortBreak, 5, 1, 60),
    longBreak: num(req.body.longBreak, 15, 1, 120),
    longEvery: num(req.body.longEvery, 4, 1, 12),
  };
  await settings.updateOne({ _id: 'timer' }, { $set: s }, { upsert: true });
  res.json(s);
}));

app.use((err, req, res, next) => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Server error' });
});

// ---------- startup ----------
async function seed() {
  if (await boards.countDocuments()) return;
  const names = ['Today', 'Done', 'TO DO', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const columns = names.map(name => ({ id: randomUUID(), name, isDone: name === 'Done' }));
  const board = { _id: randomUUID(), name: 'Weekly Plan', columns, createdAt: new Date() };
  const col = name => columns.find(c => c.name === name).id;
  const docs = [];
  const add = (column, list, completedAt = null) => list.forEach(([name, color, timeSpent = 0]) => docs.push({
    _id: randomUUID(), boardId: board._id, columnId: col(column), position: docs.length,
    name, description: '', color, subtasks: [], timeSpent, pomodoros: 0,
    createdAt: completedAt || new Date(), completedAt,
  }));

  add('Today', [['algoexpert', 'purple'], ['ai course', 'orange']]);
  add('Done', [['dhl siham', 'yellow'], ['bit work', 'blue'], ['fundaixplorer', 'blue'], ['laudary', 'orange']],
    new Date('2026-11-10T12:00:00'));
  add('Done', [['reading bit einführung dokument generated', 'blue'], ['understanding the PRs and bereitsstellen', 'purple']],
    new Date('2026-10-26T12:00:00'));
  add('Done', [['wakala schreiben und vorbereiten', 'yellow'], ['jehad meeting vorbereiten', 'purple'], ['claude code s1', 'orange', 5580]],
    new Date('2026-10-25T12:00:00'));
  add('Done', [['papier aufrauemen', 'yellow'], ['shasha unten bringen', 'yellow'], ['aufrauemen schlafzimmer', 'orange']],
    new Date('2026-09-07T12:00:00'));
  add('TO DO', [
    ['spring security', 'purple', 4380], ['watching algo intro videos', 'orange'], ['trading volpro', 'blue'],
    ['trading order flow course', 'blue'], ['openshift for absolute beginners', 'purple', 60], ['Angular', 'yellow'],
    ['road to next', 'orange'], ['volume profile learning', 'orange'], ['Angular', 'orange'], ['algoexpert', 'yellow'],
    ['spring security anschauen', 'blue'], ['typescript erfrischung', 'orange', 60], ['Quarkus', 'yellow'],
    ['Angular', 'yellow'], ['devops', 'purple'], ['Brad Ai', 'yellow'], ['finish foundation rize', 'yellow'],
  ]);
  add('Monday', ['landingpage twtt', 'insta twtt', 'tiktok twtt', 'youtube twtt', 'x twtt', 'facebook page twtt',
    'gumdroad twtt', 'upload book the killer calm'].map(n => [n, 'yellow']));

  await boards.insertOne(board);
  await tasks.insertMany(docs);
  console.log('Seeded the "Weekly Plan" board');
}

async function connect() {
  for (let attempt = 1; ; attempt++) {
    try {
      const client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 5000 });
      await client.connect();
      return client.db(DB_NAME);
    } catch (err) {
      console.log(`MongoDB not reachable (attempt ${attempt}): ${err.message}`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

(async () => {
  const db = await connect();
  boards = db.collection('boards');
  tasks = db.collection('tasks');
  timelogs = db.collection('timelogs');
  settings = db.collection('settings');
  await tasks.createIndex({ boardId: 1, columnId: 1, position: 1 });
  await timelogs.createIndex({ endedAt: 1 });
  await seed();
  app.listen(PORT, () => console.log(`PomoBoard running on http://localhost:${PORT}`));
})();
