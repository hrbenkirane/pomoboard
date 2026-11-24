# PomoBoard

A local kanban board with a built-in Pomodoro timer. Node/Express serves the app, MongoDB stores boards, tasks and time logs.

## Run

```
docker compose up -d --build
```

Open http://localhost:8790. Both containers use `restart: unless-stopped`, so they come back whenever Docker starts.

## Features

- Multiple boards; add, rename, reorder and delete columns
- Drag and drop cards between and within columns
- Tasks with colour, description, subtasks and tracked time
- Done columns group tasks by completion date
- Pomodoro timer (focus / short break / long break) and a stopwatch; time is logged onto the task
- Data lives in the `pomoboard-data` Docker volume

## Backup

```
docker exec pomoboard-mongo mongodump --db pomoboard --archive > pomoboard.archive
```
