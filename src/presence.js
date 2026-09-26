'use strict';

/**
 * In-memory presence tracking for a single server process.
 * Maps userId -> Set of connected socket ids (a user may have several tabs).
 */
const online = new Map();

function add(userId, socketId) {
  if (!online.has(userId)) online.set(userId, new Set());
  online.get(userId).add(socketId);
}

function remove(userId, socketId) {
  const set = online.get(userId);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) online.delete(userId);
}

function isOnline(userId) {
  return online.has(userId);
}

function onlineUserIds() {
  return [...online.keys()];
}

/** Socket ids to address when emitting to a user (empty if offline). */
function socketsOf(userId) {
  const set = online.get(userId);
  return set ? [...set] : [];
}

module.exports = { add, remove, isOnline, onlineUserIds, socketsOf };
