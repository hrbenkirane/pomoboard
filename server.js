'use strict';
const express = require('express');
const { MongoClient } = require('mongodb');
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

app.get('/api/stats', wrap(async (req, res) => {
  const since = new Date(Number(req.query.since) || Date.now() - 24 * 3600 * 1000);
  const [row] = await timelogs.aggregate([
    { $match: { endedAt: { $gte: since } } },
    { $group: { _id: null, seconds: { $sum: '$seconds' }, pomodoros: { $sum: { $cond: ['$pomodoro', 1, 0] } } } },
  ]).toArray();
  res.json({ seconds: row ? row.seconds : 0, pomodoros: row ? row.pomodoros : 0 });
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
