'use strict';

const { all, get, run, scalar } = require('./db');

const MAX_MESSAGE_LEN = 2000;

function nowIso() {
  return new Date().toISOString();
}

/* ---------------------------------- users --------------------------------- */

function createUser(id, passwordHash) {
  run(
    `INSERT INTO users (id, password_hash, display_name, created_at)
     VALUES (?, ?, ?, ?)`,
    id,
    passwordHash,
    id,
    nowIso()
  );
  return findUserById(id);
}

function findUserById(id) {
  if (!id) return null;
  return get(
    `SELECT id, display_name, created_at FROM users WHERE id = ?`,
    String(id)
  );
}

/** Case-insensitive lookup, used for login. */
function findUserByLoginId(id) {
  if (!id) return null;
  return get(
    `SELECT id, display_name, created_at, password_hash FROM users WHERE lower(id) = lower(?)`,
    String(id)
  );
}

function searchUsers(query, excludeId, limit = 50) {
  const q = String(query || '').trim();
  if (!q) {
    return all(
      `SELECT id, display_name FROM users WHERE id <> ? ORDER BY id LIMIT ?`,
      excludeId,
      limit
    );
  }
  const like = `%${q.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
  return all(
    `SELECT id, display_name FROM users
     WHERE id <> ? AND (id LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')
     ORDER BY id LIMIT ?`,
    excludeId,
    like,
    like,
    limit
  );
}

/* --------------------------------- sessions -------------------------------- */

function createSession(userId) {
  const crypto = require('node:crypto');
  const token = crypto.randomBytes(32).toString('hex');
  run(
    `INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)`,
    token,
    userId,
    nowIso()
  );
  return token;
}

function getUserByToken(token) {
  if (!token) return null;
  return get(
    `SELECT u.id, u.display_name, u.created_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ?`,
    String(token)
  );
}

function deleteSession(token) {
  if (!token) return 0;
  return run(`DELETE FROM sessions WHERE token = ?`, String(token)).changes;
}

/* --------------------------------- messages -------------------------------- */

/**
 * Insert a message. Returns a plain object safe to send over the wire.
 */
function insertMessage(senderId, recipientId, body) {
  const text = String(body).slice(0, MAX_MESSAGE_LEN);
  const createdAt = nowIso();
  const { lastInsertRowid } = run(
    `INSERT INTO messages (sender_id, recipient_id, body, created_at, read_at)
     VALUES (?, ?, ?, ?, NULL)`,
    senderId,
    recipientId,
    text,
    createdAt
  );
  return {
    id: lastInsertRowid,
    from: senderId,
    to: recipientId,
    text,
    createdAt,
    readAt: null,
  };
}

/** All messages between two users, oldest first. */
function conversation(userA, userB) {
  return all(
    `SELECT id, sender_id AS "from", recipient_id AS "to", body AS text,
            created_at AS createdAt, read_at AS readAt
     FROM messages
     WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
     ORDER BY id ASC`,
    userA,
    userB,
    userB,
    userA
  );
}

/** Mark messages sent by `other` to `reader` as read. Returns rows changed. */
function markRead(reader, other, readAt = nowIso()) {
  return run(
    `UPDATE messages SET read_at = ? WHERE recipient_id = ? AND sender_id = ? AND read_at IS NULL`,
    readAt,
    reader,
    other
  ).changes;
}

function unreadCount(me, other) {
  return Number(
    scalar(
      `SELECT COUNT(*) FROM messages WHERE recipient_id = ? AND sender_id = ? AND read_at IS NULL`,
      me,
      other
    )
  );
}

/** Distinct peers the user has exchanged messages with. */
function peerIds(me) {
  return all(
    `SELECT DISTINCT peer FROM (
       SELECT recipient_id AS peer FROM messages WHERE sender_id = ?
       UNION
       SELECT sender_id AS peer FROM messages WHERE recipient_id = ?
     )`,
    me,
    me
  ).map((r) => r.peer);
}

/** Conversation list for the sidebar: peer, last message, unread count. */
function conversationSummaries(me) {
  return peerIds(me)
    .map((peer) => {
      const lastMessage = get(
        `SELECT id, sender_id AS "from", recipient_id AS "to", body AS text,
                created_at AS createdAt, read_at AS readAt
         FROM messages
         WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
         ORDER BY id DESC LIMIT 1`,
        me,
        peer,
        peer,
        me
      );
      return { peerId: peer, lastMessage, unread: unreadCount(me, peer) };
    })
    .filter((c) => c.lastMessage)
    .sort((a, b) => b.lastMessage.id - a.lastMessage.id);
}

module.exports = {
  MAX_MESSAGE_LEN,
  createUser,
  findUserById,
  findUserByLoginId,
  searchUsers,
  createSession,
  getUserByToken,
  deleteSession,
  insertMessage,
  conversation,
  markRead,
  unreadCount,
  peerIds,
  conversationSummaries,
};
