'use strict';

const bcrypt = require('bcryptjs');
const store = require('./store');

const USER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,23}$/; // 3-24 chars, starts alphanumeric
const BCRYPT_ROUNDS = 10;

/* --------------------------- login rate limiting --------------------------- */

const loginAttempts = new Map(); // key: ip|userId -> { fails, lockedUntil }
const MAX_FAILS = 8;
const LOCK_MS = 60_000;

function attemptKey(ip, userId) {
  return `${ip}|${String(userId).toLowerCase()}`;
}

function isLockedOut(key) {
  const rec = loginAttempts.get(key);
  if (!rec) return false;
  if (rec.lockedUntil && rec.lockedUntil > Date.now()) return true;
  if (rec.lockedUntil && rec.lockedUntil <= Date.now()) loginAttempts.delete(key);
  return false;
}

function recordFailure(key) {
  const rec = loginAttempts.get(key) || { fails: 0, lockedUntil: 0 };
  rec.fails += 1;
  if (rec.fails >= MAX_FAILS) {
    rec.lockedUntil = Date.now() + LOCK_MS;
    rec.fails = 0;
  }
  loginAttempts.set(key, rec);
}

function clearFailures(key) {
  loginAttempts.delete(key);
}

/* ------------------------------- validation -------------------------------- */

function validateUserId(id) {
  if (typeof id !== 'string' || !USER_ID_RE.test(id)) {
    return 'User ID must be 3-24 characters: letters, numbers, underscore, dot or dash, starting with a letter or number.';
  }
  return null;
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 6) {
    return 'Password must be at least 6 characters.';
  }
  if (password.length > 72) {
    return 'Password must be at most 72 characters.';
  }
  return null;
}

/* -------------------------------- register --------------------------------- */

function register({ userId, password }) {
  const idErr = validateUserId(userId);
  if (idErr) return { ok: false, status: 400, error: idErr };
  const pwErr = validatePassword(password);
  if (pwErr) return { ok: false, status: 400, error: pwErr };

  const existing = store.findUserByLoginId(userId);
  if (existing) {
    return { ok: false, status: 409, error: 'That user ID is already taken. Pick another one.' };
  }

  const passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  const user = store.createUser(userId, passwordHash);
  const token = store.createSession(user.id);
  return { ok: true, user, token };
}

/* ---------------------------------- login ---------------------------------- */

function login({ userId, password }, ip = '') {
  if (typeof userId !== 'string' || typeof password !== 'string' || !userId || !password) {
    return { ok: false, status: 400, error: 'User ID and password are required.' };
  }
  const key = attemptKey(ip, userId);
  if (isLockedOut(key)) {
    return { ok: false, status: 429, error: 'Too many failed attempts. Try again in a minute.' };
  }

  const row = store.findUserByLoginId(userId);
  const ok = row && bcrypt.compareSync(password, row.password_hash);
  if (!ok) {
    recordFailure(key);
    return { ok: false, status: 401, error: 'Invalid user ID or password.' };
  }
  clearFailures(key);

  const token = store.createSession(row.id);
  return { ok: true, user: { id: row.id, display_name: row.display_name, created_at: row.created_at }, token };
}

module.exports = { register, login, validateUserId, validatePassword };
