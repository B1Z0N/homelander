// SQLite database layer for Homelander.
// Uses better-sqlite3 — synchronous API, perfect for embedded use.

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

const SCHEMA_VERSION = 5;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS filters (
  id TEXT PRIMARY KEY,
  name TEXT,
  web_url TEXT NOT NULL,
  mobile_params TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  last_polled_at TEXT,
  total_seen INTEGER DEFAULT 0,
  first_poll_done INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS manual_skips (
  expose_id TEXT PRIMARY KEY,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS listings (
  hash TEXT PRIMARY KEY,
  expose_id TEXT NOT NULL,
  title TEXT,
  price REAL,
  size REAL,
  rooms REAL,
  address TEXT,
  image_url TEXT,
  filter_id TEXT REFERENCES filters(id),
  status TEXT DEFAULT 'seen',
  discovered_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  sent_at TEXT,
  outcome TEXT,
  failure_reason TEXT,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_hash TEXT,
  filter_id TEXT,
  outcome TEXT,
  detail TEXT,
  timestamp TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_filter ON listings(filter_id);
CREATE INDEX IF NOT EXISTS idx_listings_discovered ON listings(filter_id, discovered_at);
CREATE INDEX IF NOT EXISTS idx_results_timestamp ON results(timestamp);
CREATE INDEX IF NOT EXISTS idx_listings_expose_id ON listings(expose_id);
`;

export class HomelanderDB {
  constructor(dbPath) {
    // better-sqlite3 requires the parent directory to exist — it does NOT auto-create it.
    // On fresh Windows installs (and first macOS runs), ~/.homelander/ may not exist yet.
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this._migrate();
  }

  _migrate() {
    let version = null;
    try {
      version = this.db.prepare(
        'SELECT version FROM schema_version'
      ).get();
    } catch {
      // Table doesn't exist yet — first run
    }

    if (!version || version.version < SCHEMA_VERSION) {
      // v2 → v3: add archived column (safe to run on new DBs too — no-op)
      if (version && version.version < 3) {
        try {
          this.db.exec('ALTER TABLE filters ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
        } catch {
          // Column already exists (first-run via SCHEMA) — ignore
        }
      }
      if (version && version.version < 4) {
        try {
          this.db.exec('ALTER TABLE filters ADD COLUMN first_poll_done INTEGER NOT NULL DEFAULT 0');
        } catch {
          // Column already exists (first-run via SCHEMA) — ignore
        }
      }
      this.db.exec(SCHEMA);
      if (version && version.version < 4) {
        this.db.exec(`
          UPDATE filters
          SET first_poll_done = 1
          WHERE last_polled_at IS NOT NULL AND last_polled_at != '';

          INSERT OR IGNORE INTO manual_skips (expose_id)
          SELECT DISTINCT expose_id
          FROM listings
          WHERE outcome = 'MANUAL' AND expose_id IS NOT NULL AND expose_id != '';
        `);
      }
      if (version && version.version < 5) {
        // FAIL rows caused by a thrown exception (failure_reason = 'error') are
        // reclassified as ERROR — distinct from domain outcomes like
        // DEACTIVATED/PREMIUM or expected apply-blocking reasons (captcha, etc).
        this.db.exec(`
          UPDATE listings SET outcome = 'ERROR' WHERE outcome = 'FAIL' AND failure_reason = 'error';
          UPDATE results SET outcome = 'ERROR' WHERE outcome = 'FAIL' AND detail LIKE 'ERROR:%';
        `);
      }
      this.db.exec('DELETE FROM schema_version');
      this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    }
  }

  close() {
    this.db.close();
  }

  // ── Filters ──────────────────────────────────────────────────

  addFilter({ id, name, web_url, mobile_params }) {
    return this.db.prepare(`
      INSERT INTO filters (id, name, web_url, mobile_params)
      VALUES (?, ?, ?, ?)
    `).run(id, name || '', web_url, mobile_params);
  }

  getFilters() {
    return this.db.prepare(`
      SELECT f.*,
        (SELECT COUNT(*) FROM listings WHERE filter_id = f.id AND status = 'seen') as new_count,
        (SELECT COUNT(*) FROM listings WHERE filter_id = f.id AND status = 'sent' AND outcome != 'MANUAL') as sent_count,
        (SELECT COUNT(*) FROM listings WHERE filter_id = f.id AND status IN ('sent', 'failed') AND outcome != 'MANUAL' AND date(sent_at, 'localtime') = date('now', 'localtime')) as processed_count,
        (SELECT COUNT(*) FROM listings WHERE filter_id = f.id AND status IN ('sent', 'failed') AND outcome != 'MANUAL') as processed_all_time,
        (SELECT COUNT(*) FROM listings WHERE filter_id = f.id AND status = 'seen' AND date(discovered_at, 'localtime') = date('now', 'localtime')) as today_pending,
        (SELECT COUNT(*) FROM listings WHERE filter_id = f.id AND (
          (status IN ('sent', 'failed') AND outcome != 'MANUAL' AND date(sent_at, 'localtime') = date('now', 'localtime'))
          OR (status = 'seen' AND date(discovered_at, 'localtime') = date('now', 'localtime'))
        )) as today_seen,
        (SELECT COUNT(*) FROM listings WHERE filter_id = f.id AND (
          (status IN ('sent', 'failed') AND outcome != 'MANUAL' AND date(sent_at, 'localtime') = date('now', 'localtime'))
          OR (status = 'seen' AND date(discovered_at, 'localtime') = date('now', 'localtime'))
        )) as today_total
      FROM filters f
      WHERE f.archived = 0
      ORDER BY f.created_at DESC, f.rowid DESC
    `).all();
  }

  getFilter(id) {
    return this.db.prepare('SELECT * FROM filters WHERE id = ?').get(id);
  }

  updateFilter(id, patch) {
    const ALLOWED = new Set([
      'name', 'web_url', 'mobile_params', 'enabled',
      'last_polled_at', 'total_seen', 'first_poll_done',
    ]);
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!ALLOWED.has(k)) continue;
      sets.push(`${k} = ?`);
      // better-sqlite3 rejects JS booleans — convert to 0/1
      vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
    }
    if (sets.length === 0) return;
    vals.push(id);
    this.db.prepare(`UPDATE filters SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  incrementFilterSeen(id, delta) {
    this.db.prepare(`
      UPDATE filters
      SET last_polled_at = ?,
          total_seen = COALESCE(total_seen, 0) + ?,
          first_poll_done = 1
      WHERE id = ?
    `).run(new Date().toISOString(), delta || 0, id);
  }

  removeFilter(id) {
    // Soft-delete: archive the filter, clear pending queue so aggregate
    // stats reflect only active searches. Processed listings stay for history.
    this.db.prepare('UPDATE filters SET archived = 1 WHERE id = ?').run(id);
    this.clearQueue(id);
  }

  // ── Listings ─────────────────────────────────────────────────

  static hashListing(exposeId, price) {
    return createHash('sha256').update(`${exposeId}|${price}`).digest('hex').slice(0, 16);
  }

  insertListing(listing) {
    const hash = HomelanderDB.hashListing(listing.expose_id, listing.price);
    // Manual skips are tracked separately from history so users can block
    // future auto-apply without rewriting real SENT/FAIL/PREMIUM outcomes.
    const manuallyApplied = this.db.prepare(`
      SELECT 1 FROM manual_skips WHERE expose_id = ? LIMIT 1
    `).get(String(listing.expose_id));
    if (manuallyApplied) return { changes: 0, skipped: true };
    try {
      return this.db.prepare(`
        INSERT INTO listings (hash, expose_id, title, price, size, rooms, address, image_url, filter_id, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'seen')
      `).run(
        hash, listing.expose_id, listing.title, listing.price,
        listing.size, listing.rooms, listing.address, listing.image_url,
        listing.filter_id
      );
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
        return { changes: 0, skipped: true };
      }
      throw err;
    }
  }

  /** Bulk insert — returns count of actually inserted listings. */
  insertListings(listings, filterId) {
    let inserted = 0;
    const txn = this.db.transaction(() => {
      for (const listing of listings) {
        const result = this.insertListing({ ...listing, filter_id: filterId });
        if (result.changes > 0) inserted++;
      }
    });
    txn();
    return inserted;
  }

  getSeenListings(filterId = null) {
    let sql = 'SELECT * FROM listings WHERE status = ?';
    const params = ['seen'];
    if (filterId) {
      sql += ' AND filter_id = ?';
      params.push(filterId);
    }
    sql += ' ORDER BY discovered_at ASC';
    return this.db.prepare(sql).all(...params);
  }

  clearQueue(filterId) {
    const info = this.db.prepare(
      "UPDATE listings SET status = 'skipped', outcome = 'SKIPPED', detail = 'queue cleared' WHERE filter_id = ? AND status = 'seen'"
    ).run(filterId);
    return { cleared: info.changes };
  }

  isManuallyApplied(exposeId) {
    return !!this.db.prepare(
      "SELECT 1 FROM manual_skips WHERE expose_id = ? LIMIT 1"
    ).get(String(exposeId));
  }

  deleteByHash(hash) {
    const txn = this.db.transaction(() => {
      this.db.prepare('DELETE FROM listings WHERE hash = ?').run(hash);
      this.db.prepare('DELETE FROM results WHERE listing_hash = ?').run(hash);
    });
    txn();
  }

  markAlreadyApplied(exposeId) {
    const id = String(exposeId);
    const existing = this.db.prepare(
      'SELECT hash, status, outcome FROM listings WHERE expose_id = ? ORDER BY rowid DESC LIMIT 1'
    ).get(id);

    let manualSkipInserted = 0;
    let pendingRowsProtected = 0;
    const txn = this.db.transaction(() => {
      manualSkipInserted = this.db.prepare(
        'INSERT OR IGNORE INTO manual_skips (expose_id) VALUES (?)'
      ).run(id).changes;
      // Only remove pending queue rows from automation. Do not rewrite real
      // history rows (SENT/FAIL/PREMIUM/DEACTIVATED), otherwise stats/history lie.
      pendingRowsProtected = this.db.prepare(`
        UPDATE listings
        SET status = 'sent', outcome = 'MANUAL', detail = 'applied manually',
          sent_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), failure_reason = NULL
        WHERE expose_id = ? AND status = 'seen'
      `).run(id).changes;
    });
    txn();

    return {
      found: !!existing,
      exposeId: id,
      changed: pendingRowsProtected + manualSkipInserted,
      manualSkipInserted,
      pendingRowsProtected,
      alreadyProtected: manualSkipInserted === 0 && pendingRowsProtected === 0,
      processing: existing?.status === 'processing',
      skipped: true,
    };
  }

  markSent(hash, outcome, detail, failureReason = '') {
    const status = outcome === 'SENT' ? 'sent' : 'failed';
    const txn = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE listings SET status = ?, outcome = ?, sent_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), detail = ?, failure_reason = ?
        WHERE hash = ?
      `).run(status, outcome, detail || '', failureReason || '', hash);

      this.db.prepare(`
        INSERT INTO results (listing_hash, outcome, detail) VALUES (?, ?, ?)
      `).run(hash, outcome, detail || '');
    });
    txn();
  }

  /** Reset a listing back to 'seen' so the apply loop picks it up again.
   *  Clears outcome/detail/failure_reason/sent_at so the listing
   *  disappears from history until the daemon re-processes it. */
  retryListing(exposeId) {
    const row = this.db.prepare('SELECT hash, status FROM listings WHERE expose_id = ?').get(exposeId);
    if (!row) return { error: 'Listing not found' };
    if (row.status === 'seen') return { hash: row.hash, already_seen: true };
    this.db.prepare(`
      UPDATE listings SET status = 'seen', outcome = NULL, detail = NULL, 
        failure_reason = NULL, sent_at = NULL
      WHERE hash = ?
    `).run(row.hash);
    return { hash: row.hash };
  }

  /** Retry ALL failed listings that are genuinely retryable.
   *  Skips: PREMIUM-only, DEACTIVATED, CAPTCHA-only failures.
   *  Only resets listings with outcome FAIL / SUBMIT_FAILED /
   *  SESSION_EXPIRED, excluding premium/deactivated reasons. */
  retryAllFailed(filterId = null) {
    let sql = `UPDATE listings SET status = 'seen', outcome = NULL, detail = NULL,
      failure_reason = NULL, sent_at = NULL
      WHERE outcome IN ('FAIL', 'ERROR', 'SUBMIT_FAILED', 'SESSION_EXPIRED', 'CAPTCHA')
      AND (detail IS NULL OR (detail NOT LIKE '%premium%' AND detail NOT LIKE '%deactivated%'))
      AND (failure_reason IS NULL OR (failure_reason NOT LIKE '%premium%' AND failure_reason NOT LIKE '%deactivated%'))`;
    const params = [];
    if (filterId) {
      sql += ' AND filter_id = ?';
      params.push(filterId);
    }
    const info = this.db.prepare(sql).run(...params);
    return { changed: info.changes };
  }

  getHistory(limit = 100, offset = 0, filterId = null, outcome = null) {
    let sql = "SELECT * FROM listings WHERE outcome IS NOT NULL AND outcome != 'MANUAL'";
    const params = [];
    if (filterId) {
      sql += ' AND filter_id = ?';
      params.push(filterId);
    }
    if (outcome) {
      if (outcome === 'CAPTCHA') {
        sql += ' AND (failure_reason LIKE ? OR detail LIKE ?)';
        params.push('%captcha%', '%captcha%');
      } else if (outcome === 'PREMIUM') {
        sql += ' AND (outcome = \'PREMIUM\' OR failure_reason LIKE ? OR detail LIKE ? OR detail LIKE ?)';
        params.push('%premium%', '%premium%', '%Suchen+%');
      } else if (outcome === 'FAIL') {
        // Match the same "pure failed" definition used in getStats/getTodayStats.
        // ERROR (thrown exception / unrelated infra failure) reuses the same
        // "Failed" pill in the UI, so it's included here too.
        sql += ' AND outcome IN (\'FAIL\', \'ERROR\') AND outcome NOT IN (\'DEACTIVATED\', \'PREMIUM\') AND failure_reason NOT LIKE ? AND detail NOT LIKE ? AND detail NOT LIKE ?';
        params.push('%premium%', '%premium%', '%Suchen+%');
      } else {
        sql += ' AND outcome = ?';
        params.push(outcome);
      }
    }
    sql += ' ORDER BY COALESCE(sent_at, discovered_at) DESC, rowid DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    return this.db.prepare(sql).all(...params);
  }

  getStats(filterId = null) {
    const whereFilter = filterId ? ' WHERE filter_id = ?' : ' WHERE filter_id IS NOT NULL';
    const filterParam = filterId ? [filterId] : [];

    // Waterfall partition: sent + failed + deactivated + premium = total.
    // Each listing falls into exactly ONE bucket. Captcha is orthogonal.
    const row = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN status IN ('sent', 'failed') AND outcome != 'MANUAL' THEN 1 ELSE 0 END), 0) as total,
        COALESCE(SUM(CASE WHEN (status = 'sent' OR outcome = 'SENT') AND outcome != 'MANUAL' THEN 1 ELSE 0 END), 0) as sent,
        COALESCE(SUM(CASE WHEN outcome = 'DEACTIVATED' THEN 1 ELSE 0 END), 0) as deactivated,
        COALESCE(SUM(CASE WHEN outcome = 'PREMIUM'
                           OR failure_reason LIKE '%premium%'
                           OR detail LIKE '%premium%'
                           OR detail LIKE '%Suchen+%'
                         THEN 1 ELSE 0 END), 0) as premium,
        COALESCE(SUM(CASE WHEN (status = 'failed' OR outcome = 'FAIL')
                           AND outcome NOT IN ('DEACTIVATED', 'PREMIUM')
                           AND failure_reason NOT LIKE '%premium%'
                           AND detail NOT LIKE '%premium%'
                           AND detail NOT LIKE '%Suchen+%'
                         THEN 1 ELSE 0 END), 0) as failed,
        COALESCE(SUM(CASE WHEN (failure_reason LIKE '%captcha%' OR detail LIKE '%captcha%') THEN 1 ELSE 0 END), 0) as captcha,
        COALESCE(SUM(CASE WHEN outcome = 'ERROR' THEN 1 ELSE 0 END), 0) as error,
        COALESCE(SUM(CASE WHEN status = 'seen' THEN 1 ELSE 0 END), 0) as seen_unapplied,
        COALESCE(SUM(CASE WHEN status = 'sent' AND outcome != 'MANUAL' AND date(sent_at, 'localtime') = date('now', 'localtime') THEN 1 ELSE 0 END), 0) as today
      FROM listings${whereFilter}
    `).get(...filterParam);

    return {
      total: row.total, sent: row.sent, failed: row.failed,
      deactivated: row.deactivated, premium: row.premium, captcha: row.captcha,
      error: row.error, seen_unapplied: row.seen_unapplied, today: row.today,
    };
  }

  getTodayStats(filterId = null) {
    const whereFilter = filterId ? ' AND filter_id = ?' : ' AND filter_id IS NOT NULL';
    const filterParam = filterId ? [filterId] : [];

    // Same waterfall partition as getStats(), scoped to today by sent_at.
    const row = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN status IN ('sent', 'failed') AND outcome != 'MANUAL' THEN 1 ELSE 0 END), 0) as total,
        COALESCE(SUM(CASE WHEN (status = 'sent' OR outcome = 'SENT') AND outcome != 'MANUAL' THEN 1 ELSE 0 END), 0) as sent,
        COALESCE(SUM(CASE WHEN outcome = 'DEACTIVATED' THEN 1 ELSE 0 END), 0) as deactivated,
        COALESCE(SUM(CASE WHEN outcome = 'PREMIUM'
                           OR failure_reason LIKE '%premium%'
                           OR detail LIKE '%premium%'
                           OR detail LIKE '%Suchen+%'
                         THEN 1 ELSE 0 END), 0) as premium,
        COALESCE(SUM(CASE WHEN (status = 'failed' OR outcome = 'FAIL')
                           AND outcome NOT IN ('DEACTIVATED', 'PREMIUM')
                           AND failure_reason NOT LIKE '%premium%'
                           AND detail NOT LIKE '%premium%'
                           AND detail NOT LIKE '%Suchen+%'
                         THEN 1 ELSE 0 END), 0) as failed,
        COALESCE(SUM(CASE WHEN (failure_reason LIKE '%captcha%' OR detail LIKE '%captcha%') THEN 1 ELSE 0 END), 0) as captcha,
        COALESCE(SUM(CASE WHEN outcome = 'ERROR' THEN 1 ELSE 0 END), 0) as error,
        COALESCE(SUM(CASE WHEN status = 'sent' AND outcome != 'MANUAL' THEN 1 ELSE 0 END), 0) as today
      FROM listings WHERE date(sent_at, 'localtime') = date('now', 'localtime')${whereFilter}
    `).get(...filterParam);

    // seen_unapplied uses discovered_at, not sent_at — query separately
    const seenUnapplied = this.db.prepare(
      `SELECT COUNT(*) as count FROM listings WHERE status = 'seen' AND date(discovered_at, 'localtime') = date('now', 'localtime')${whereFilter}`
    ).get(...filterParam);

    return {
      total: row.total, sent: row.sent, failed: row.failed,
      deactivated: row.deactivated, premium: row.premium, captcha: row.captcha,
      error: row.error, seen_unapplied: seenUnapplied.count, today: row.today,
    };
  }

  getRecentActivity(limit = 50) {
    return this.db.prepare(`
      SELECT hash, expose_id, title, price, address, outcome, failure_reason, detail, sent_at, image_url
      FROM listings
      WHERE outcome IS NOT NULL AND outcome != 'MANUAL'
      ORDER BY COALESCE(sent_at, discovered_at) DESC, rowid DESC
      LIMIT ?
    `).all(limit);
  }

  getCaptchaConsecutive() {
    // Count how many consecutive FAIL/captcha results we have (most recent first)
    const rows = this.db.prepare(`
      SELECT outcome, failure_reason FROM listings
      WHERE outcome IS NOT NULL AND outcome != 'MANUAL'
      ORDER BY COALESCE(sent_at, discovered_at) DESC, rowid DESC
      LIMIT 20
    `).all();

    let consecutive = 0;
    for (const row of rows) {
      if (row.failure_reason === 'captcha' || (row.outcome === 'FAIL' && (row.failure_reason || '').includes('captcha'))) {
        consecutive++;
      } else {
        break;
      }
    }
    return consecutive;
  }
}
