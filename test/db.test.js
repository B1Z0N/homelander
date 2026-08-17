// Unit tests for HomelanderDB (engine/db.js).
// Run: node --test test/db.test.js
//
// Uses an in-memory SQLite database so tests are fast and isolated.
// Each sub-suite creates a fresh DB via a helper.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { HomelanderDB } from '../engine/db.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fresh in-memory DB. */
function freshDB() {
  return new HomelanderDB(':memory:');
}

/** Create a DB with one filter pre-inserted. */
function seededDB() {
  const db = freshDB();
  db.addFilter({
    id: 'f1',
    name: 'Berlin Apartments',
    web_url: 'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten',
    mobile_params: '{}',
  });
  return db;
}

/** Insert a listing into the DB and return the hash. */
function seedListing(db, overrides = {}) {
  const defaults = {
    expose_id: '12345',
    title: 'Test Wohnung',
    price: 800,
    size: 50,
    rooms: 2,
    address: 'Berlin-Mitte',
    image_url: '',
    filter_id: 'f1',
  };
  const listing = { ...defaults, ...overrides };
  db.insertListing(listing);
  return HomelanderDB.hashListing(listing.expose_id, listing.price);
}

// ---------------------------------------------------------------------------
// Constructor & schema
// ---------------------------------------------------------------------------

