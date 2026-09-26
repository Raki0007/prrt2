'use strict';

const express = require('express');
const auth = require('./auth');
const store = require('./store');
const presence = require('./presence');

const router = express.Router();

/** Bearer-token auth middleware. Attaches req.user. */
function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const user = store.getUserByToken(token);
  if (!user) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  req.user = user;
  req.token = token;
  next();
}

function publicUser(u) {
  return { id: u.id, displayName: u.display_name, online: presence.isOnline(u.id) };
}

router.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()) });
});

router.post('/register', (req, res) => {
  const result = auth.register(req.body || {});
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.status(201).json({ user: publicUser(result.user), token: result.token });
});

router.post('/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || '';
  const result = auth.login(req.body || {}, ip);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ user: publicUser(result.user), token: result.token });
});

router.post('/logout', requireAuth, (req, res) => {
  store.deleteSession(req.token);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

/** Find other users by ID substring. `?q=` is optional. */
router.get('/users', requireAuth, (req, res) => {
  const users = store.searchUsers(req.query.q, req.user.id, 50).map(publicUser);
  res.json({ users });
});

router.get('/conversations', requireAuth, (req, res) => {
  const conversations = store.conversationSummaries(req.user.id).map((c) => ({
    peerId: c.peerId,
    peerOnline: presence.isOnline(c.peerId),
    lastMessage: c.lastMessage,
    unread: c.unread,
  }));
  res.json({ conversations });
});

router.get('/conversations/:peerId/messages', requireAuth, (req, res) => {
  const peer = store.findUserById(req.params.peerId);
  if (!peer) return res.status(404).json({ error: 'No such user.' });
  const messages = store.conversation(req.user.id, peer.id);
  res.json({ peerId: peer.id, messages });
});

module.exports = router;
