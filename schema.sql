-- Compositions: a HyperFrames HTML composition the user (or agent) authors.
-- width/height/duration live in the HTML's data-* attributes; we only keep the
-- render-time knobs the CLI needs (fps).
CREATE TABLE IF NOT EXISTS compositions (
  -- UUIDv4. The API supplies crypto.randomUUID(); this default covers any
  -- direct insert so the primary key (and the URL it appears in) is always a UUID.
  id TEXT PRIMARY KEY DEFAULT (
    lower(hex(randomblob(4))) || '-' ||
    lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6)))
  ),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  html TEXT NOT NULL DEFAULT '',
  fps INTEGER NOT NULL DEFAULT 30,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Media library: logos, product-demo clips, images the user uploads. Stored in
-- R2 under `key`; the composition HTML references them as `assets/<key>`.
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Edit-service staging pointer: uploaded once, reused by every export.
  -- Staged copies expire (~30 days); exports re-stage transparently when the
  -- pointer is missing or stale, so this is a cache, not a source of truth.
  service_key TEXT,
  service_key_expires_at TEXT,
  -- Media length in seconds, probed client-side at upload (the browser reads
  -- it from the local file instantly). Data, not a runtime probe — the
  -- timeline needs it synchronously, and moov-at-end files make network
  -- probing arbitrarily slow.
  duration REAL
);

-- Render jobs: one row per render. The MP4 is stored in R2 and served from
-- output_url. status: rendering | completed | failed.
CREATE TABLE IF NOT EXISTS render_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  composition_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'rendering',
  output_url TEXT,
  error TEXT,
  -- The media-library asset this render produced. A finished composition is
  -- footage: registering it keeps it reusable instead of a dead end that only
  -- ever gets downloaded.
  asset_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_render_jobs_composition ON render_jobs(composition_id);
