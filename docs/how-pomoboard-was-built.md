# How PomoBoard was built

A step-by-step account of how the PomoBoard app was implemented: a local kanban board with a Pomodoro timer, a MongoDB database and a Docker setup that starts with the PC.

- **Runs at:** http://localhost:8790
- **Code:** `C:\Users\rachi\Projects\pomoboard` and https://github.com/hrbenkirane/pomoboard
- **Written:** 24–25 November 2026

---

## 1. The goal

The request was a self-hosted replacement for an online kanban tool, with four requirements:

1. A kanban board with columns and coloured cards, like the weekly plan in the screenshots.
2. A Pomodoro timer that tracks time on tasks.
3. A NoSQL database to store the to-do list.
4. Docker packaging so the app is running whenever the PC is on.

Later requests added colour meanings, an alarm sound, an Excel report with an in-app viewer, and select / edit / delete icons on cards. They are covered in section 10.

## 2. Technology choices

| Part | Choice | Why |
|---|---|---|
| Server | Node.js 22 + Express | Small, one file, easy to run in a container |
| Database | MongoDB 7 | A document (NoSQL) database; a task with its subtasks fits naturally in one document |
| Frontend | Plain HTML, CSS and JavaScript | No build step, nothing to compile, loads instantly |
| Excel export | `exceljs` library | Writes real `.xlsx` files with several sheets |
| Packaging | Docker Compose, two containers | One for the app, one for the database, started together |

The whole app has only three dependencies: `express`, `mongodb` and `exceljs`.

## 3. Project layout

```
pomoboard/
├── server.js            Express server: API, seeding, Excel report
├── package.json         Dependencies
├── Dockerfile           Builds the app image
├── docker-compose.yml   App + MongoDB, restart policy, data volume
├── public/
│   ├── index.html       Page skeleton and dialogs
│   ├── style.css        Layout and card colours
│   └── app.js           Board, drag and drop, timer, report viewer
└── docs/                This document
```

## 4. Step 1 — Check the machine

Before writing code, the environment was inspected:

- Docker and Docker Compose were installed and already running four other local apps.
- Ports 5178, 8787, 8788 and 8789 were taken, so PomoBoard got **port 8790**.
- Docker Desktop is in the Windows startup list, which is what makes auto-start possible.

## 5. Step 2 — Design the data

Four MongoDB collections hold everything:

| Collection | One document is… | Main fields |
|---|---|---|
| `boards` | A board | `name`, `columns` (id, name, isDone), `colorLabels` |
| `tasks` | A card | `boardId`, `columnId`, `position`, `name`, `description`, `color`, `subtasks`, `timeSpent`, `pomodoros`, `completedAt` |
| `timelogs` | One tracked session | `taskId`, `seconds`, `pomodoro` (true for a full one), `type`, `startedAt`, `endedAt` |
| `settings` | Timer settings | `pomodoro`, `shortBreak`, `longBreak`, `longEvery` |

Design decisions:

- **Columns live inside the board document.** A board has few columns and they are always loaded together.
- **Tasks are separate documents** with a numeric `position`, so moving a card only rewrites the positions in one column.
- **A column can be flagged `isDone`.** Moving a card into it stamps `completedAt`; moving it out clears it. This drives the "grouped by date" Done column.
- **Every timer session is its own `timelogs` document.** The task keeps a running total (`timeSpent`), while the log makes reports by day, week and month possible.

## 6. Step 3 — Build the server

`server.js` connects to MongoDB (retrying until the database is ready), creates indexes, seeds the first board, and serves the API and the static frontend.

| Method and path | What it does |
|---|---|
| `GET /api/boards` | List boards |
| `POST /api/boards` | Create a board with To do / In progress / Done |
| `PATCH /api/boards/:id` | Rename, change columns, change colour meanings |
| `DELETE /api/boards/:id` | Delete a board and its tasks |
| `GET /api/boards/:id/tasks` | All cards of a board |
| `POST /api/tasks` | Create a card at the end of a column |
| `PATCH /api/tasks/:id` | Edit name, colour, description, subtasks, time |
| `DELETE /api/tasks/:id` | Delete a card |
| `POST /api/tasks/:id/move` | Move a card to a column and position |
| `POST /api/timelogs` | Log a timer session and add it to the task |
| `GET /api/stats` | Pomodoros and focus time for today, week, month |
| `GET /api/report` | Report data for the in-app viewer |
| `GET /api/report.xlsx` | The same report as an Excel file |
| `GET` / `PUT /api/settings` | Timer durations |

Points worth knowing:

- **Input is cleaned on the server.** Text is trimmed and length-limited, colours must be from the known list, durations must be positive.
- **Moving a card** loads the target column, inserts the card at the requested index, and renumbers the column in one bulk write.
- **First start seeds data.** If the database has no boards, a "Weekly Plan" board is created with the columns and tasks from the screenshots.

## 7. Step 4 — Build the board

The frontend is one page. `app.js` keeps a small `state` object (boards, current board, tasks, filter, settings) and redraws the board from it.

