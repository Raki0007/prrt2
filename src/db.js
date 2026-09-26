'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'chat.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );

  -- Unique index on lower(id) so "Alice" and "alice" cannot both exist.
  CREATE UNIQUE INDEX IF NOT EXISTS users_id_lower ON users (lower(id));

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id    TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    body         TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    read_at      TEXT
  );

  CREATE INDEX IF NOT EXISTS messages_from_to ON messages (sender_id, recipient_id, id);
  CREATE INDEX IF NOT EXISTS messages_to_from ON messages (recipient_id, sender_id, id);
`);

/** Run a scalar query and return the first column of the first row (or null). */
function scalar(sql, ...params) {
  const row = db.prepare(sql).get(...params);
  return row ? Object.values(row)[0] : null;
}

/** Run a query and return all rows as plain objects. */
function all(sql, ...params) {
  return db.prepare(sql).all(...params);
}

/** Run a query and return the first row as a plain object (or null). */
function get(sql, ...params) {
  return db.prepare(sql).get(...params) || null;
}

/** Run an INSERT/UPDATE/DELETE. Returns { changes, lastInsertRowid }. */
function run(sql, ...params) {
  const res = db.prepare(sql).run(...params);
  return { changes: Number(res.changes), lastInsertRowid: Number(res.lastInsertRowid) };
}

module.exports = { db, DB_PATH, DATA_DIR, scalar, all, get, run };