describe('HomelanderDB constructor', () => {
  it('creates schema tables on :memory:', () => {
    const db = freshDB();
    const tables = db.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((t) => t.name)
      .sort();
    assert.deepEqual(tables, ['filters', 'listings', 'manual_skips', 'results', 'schema_version']);
    db.close();
  });

  it('sets journal mode (WAL for file, memory for :memory:)', () => {
    const db = freshDB();
    const modeRaw = db.db.pragma('journal_mode');
    const mode = Array.isArray(modeRaw) ? modeRaw[0]?.journal_mode : modeRaw;
    // :memory: DBs use 'memory' journal; file DBs use 'wal'
    assert.ok(mode === 'wal' || mode === 'memory',
      `Expected wal or memory, got: ${JSON.stringify(mode)}`);
    db.close();
  });

  it('sets foreign_keys ON', () => {
    const db = freshDB();
    const fk = db.db.pragma('foreign_keys');
    // pragma returns [{foreign_keys: 1}] — extract the value
    const fkVal = Array.isArray(fk) ? fk[0]?.foreign_keys : fk;
    assert.equal(fkVal, 1);
    db.close();
  });

  it('records schema version', () => {
    const db = freshDB();
    const row = db.db.prepare('SELECT version FROM schema_version').get();
    assert.equal(row.version, 5);
    db.close();
  });

  it('migrates v3 filters with last_polled_at to first_poll_done', () => {
    const dir = mkdtempSync(join(tmpdir(), 'homelander-db-migration-'));
    const file = join(dir, 'homelander.db');
    try {
      const old = new Database(file);
      old.exec(`
        CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
        INSERT INTO schema_version (version) VALUES (3);
        CREATE TABLE filters (
          id TEXT PRIMARY KEY,
          name TEXT,
          web_url TEXT NOT NULL,
          mobile_params TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          archived INTEGER NOT NULL DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          last_polled_at TEXT,
          total_seen INTEGER DEFAULT 0
        );
        CREATE TABLE listings (
          hash TEXT PRIMARY KEY,
          expose_id TEXT NOT NULL,
          title TEXT,
          price INTEGER,
          size REAL,
          rooms REAL,
          address TEXT,
          image_url TEXT,
          filter_id TEXT,
          status TEXT NOT NULL DEFAULT 'seen',
          discovered_at TEXT DEFAULT (datetime('now')),
          sent_at TEXT,
          outcome TEXT,
          detail TEXT,
          failure_reason TEXT DEFAULT '',
          FOREIGN KEY(filter_id) REFERENCES filters(id) ON DELETE CASCADE
        );
        CREATE TABLE results (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          listing_hash TEXT NOT NULL,
          filter_id TEXT,
          outcome TEXT NOT NULL,
          detail TEXT,
          timestamp TEXT DEFAULT (datetime('now')),
          FOREIGN KEY(listing_hash) REFERENCES listings(hash) ON DELETE CASCADE
        );
        INSERT INTO filters (id, name, web_url, mobile_params, last_polled_at, total_seen)
        VALUES ('old-polled', 'Old', 'https://example.com', '{}', '2026-01-01T00:00:00.000Z', 12);
        INSERT INTO filters (id, name, web_url, mobile_params, last_polled_at, total_seen)
        VALUES ('old-new', 'New', 'https://example.com', '{}', NULL, 0);
      `);
      old.close();

      const db = new HomelanderDB(file);
      assert.equal(db.getFilter('old-polled').first_poll_done, 1);
      assert.equal(db.getFilter('old-new').first_poll_done, 0);
      assert.equal(db.db.prepare('SELECT version FROM schema_version').get().version, 5);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migrates v3 MANUAL listing stubs into manual_skips', () => {
    const dir = mkdtempSync(join(tmpdir(), 'homelander-db-migration-'));
    const file = join(dir, 'homelander.db');
    try {
      const old = new Database(file);
      old.exec(`
        CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
        INSERT INTO schema_version (version) VALUES (3);
        CREATE TABLE filters (
          id TEXT PRIMARY KEY,
          name TEXT,
          web_url TEXT NOT NULL,
          mobile_params TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          archived INTEGER NOT NULL DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          last_polled_at TEXT,
          total_seen INTEGER DEFAULT 0
        );
        CREATE TABLE listings (
          hash TEXT PRIMARY KEY,
          expose_id TEXT NOT NULL,
          title TEXT,
          price INTEGER,
          size REAL,
          rooms REAL,
          address TEXT,
          image_url TEXT,
          filter_id TEXT,
          status TEXT NOT NULL DEFAULT 'seen',
          discovered_at TEXT DEFAULT (datetime('now')),
          sent_at TEXT,
          outcome TEXT,
          detail TEXT,
          failure_reason TEXT DEFAULT '',
          FOREIGN KEY(filter_id) REFERENCES filters(id) ON DELETE CASCADE
        );
        CREATE TABLE results (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          listing_hash TEXT NOT NULL,
          filter_id TEXT,
          outcome TEXT NOT NULL,
          detail TEXT,
          timestamp TEXT DEFAULT (datetime('now')),
          FOREIGN KEY(listing_hash) REFERENCES listings(hash) ON DELETE CASCADE
        );
        INSERT INTO listings (hash, expose_id, price, status, outcome, detail)
        VALUES ('h-manual', 'old-manual', 0, 'sent', 'MANUAL', 'applied manually');
      `);
      old.close();

      const db = new HomelanderDB(file);
      assert.equal(db.isManuallyApplied('old-manual'), true);
      const insert = db.insertListing({ expose_id: 'old-manual', price: 1200, title: 'Should stay skipped', filter_id: 'f1' });
      assert.equal(insert.changes, 0);
      assert.equal(insert.skipped, true);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// hashListing (static)
// ---------------------------------------------------------------------------

describe('hashListing', () => {
  it('produces a deterministic 16-char hex hash', () => {
    const h1 = HomelanderDB.hashListing('12345', 800);
    const h2 = HomelanderDB.hashListing('12345', 800);
    assert.equal(h1, h2);
    assert.equal(h1.length, 16);
    assert.match(h1, /^[0-9a-f]{16}$/);
  });

  it('produces different hashes for different inputs', () => {
    const h1 = HomelanderDB.hashListing('12345', 800);
    const h2 = HomelanderDB.hashListing('12345', 801);
    const h3 = HomelanderDB.hashListing('54321', 800);
    assert.notEqual(h1, h2);
    assert.notEqual(h1, h3);
    assert.notEqual(h2, h3);
  });

  it('treats price as a number (coerces)', () => {
    const h1 = HomelanderDB.hashListing('abc', 1000);
    const h2 = HomelanderDB.hashListing('abc', '1000');
    assert.equal(h1, h2);
  });
});

// ---------------------------------------------------------------------------
// Filters — CRUD
// ---------------------------------------------------------------------------

describe('addFilter', () => {
  let db;
  beforeEach(() => { db = freshDB(); });
  after(() => { db?.close(); });

  it('inserts a filter with all fields', () => {
    const result = db.addFilter({
      id: 'f-test',
      name: 'Test Filter',
      web_url: 'https://is24.de/Suche/de/berlin/berlin/wohnung-mieten',
      mobile_params: '{"pricetype":"calculatedtotalrent"}',
    });
    assert.equal(result.changes, 1);

    const saved = db.getFilter('f-test');
    assert.equal(saved.id, 'f-test');
    assert.equal(saved.name, 'Test Filter');
    assert.equal(saved.web_url, 'https://is24.de/Suche/de/berlin/berlin/wohnung-mieten');
    assert.equal(saved.mobile_params, '{"pricetype":"calculatedtotalrent"}');
    assert.equal(saved.enabled, 1);
    assert.ok(saved.created_at);
  });

  it('handles missing name (defaults to empty string)', () => {
    db.addFilter({
      id: 'f-no-name',
      web_url: 'https://is24.de/Suche/de/muenchen/muenchen/wohnung-mieten',
      mobile_params: '{}',
    });
    const saved = db.getFilter('f-no-name');
    assert.equal(saved.name, '');
  });

  it('throws on duplicate id', () => {
    db.addFilter({ id: 'dup', web_url: 'https://is24.de/Suche/de/berlin/berlin/wohnung-mieten', mobile_params: '{}' });
    assert.throws(() => {
      db.addFilter({ id: 'dup', web_url: 'https://is24.de/Suche/de/hamburg/hamburg/wohnung-mieten', mobile_params: '{}' });
    });
  });
});

describe('getFilter', () => {
  let db;
  beforeEach(() => { db = seededDB(); });
  after(() => { db?.close(); });

  it('returns a filter by id', () => {
    const f = db.getFilter('f1');
    assert.equal(f.name, 'Berlin Apartments');
  });

  it('returns undefined for unknown id', () => {
    const f = db.getFilter('non-existent');
    assert.equal(f, undefined);
  });
});

describe('getFilters', () => {
  let db;
  beforeEach(() => { db = seededDB(); });
  after(() => { db?.close(); });

  it('returns all filters', () => {
    const filters = db.getFilters();
    assert.equal(filters.length, 1);
    assert.equal(filters[0].name, 'Berlin Apartments');
  });

  it('returns filter with computed counts', () => {
    seedListing(db, { expose_id: '1', price: 500 });
    seedListing(db, { expose_id: '2', price: 600 });
    // Mark one as sent
    const hash = HomelanderDB.hashListing('1', 500);
    db.markSent(hash, 'SENT', 'modal ✓');

    const filters = db.getFilters();
    assert.equal(filters[0].new_count, 1);     // 1 still 'seen'
    assert.equal(filters[0].sent_count, 1);     // 1 'sent'
    assert.equal(filters[0].processed_count, 1); // 1 processed (sent)
  });

  it('returns empty array for empty DB', () => {
    db.removeFilter('f1');
    const filters = db.getFilters();
    assert.deepEqual(filters, []);
  });

  it('returns filters in descending created_at order', () => {
    db.addFilter({ id: 'f2', name: 'Second', web_url: 'https://is24.de/Suche/de/hamburg/hamburg/wohnung-mieten', mobile_params: '{}' });
    db.addFilter({ id: 'f3', name: 'Third', web_url: 'https://is24.de/Suche/de/muenchen/muenchen/wohnung-mieten', mobile_params: '{}' });
    const filters = db.getFilters();
    assert.equal(filters[0].id, 'f3'); // newest first
    assert.equal(filters[1].id, 'f2');
    assert.equal(filters[2].id, 'f1');
  });
});

describe('removeFilter', () => {
  it('archives filter and keeps listings intact', () => {
    const db = seededDB();
    seedListing(db);
    db.removeFilter('f1');

    // Filter still exists but is archived
    const filter = db.getFilter('f1');
    assert.ok(filter);
    assert.equal(filter.archived, 1);
    // Not returned by getFilters (excludes archived)
    assert.equal(db.getFilters().length, 0);
    // Listings keep their filter_id, but pending ones are cleared from queue
    const listings = db.db.prepare('SELECT * FROM listings').all();
    assert.equal(listings.length, 1);
    assert.equal(listings[0].filter_id, 'f1');
    assert.equal(listings[0].status, 'skipped');
    db.close();
  });

  it('does nothing for non-existent filter', () => {
    const db = seededDB();
    // Should not throw
    db.removeFilter('ghost');
    assert.ok(db.getFilter('f1')); // original still there
    db.close();
  });
});

describe('updateFilter', () => {
  let db;
  beforeEach(() => { db = seededDB(); });
  after(() => { db?.close(); });

  it('updates a single field', () => {
    db.updateFilter('f1', { name: 'Updated Berlin' });
    const saved = db.getFilter('f1');
    assert.equal(saved.name, 'Updated Berlin');
  });

  it('updates multiple fields', () => {
    db.updateFilter('f1', { name: 'New Name', enabled: 0 });
    const saved = db.getFilter('f1');
    assert.equal(saved.name, 'New Name');
    assert.equal(saved.enabled, 0);
  });

  it('converts boolean true to 1', () => {
    db.updateFilter('f1', { enabled: true });
    const saved = db.getFilter('f1');
    assert.equal(saved.enabled, 1);
  });

  it('converts boolean false to 0', () => {
    db.updateFilter('f1', { enabled: false });
    const saved = db.getFilter('f1');
    assert.equal(saved.enabled, 0);
  });

  it('does nothing with empty patch', () => {
    db.updateFilter('f1', {});
    const saved = db.getFilter('f1');
    assert.equal(saved.name, 'Berlin Apartments'); // unchanged
  });

  it('updates last_polled_at', () => {
    db.updateFilter('f1', { last_polled_at: '2025-01-15T10:00:00' });
    const saved = db.getFilter('f1');
    assert.equal(saved.last_polled_at, '2025-01-15T10:00:00');
  });

  it('atomically increments total_seen and marks first poll done', () => {
    db.incrementFilterSeen('f1', 3);
    db.incrementFilterSeen('f1', 2);
    const saved = db.getFilter('f1');
    assert.equal(saved.total_seen, 5);
    assert.equal(saved.first_poll_done, 1);
    assert.ok(saved.last_polled_at);
  });
});

// ---------------------------------------------------------------------------
// Listings — insert
// ---------------------------------------------------------------------------

describe('insertListing', () => {
  let db;
  beforeEach(() => { db = seededDB(); });
  after(() => { db?.close(); });

  it('inserts a listing and returns changes=1', () => {
    const result = db.insertListing({
      expose_id: 'ex-001',
      title: 'Schöne Wohnung',
      price: 950,
      size: 65,
      rooms: 3,
      address: 'Kreuzberg',
      image_url: 'https://img.is24.de/abc.jpg',
      filter_id: 'f1',
    });
    assert.equal(result.changes, 1);
    assert.ok(!result.skipped);

    const rows = db.db.prepare('SELECT * FROM listings WHERE expose_id = ?').all('ex-001');
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.title, 'Schöne Wohnung');
    assert.equal(row.price, 950);
    assert.equal(row.size, 65);
    assert.equal(row.rooms, 3);
    assert.equal(row.address, 'Kreuzberg');
    assert.equal(row.image_url, 'https://img.is24.de/abc.jpg');
    assert.equal(row.status, 'seen');
    assert.ok(row.discovered_at);
  });

  it('generates hash from expose_id + price', () => {
    const row = db.db.prepare('SELECT hash FROM listings LIMIT 1').get();
    // Already inserted by seedListing in seededDB
    // But let's check via direct insert
    db.insertListing({
      expose_id: 'hash-test', price: 1234, title: 'H', filter_id: 'f1',
    });
    const row2 = db.db.prepare('SELECT hash FROM listings WHERE expose_id = ?').get('hash-test');
    const expected = HomelanderDB.hashListing('hash-test', 1234);
    assert.equal(row2.hash, expected);
  });

  it('skips duplicates (same expose_id + price) — returns skipped:true', () => {
    const listing = { expose_id: 'dup', price: 1000, title: 'Dup', filter_id: 'f1' };
    const first = db.insertListing(listing);
    assert.equal(first.changes, 1);

    const second = db.insertListing(listing);
    assert.equal(second.changes, 0);
    assert.equal(second.skipped, true);

    const count = db.db.prepare('SELECT COUNT(*) as c FROM listings WHERE expose_id = ?').get('dup');
    assert.equal(count.c, 1);
  });

  it('handles NULL fields gracefully', () => {
    const result = db.insertListing({
      expose_id: 'null-test',
      price: 500,
      title: null,
      size: null,
      rooms: null,
      address: null,
      image_url: null,
      filter_id: 'f1',
    });
    assert.equal(result.changes, 1);

    const row = db.db.prepare('SELECT * FROM listings WHERE expose_id = ?').get('null-test');
    assert.equal(row.title, null);
    assert.equal(row.size, null);
    assert.equal(row.rooms, null);
    assert.equal(row.address, null);
    assert.equal(row.image_url, null);
  });

  it('stores price=0 correctly', () => {
    db.insertListing({
      expose_id: 'free', price: 0, title: 'Free listing', filter_id: 'f1',
    });
    const row = db.db.prepare('SELECT * FROM listings WHERE expose_id = ?').get('free');
    assert.equal(row.price, 0);
    assert.equal(row.status, 'seen');
  });

  it('skips future inserts for expose IDs in manual_skips', () => {
    const mark = db.markAlreadyApplied('skip-future');
    assert.equal(mark.found, false);
    assert.equal(db.isManuallyApplied('skip-future'), true);

    const result = db.insertListing({ expose_id: 'skip-future', price: 1200, title: 'Skip me', filter_id: 'f1' });
    assert.equal(result.changes, 0);
    assert.equal(result.skipped, true);
    const row = db.db.prepare('SELECT * FROM listings WHERE expose_id = ?').get('skip-future');
    assert.equal(row, undefined);
  });
});

describe('insertListings (bulk)', () => {
  let db;
  beforeEach(() => { db = seededDB(); });
  after(() => { db?.close(); });

  it('inserts multiple listings and returns count', () => {
    const listings = [
      { expose_id: 'b1', title: 'B1', price: 100 },
      { expose_id: 'b2', title: 'B2', price: 200 },
      { expose_id: 'b3', title: 'B3', price: 300 },
    ];
    const count = db.insertListings(listings, 'f1');
    assert.equal(count, 3);

    const total = db.db.prepare('SELECT COUNT(*) as c FROM listings').get();
    assert.equal(total.c, 3); // seededDB itself had 0 initially, +3 = 3
  });

  it('skips duplicates in bulk insert', () => {
    const listings = [
      { expose_id: 'bd1', title: 'BD1', price: 100 },
      { expose_id: 'bd1', title: 'BD1 dup', price: 100 }, // same expose_id + price
      { expose_id: 'bd2', title: 'BD2', price: 200 },
    ];
    const count = db.insertListings(listings, 'f1');
    assert.equal(count, 2); // only 2 unique

    const rows = db.db.prepare('SELECT expose_id FROM listings ORDER BY expose_id').all();
    assert.deepEqual(rows.map((r) => r.expose_id), ['bd1', 'bd2']);
  });

  it('returns 0 for empty array', () => {
    const count = db.insertListings([], 'f1');
    assert.equal(count, 0);
  });

  it('associates with filterId argument', () => {
    db.addFilter({ id: 'f2', name: 'Hamburg', web_url: 'https://is24.de/Suche/de/hamburg/hamburg/wohnung-mieten', mobile_params: '{}' });
    const listings = [{ expose_id: 'hf', title: 'HF', price: 150 }];
    db.insertListings(listings, 'f2');
    const rows = db.db.prepare('SELECT * FROM listings WHERE filter_id = ?').all('f2');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].expose_id, 'hf');
  });
});

// ---------------------------------------------------------------------------
// Listings — query
// ---------------------------------------------------------------------------

describe('getSeenListings', () => {
  let db;
  beforeEach(() => {
    db = seededDB();
    seedListing(db, { expose_id: 's1', price: 100 });
    seedListing(db, { expose_id: 's2', price: 200 });
    // Mark s2 as sent
    const hash = HomelanderDB.hashListing('s2', 200);
    db.markSent(hash, 'SENT', 'ok');
  });
  after(() => { db?.close(); });

  it('returns only listings with status=seen', () => {
    const seen = db.getSeenListings();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].expose_id, 's1');
  });

  it('filters by filterId when provided', () => {
    db.addFilter({ id: 'f2', name: 'Hamburg', web_url: 'https://is24.de/Suche/de/hamburg/hamburg/wohnung-mieten', mobile_params: '{}' });
    db.insertListing({ expose_id: 'hf-s', title: 'H', price: 150, filter_id: 'f2' });

    const seen = db.getSeenListings('f2');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].expose_id, 'hf-s');
  });

  it('returns empty array when no unseen listings', () => {
    // Mark the last seen listing as sent too
    const hash = HomelanderDB.hashListing('s1', 100);
    db.markSent(hash, 'SENT', 'ok');
    const seen = db.getSeenListings();
    assert.deepEqual(seen, []);
  });

  it('orders by discovered_at ASC', () => {
    db.insertListing({ expose_id: 'later', title: 'Later', price: 999, filter_id: 'f1' });
    const seen = db.getSeenListings();
    // Should have s1 (older) then 'later' (newer)
    assert.equal(seen.length, 2);
    assert.equal(seen[0].expose_id, 's1');
    assert.equal(seen[1].expose_id, 'later');
  });

  it('returns all fields', () => {
    const seen = db.getSeenListings();
    const row = seen[0];
    const expectedKeys = ['hash', 'expose_id', 'title', 'price', 'size', 'rooms', 'address', 'image_url', 'filter_id', 'status', 'discovered_at', 'sent_at', 'outcome', 'failure_reason', 'detail'];
    for (const key of expectedKeys) {
      assert.ok(key in row, `Missing key: ${key}`);
    }
  });
});