- **Columns and cards** are created with DOM calls using `textContent`, so task names can never inject HTML.
- **Drag and drop** uses the browser's native drag events. While dragging, a dashed placeholder shows where the card will land; on drop the position is sent to the move endpoint.
- **The Done column** sorts by completion date and inserts date headings ("Today", "Tuesday 10 November").
- **The task dialog** handles both creating and editing: name, colour, column, description, subtasks and time spent. Ctrl+Enter saves and closes; Ctrl+Shift+Enter saves and opens a new empty task.
- **Board and column menus** allow rename, reorder, delete, and choosing which column is the Done column.
- **Custom confirm and prompt dialogs** replace the browser's built-in ones, which look out of place and block automated testing.

## 8. Step 5 — Build the Pomodoro timer

The timer lives in the top bar and opens a panel with two modes: Pomodoro and Stopwatch.

- **State is stored in the browser** (`localStorage`) as a start timestamp plus accumulated time. Reloading the page, or closing and reopening it, does not lose a running timer.
- **Pomodoro cycle:** focus → short break → focus → … with a long break every fourth pomodoro. All four numbers are adjustable.
- **Logging:** a finished pomodoro logs its full length to the task and counts as one pomodoro. Stopping early logs the time done so far without counting a pomodoro.
- **Starting on another card** first logs the time of the current one, then switches.
- **Feedback:** the top-bar pill turns red during focus and green during breaks, the browser tab title shows the countdown, and a desktop notification appears when a phase ends.

## 9. Step 6 — Package with Docker

`Dockerfile` builds a small image from `node:22-alpine`, installs the production dependencies and runs the server as a non-root user.

`docker-compose.yml` defines two services:

- **`app`** — the Node server, published only on `127.0.0.1:8790`, so it is not reachable from other devices on the network.
- **`mongo`** — MongoDB 7 with a health check; the app waits for it to be healthy before starting.

Two settings deliver the "always running" and "never lost" requirements:

- **`restart: unless-stopped`** on both services. Docker brings them back whenever Docker itself starts, and Docker Desktop starts with Windows.
- **A named volume, `pomoboard-data`**, mounted at MongoDB's data folder. Containers can be rebuilt or replaced; the data stays in the volume.

Start or rebuild with:

```
docker compose up -d --build
```

## 10. Features added afterwards

### Colour meanings
Each colour has a label (1pm, 2pm, …) stored per board in `colorLabels`. The labels appear under the swatches in the task dialog and in a legend row under the top bar. Clicking a legend chip renames it.

### Alarm sound
The short beep was replaced by a four-note chime played three times, generated with the Web Audio API, so no sound file is needed. Two details make it reliable:

- The audio context is unlocked by the first click on the page, because browsers block sound that is not triggered by the user.
- The timer ticks from a Web Worker, because browsers slow down timers in background tabs and the alarm would otherwise be late.

### Excel report
`/api/report.xlsx` builds a workbook with four sheets: **Summary** (today, this week from Monday, this month), **Daily**, **By task** and **Log**. The browser sends its own time zone and the start of the day, week and month, so "today" follows the PC's clock and not the container's UTC clock.

### Report viewer
The report logic was moved into one function, `buildReport`, used by both the Excel download and a JSON endpoint. The **Report** button opens a window with one tab per sheet and a download button.

### Select, edit and delete icons
Clicking a card now selects it instead of opening it. The selected card gets a blue outline and three icons: delete, edit and start timer. Delete always asks for confirmation first.

## 11. How it was tested

Each feature was checked in a real browser against the running containers:

- The board loaded with all seeded tasks and no console errors.
- A task was created through the dialog, then started, stopped and its logged time verified in the database.
- A pomodoro was fast-forwarded to completion to check the switch to a break, the pomodoro count and the logged 25 minutes.
- A card was dragged to a new position and the new order confirmed.
- The Excel file was generated and read back sheet by sheet.
- Both containers were restarted and the document counts compared before and after (1 board, 39 tasks, 1 time log — identical).
- Selecting, editing and deleting were exercised on a throwaway card, including cancelling the delete.

Not tested: a full PC reboot, the stopwatch mode, and renaming or deleting boards and columns through the menus.

## 12. Publishing to GitHub

The project was committed with git and pushed to a private-by-recommendation repository. The GitHub command-line tool is not installed on this PC, so the empty repository had to be created by hand on github.com before the first push. Three commits were pushed:

1. The initial app.
2. Colour meanings, alarm and Excel report.
3. Card selection icons and the report viewer.

## 13. Day-to-day use

| Task | Command (run in the project folder) |
|---|---|
| Start or apply code changes | `docker compose up -d --build` |
| Stop | `docker compose stop` |
| See server logs | `docker logs pomoboard` |
| Back up the database | `docker exec pomoboard-mongo mongodump --db pomoboard --archive > pomoboard.archive` |

**Warning:** `docker compose down -v`, or deleting the `pomoboard_pomoboard-data` volume in Docker Desktop, erases all boards, tasks and time logs. Normal restarts, rebuilds and reboots do not.

## 14. Known limits

- The report only counts sessions tracked in PomoBoard. Times carried over from the screenshots are shown on the cards but are not in the report.
- The default colour meanings after yellow (1pm) are a guess and should be renamed to match the real system.
- The app has no login. It is only reachable from this PC, which is the protection.
- Timer state is per browser. Opening the app in a second browser shows the same board but not the running timer.
