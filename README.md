# Punchlist Manager

Offline, portable Windows app for scheduling homeowner punchlist/acceptance dates,
recording punchlist items, and tracking repairs (flagged red when past target date).

- **Tech:** Tauri 2 (Rust) + SQLite. Screens are plain HTML/CSS/JS in `ui/`.
- **Data:** `PunchlistData/punchlist.db` next to the .exe (portable).
- **Google Calendar:** "Add to Google Calendar" button (opens a pre-filled event in the browser).

## Get the .exe
Every push to `main` builds it on GitHub: **Actions → Build Windows EXE → latest run → Artifacts → PunchlistManager-windows**.
Push a tag like `v1.0.0` to also publish a Release with a zip.

## Build locally (optional)
Install Rust (https://rustup.rs), then:
```
cd src-tauri
cargo build --release
```
The exe is `src-tauri/target/release/punchlist-app.exe`.

## Project layout
```
ui/                 screens (index.html, app.js, styles.css)
src-tauri/src/      Rust: database, Excel export, backup, open links
src-tauri/src/schema.sql   database tables
docs/HOW-TO-USE.txt user guide shipped with the exe
tests/              browser click-through test (Python + Playwright, dev only)
```