// ---------------------------------------------------------------------------
// markSent
// ---------------------------------------------------------------------------

describe('markSent', () => {
  let db;
  beforeEach(() => { db = seededDB(); });
  after(() => { db?.close(); });

  it('marks listing as sent with SENT outcome', () => {
    const hash = seedListing(db, { expose_id: 'ms1', price: 500 });
    db.markSent(hash, 'SENT', 'modal ✓');

    const row = db.db.prepare('SELECT * FROM listings WHERE hash = ?').get(hash);
    assert.equal(row.status, 'sent');
    assert.equal(row.outcome, 'SENT');
    assert.equal(row.detail, 'modal ✓');
    assert.ok(row.sent_at);
  });

  it('marks listing as failed with FAIL outcome', () => {
    const hash = seedListing(db, { expose_id: 'ms2', price: 600 });
    db.markSent(hash, 'FAIL', 'validation error');

    const row = db.db.prepare('SELECT * FROM listings WHERE hash = ?').get(hash);
    assert.equal(row.status, 'failed');
    assert.equal(row.outcome, 'FAIL');
    assert.equal(row.detail, 'validation error');
  });

  it('records failure_reason', () => {
    const hash = seedListing(db, { expose_id: 'ms3', price: 700 });
    db.markSent(hash, 'CAPTCHA', 'captcha blocked', 'captcha');

    const row = db.db.prepare('SELECT * FROM listings WHERE hash = ?').get(hash);
    assert.equal(row.status, 'failed');
    assert.equal(row.outcome, 'CAPTCHA');
    assert.equal(row.failure_reason, 'captcha');
  });

  it('creates a results row', () => {
    const hash = seedListing(db, { expose_id: 'ms4', price: 800 });
    db.markSent(hash, 'SENT', 'sent ok', '');

    const results = db.db.prepare('SELECT * FROM results WHERE listing_hash = ?').all(hash);
    assert.equal(results.length, 1);
    assert.equal(results[0].outcome, 'SENT');
    assert.equal(results[0].detail, 'sent ok');
  });

  it('handles empty detail and failureReason', () => {
    const hash = seedListing(db, { expose_id: 'ms5', price: 900 });
    db.markSent(hash, 'DEACTIVATED', '', '');

    const row = db.db.prepare('SELECT * FROM listings WHERE hash = ?').get(hash);
    assert.equal(row.status, 'failed');
    assert.equal(row.outcome, 'DEACTIVATED');
    assert.equal(row.detail, '');
    assert.equal(row.failure_reason, '');
  });

  it('defaults failure_reason to empty string when omitted', () => {
    const hash = seedListing(db, { expose_id: 'ms6', price: 1000 });
    db.markSent(hash, 'FAIL', 'some detail');
    const row = db.db.prepare('SELECT * FROM listings WHERE hash = ?').get(hash);
    assert.equal(row.failure_reason, '');
  });
  it('does not rewrite processed history when marking an expose as already applied', () => {
    const db = seededDB();
    const hash = seedListing(db, { expose_id: 'manual-sent', price: 500 });
    db.markSent(hash, 'SENT', 'modal ✓');

    const result = db.markAlreadyApplied('manual-sent');
    assert.equal(result.found, true);
    assert.equal(result.skipped, true);
    assert.equal(result.manualSkipInserted, 1);
    assert.equal(result.pendingRowsProtected, 0);

    const row = db.db.prepare('SELECT status, outcome, detail FROM listings WHERE hash = ?').get(hash);
    assert.equal(row.status, 'sent');
    assert.equal(row.outcome, 'SENT');
    assert.equal(row.detail, 'modal ✓');
    assert.equal(db.isManuallyApplied('manual-sent'), true);
    assert.equal(db.getHistory().some((l) => l.expose_id === 'manual-sent'), true);
  });

  it('marks only pending queue rows as MANUAL for skip without touching processed rows', () => {
    const db = seededDB();
    const hash = seedListing(db, { expose_id: 'manual-seen', price: 500 });

    const result = db.markAlreadyApplied('manual-seen');
    assert.equal(result.found, true);
    assert.equal(result.changed, 2);
    assert.equal(result.manualSkipInserted, 1);
    assert.equal(result.pendingRowsProtected, 1);

    const row = db.db.prepare('SELECT status, outcome, detail FROM listings WHERE hash = ?').get(hash);
    assert.equal(row.status, 'sent');
    assert.equal(row.outcome, 'MANUAL');
    assert.equal(row.detail, 'applied manually');
    assert.deepEqual(db.getSeenListings('f1'), []);
    assert.deepEqual(db.getHistory(), []);
  });

  it('reports new future skips separately from pending queue protection', () => {
    const db = seededDB();
    const first = db.markAlreadyApplied('manual-future-only');
    assert.equal(first.found, false);
    assert.equal(first.manualSkipInserted, 1);
    assert.equal(first.pendingRowsProtected, 0);
    assert.equal(first.changed, 1);

    const second = db.markAlreadyApplied('manual-future-only');
    assert.equal(second.found, false);
    assert.equal(second.manualSkipInserted, 0);
    assert.equal(second.pendingRowsProtected, 0);
    assert.equal(second.changed, 0);
    assert.equal(second.alreadyProtected, true);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// retryListing
// ---------------------------------------------------------------------------

describe('retryListing', () => {
  it('resets a failed listing to seen status', () => {
    const db = seededDB();
    const hash = seedListing(db, { expose_id: 'rl1', price: 500 });
    db.markSent(hash, 'FAIL', 'validation error', 'form invalid');

    const result = db.retryListing('rl1');
    assert.equal(result.hash, hash);
    assert.equal(result.already_seen, undefined);

    const row = db.db.prepare('SELECT * FROM listings WHERE expose_id = ?').get('rl1');
    assert.equal(row.status, 'seen');
    // Outcome/detail/failure_reason/sent_at cleared so the listing
    // disappears from history until the daemon re-processes it.
    assert.equal(row.outcome, null);
    assert.equal(row.detail, null);
    assert.equal(row.failure_reason, null);
    assert.equal(row.sent_at, null);
    db.close();
  });

  it('clears outcome fields on retry (listing disappears from history until re-processed)', () => {
    const db = seededDB();
    const hash = seedListing(db, { expose_id: 'rl2', price: 600 });
    db.markSent(hash, 'SENT', 'all good');

    db.retryListing('rl2');
    const row = db.db.prepare('SELECT * FROM listings WHERE expose_id = ?').get('rl2');
    assert.equal(row.status, 'seen');
    assert.equal(row.outcome, null);

    // No longer appears in history (outcome IS NOT NULL filter excludes it)
    const history = db.getHistory();
    const ids = history.map(r => r.expose_id);
    assert.ok(!ids.includes('rl2'));
    db.close();
  });

  it('returns already_seen for an already-queued listing', () => {
    const db = seededDB();
    const hash = seedListing(db, { expose_id: 'rl3', price: 700 });
    db.markSent(hash, 'FAIL', 'error');

    db.retryListing('rl3');              // first retry
    const result = db.retryListing('rl3'); // second retry — already seen
    assert.equal(result.hash, hash);
    assert.equal(result.already_seen, true);
    db.close();
  });

  it('returns error for unknown expose_id', () => {
    const db = freshDB();
    const result = db.retryListing('nonexistent');
    assert.equal(result.error, 'Listing not found');
    db.close();
  });
});

// ---------------------------------------------------------------------------
// getStats
// ---------------------------------------------------------------------------

describe('getStats', () => {
  it('returns zeros for empty DB', () => {
    const db = freshDB();
    const stats = db.getStats();
    assert.deepEqual(stats, {
      total: 0, sent: 0, failed: 0, deactivated: 0,
      premium: 0, captcha: 0, seen_unapplied: 0, today: 0,
    });
    db.close();
  });

  it('returns correct counts with mixed listings', () => {
    const db = seededDB();
    // Insert 5 listings
    const h1 = seedListing(db, { expose_id: 'st1', price: 100 });
    const h2 = seedListing(db, { expose_id: 'st2', price: 200 });
    const h3 = seedListing(db, { expose_id: 'st3', price: 300 });
    const h4 = seedListing(db, { expose_id: 'st4', price: 400 });
    const h5 = seedListing(db, { expose_id: 'st5', price: 500 });

    db.markSent(h1, 'SENT', 'ok');                     // sent
    db.markSent(h2, 'FAIL', 'error');                   // failed (not deactivated/premium)
    db.markSent(h3, 'DEACTIVATED', 'listing gone');     // deactivated
    db.markSent(h4, 'PREMIUM', 'PREMIUM_ONLY (Suchen+)', 'premium');   // premium
    db.markSent(h5, 'CAPTCHA', 'captcha detected', 'captcha');        // captcha

    const stats = db.getStats();
    assert.equal(stats.total, 5);           // 5 processed (sent or terminal non-seen)
    assert.equal(stats.sent, 1);            // h1
    assert.equal(stats.failed, 2);          // h2 (FAIL), h5 (CAPTCHA)
                                            // h3 deactivated and h4 premium are counted separately
    assert.equal(stats.deactivated, 1);     // h3
    assert.equal(stats.premium, 1);         // h4
    assert.equal(stats.captcha, 1);         // h5
    assert.equal(stats.seen_unapplied, 0);  // all processed
    db.close();
  });

  it('counts seen_unapplied correctly', () => {
    const db = seededDB();
    seedListing(db, { expose_id: 'un1', price: 100 });
    seedListing(db, { expose_id: 'un2', price: 200 });
    const hash = HomelanderDB.hashListing('un1', 100);
    db.markSent(hash, 'SENT', 'ok');

    const stats = db.getStats();
    assert.equal(stats.seen_unapplied, 1); // un2 still seen
    db.close();
  });

  it('counts today correctly for sent listings today', () => {
    const db = seededDB();
    const hash = seedListing(db, { expose_id: 'today1', price: 100 });
    db.markSent(hash, 'SENT', 'ok');

    const stats = db.getStats();
    assert.equal(stats.today, 1);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// getTodayStats
// ---------------------------------------------------------------------------

describe('getTodayStats', () => {
  it('returns zeros for empty DB', () => {
    const db = freshDB();
    const stats = db.getTodayStats();
    assert.deepEqual(stats, {
      total: 0, sent: 0, failed: 0, deactivated: 0,
      premium: 0, captcha: 0, seen_unapplied: 0, today: 0,
    });
    db.close();
  });

  it('counts premium today separately from failed', () => {
    const db = seededDB();
    const premiumHash = seedListing(db, { expose_id: 'tpremium', price: 100 });
    const failHash = seedListing(db, { expose_id: 'tfail', price: 200 });
    db.markSent(premiumHash, 'PREMIUM', 'PREMIUM_ONLY (Suchen+)', 'premium');
    db.markSent(failHash, 'FAIL', 'validation error', 'form error');

    const stats = db.getTodayStats();
    assert.equal(stats.premium, 1);
    assert.equal(stats.failed, 1);
    assert.equal(stats.total, 2);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// getHistory
// ---------------------------------------------------------------------------

describe('getHistory', () => {
  let db;
  beforeEach(() => {
    db = seededDB();
    // Create listings with known outcomes
    const h1 = seedListing(db, { expose_id: 'h1', title: 'Listing 1', price: 100 });
    const h2 = seedListing(db, { expose_id: 'h2', title: 'Listing 2', price: 200 });
    const h3 = seedListing(db, { expose_id: 'h3', title: 'Listing 3', price: 300 });
    db.markSent(h1, 'SENT', 'ok');
    db.markSent(h2, 'FAIL', 'validation error', 'form error');
    db.markSent(h3, 'CAPTCHA', 'captcha block', 'captcha');
  });
  after(() => { db?.close(); });

  it('returns all listings with a known outcome (processed), newest first', () => {
    const history = db.getHistory();
    assert.equal(history.length, 3);
    // Newest first (by sent_at)
    assert.equal(history[0].expose_id, 'h3');
    assert.equal(history[1].expose_id, 'h2');
    assert.equal(history[2].expose_id, 'h1');
  });

  it('respects limit parameter', () => {
    const history = db.getHistory(2);
    assert.equal(history.length, 2);
  });

  it('respects offset parameter', () => {
    const history = db.getHistory(100, 1);
    assert.equal(history.length, 2);
    // Should skip the newest (h3) → return h2, h1
    assert.equal(history[0].expose_id, 'h2');
    assert.equal(history[1].expose_id, 'h1');
  });

  it('filters by filterId', () => {
    db.addFilter({ id: 'f2', name: 'Other', web_url: 'https://is24.de/Suche/de/hamburg/hamburg/wohnung-mieten', mobile_params: '{}' });
    const h4 = seedListing(db, { expose_id: 'h4', title: 'Other listing', price: 400, filter_id: 'f2' });
    db.markSent(h4, 'SENT', 'ok');

    const history = db.getHistory(100, 0, 'f2');
    assert.equal(history.length, 1);
    assert.equal(history[0].expose_id, 'h4');
    assert.equal(history[0].filter_id, 'f2');
  });

  it('filters by outcome', () => {
    const sentHistory = db.getHistory(100, 0, null, 'SENT');
    assert.equal(sentHistory.length, 1);
    assert.equal(sentHistory[0].outcome, 'SENT');

    const failHistory = db.getHistory(100, 0, null, 'FAIL');
    assert.equal(failHistory.length, 1);
    assert.equal(failHistory[0].outcome, 'FAIL');
  });

  it('filters by premium outcome/badge', () => {
    const premiumHash = seedListing(db, { expose_id: 'h-premium', title: 'Premium listing', price: 450 });
    db.markSent(premiumHash, 'PREMIUM', 'PREMIUM_ONLY (Suchen+)', 'premium');

    const history = db.getHistory(100, 0, null, 'PREMIUM');
    assert.equal(history.length, 1);
    assert.equal(history[0].outcome, 'PREMIUM');
    assert.equal(history[0].failure_reason, 'premium');
  });

  it('filters by CAPTCHA outcome (LIKE search)', () => {
    const history = db.getHistory(100, 0, null, 'CAPTCHA');
    assert.equal(history.length, 1);
    assert.equal(history[0].outcome, 'CAPTCHA');
  });

  it('returns empty for empty DB', () => {
    const d = freshDB();
    const history = d.getHistory();
    assert.deepEqual(history, []);
    d.close();
  });
});

// ---------------------------------------------------------------------------
// getRecentActivity
// ---------------------------------------------------------------------------

describe('getRecentActivity', () => {
  let db;
  beforeEach(() => {
    db = seededDB();
    const h1 = seedListing(db, { expose_id: 'ra1', title: 'RA 1', price: 100, address: 'Addr 1' });
    const h2 = seedListing(db, { expose_id: 'ra2', title: 'RA 2', price: 200, address: 'Addr 2' });
    db.markSent(h1, 'SENT', 'ok');
    db.markSent(h2, 'FAIL', 'err', 'premium');
  });
  after(() => { db?.close(); });

  it('returns processed listings with selected fields', () => {
    const activity = db.getRecentActivity(10);
    assert.equal(activity.length, 2);
    const keys = ['hash', 'expose_id', 'title', 'price', 'address', 'outcome', 'failure_reason', 'detail', 'sent_at'];
    for (const key of keys) {
      assert.ok(key in activity[0], `Missing key: ${key}`);
    }
  });

  it('respects limit', () => {
    const activity = db.getRecentActivity(1);
    assert.equal(activity.length, 1);
  });

  it('returns empty for empty DB', () => {
    const d = freshDB();
    const activity = d.getRecentActivity(10);
    assert.deepEqual(activity, []);
    d.close();
  });

  it('excludes listings with no outcome (unprocessed)', () => {
    seedListing(db, { expose_id: 'ra-seen', title: 'Seen', price: 50 });
    const activity = db.getRecentActivity(10);
    const exposes = activity.map((r) => r.expose_id);
    assert.ok(!exposes.includes('ra-seen'));
  });

  it('newest first ordering', () => {
    const activity = db.getRecentActivity(10);
    assert.equal(activity[0].expose_id, 'ra2'); // newest
    assert.equal(activity[1].expose_id, 'ra1');
  });
});

// ---------------------------------------------------------------------------
// getCaptchaConsecutive
// ---------------------------------------------------------------------------

describe('getCaptchaConsecutive', () => {
  it('returns 0 for empty DB', () => {
    const db = freshDB();
    assert.equal(db.getCaptchaConsecutive(), 0);
    db.close();
  });

  it('counts consecutive CAPTCHA failures', () => {
    const db = seededDB();
    const h1 = seedListing(db, { expose_id: 'cc1', price: 100 });
    const h2 = seedListing(db, { expose_id: 'cc2', price: 200 });
    const h3 = seedListing(db, { expose_id: 'cc3', price: 300 });
    db.markSent(h1, 'FAIL', '', 'captcha');
    db.markSent(h2, 'FAIL', '', 'captcha');
    db.markSent(h3, 'FAIL', '', 'captcha');
    assert.equal(db.getCaptchaConsecutive(), 3);
    db.close();
  });

  it('breaks on non-captcha failure', () => {
    const db = seededDB();
    const h1 = seedListing(db, { expose_id: 'ccb1', price: 100 });
    const h2 = seedListing(db, { expose_id: 'ccb2', price: 200 });
    const h3 = seedListing(db, { expose_id: 'ccb3', price: 300 });
    db.markSent(h1, 'FAIL', '', 'captcha');   // newest
    db.markSent(h2, 'SENT', 'ok');            // breaks chain
    db.markSent(h3, 'FAIL', '', 'captcha');   // older — not counted
    assert.equal(db.getCaptchaConsecutive(), 1);
    db.close();
  });

  it('does NOT count FAIL outcome without captcha reason', () => {
    const db = seededDB();
    const h1 = seedListing(db, { expose_id: 'ccf1', price: 100 });
    db.markSent(h1, 'FAIL', '', '');
    // failure_reason is '' and outcome is 'FAIL' → NOT a captcha → 0
    assert.equal(db.getCaptchaConsecutive(), 0);
    db.close();
  });

  it('returns 0 when only SENT listings exist', () => {
    const db = seededDB();
    const h1 = seedListing(db, { expose_id: 'good1', price: 100 });
    db.markSent(h1, 'SENT', 'ok');
    assert.equal(db.getCaptchaConsecutive(), 0);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

describe('close', () => {
  it('closes the database', () => {
    const db = freshDB();
    db.close();
    // After close, operations should throw
    assert.throws(() => {
      db.db.prepare('SELECT 1').get();
    });
  });
});
