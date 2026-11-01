PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS homeowners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  unit TEXT,
  project TEXT,
  phone TEXT,
  email TEXT,
  notes TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  homeowner_id INTEGER NOT NULL REFERENCES homeowners(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  date TEXT NOT NULL,
  start_time TEXT,
  duration_min INTEGER DEFAULT 60,
  status TEXT DEFAULT 'Scheduled',
  notes TEXT,
  gcal_added INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS punch_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  homeowner_id INTEGER NOT NULL REFERENCES homeowners(id) ON DELETE CASCADE,
  recorded_date TEXT,
  area TEXT,
  defect TEXT NOT NULL,
  category TEXT,
  severity TEXT DEFAULT 'Minor',
  notes TEXT,
  status TEXT DEFAULT 'Open',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS repairs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  homeowner_id INTEGER NOT NULL REFERENCES homeowners(id) ON DELETE CASCADE,
  punch_item_id INTEGER REFERENCES punch_items(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  assigned_to TEXT,
  date_started TEXT,
  target_date TEXT,
  date_done TEXT,
  status TEXT DEFAULT 'Open',
  notes TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_sched_date ON schedules(date);
CREATE INDEX IF NOT EXISTS idx_sched_ho ON schedules(homeowner_id);
CREATE INDEX IF NOT EXISTS idx_punch_ho ON punch_items(homeowner_id);
CREATE INDEX IF NOT EXISTS idx_rep_ho ON repairs(homeowner_id);
CREATE INDEX IF NOT EXISTS idx_rep_target ON repairs(target_date);
