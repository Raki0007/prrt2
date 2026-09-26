'use strict';

const { Server } = require('socket.io');
const store = require('./store');
const presence = require('./presence');

/**
 * Attach the realtime layer to an existing HTTP server.
 *
 * Client -> server events:
 *   message:send       { toUserId, text }                -> ack { ok, message | error }
 *   conversation:open  { userId }                        -> ack { ok, messages | error }
 *   typing             { toUserId, isTyping }
 *
 * Server -> client events:
 *   message:new        { message }                       (to recipient's sockets)
 *   message:ack        { message }                       (echo to sender's other tabs)
 *   conversation:new   { peerId, message, unread }       (sidebar refresh)
 *   message:read       { userId, readAt }                (read receipt to sender)
 *   typing             { userId, isTyping }
 *   presence           { userId, online }
 *   presence:init      { online: [userId] }              (sent once on connect)
 */
function attachSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: true, credentials: true },
  });

  // Authenticate every socket with the session token.
  io.use((socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    const user = store.getUserByToken(token);
    if (!user) return next(new Error('unauthorized'));
    socket.data.user = user;
    next();
  });

  io.on('connection', (socket) => {
    const me = socket.data.user.id;

    presence.add(me, socket.id);
    socket.emit('presence:init', { online: presence.onlineUserIds().filter((id) => id !== me) });
    socket.broadcast.emit('presence', { userId: me, online: true });

    /* ------------------------------ messaging ----------------------------- */

    socket.on('message:send', (payload, ack) => {
      const done = typeof ack === 'function' ? ack : () => {};
      const toUserId = String((payload && payload.toUserId) || '').trim();
      const text = String((payload && payload.text) || '').trim();

      if (!toUserId || !text) return done({ ok: false, error: 'Recipient and message text are required.' });
      if (text.length > store.MAX_MESSAGE_LEN) {
        return done({ ok: false, error: `Message too long (max ${store.MAX_MESSAGE_LEN} characters).` });
      }
      const recipient = store.findUserById(toUserId);
      if (!recipient) return done({ ok: false, error: 'No such user.' });
      if (recipient.id === me) return done({ ok: false, error: 'You cannot message yourself.' });

      const message = store.insertMessage(me, recipient.id, text);

      // Deliver to every device of the recipient.
      const recipientSockets = presence.socketsOf(recipient.id);
      if (recipientSockets.length > 0) {
        io.to(recipientSockets).emit('message:new', { message });
      }

      // Update sidebars on both sides.
      socket.emit('conversation:new', { peerId: recipient.id, message, unread: 0 });
      if (recipientSockets.length > 0) {
        io.to(recipientSockets).emit('conversation:new', {
          peerId: me,
          message,
          unread: store.unreadCount(recipient.id, me),
        });
      }

      done({ ok: true, message });
    });

    /* --------------------------- open conversation ------------------------ */

    socket.on('conversation:open', (payload, ack) => {
      const done = typeof ack === 'function' ? ack : () => {};
      const other = String((payload && payload.userId) || '').trim();
      const peer = store.findUserById(other);
      if (!peer) return done({ ok: false, error: 'No such user.' });

      const messages = store.conversation(me, peer.id);
      const changed = store.markRead(me, peer.id);
      if (changed > 0) {
        const peerSockets = presence.socketsOf(peer.id);
        if (peerSockets.length > 0) {
          io.to(peerSockets).emit('message:read', {
            userId: me,
            readAt: new Date().toISOString(),
          });
        }
      }
      done({ ok: true, messages });
    });

    /* ----------------------------- typing echo ---------------------------- */

    socket.on('typing', (payload) => {
      const toUserId = String((payload && payload.toUserId) || '').trim();
      if (!toUserId || toUserId === me) return;
      const peerSockets = presence.socketsOf(toUserId);
      if (peerSockets.length > 0) {
        io.to(peerSockets).emit('typing', {
          userId: me,
          isTyping: !!(payload && payload.isTyping),
        });
      }
    });

    /* ------------------------------- presence ----------------------------- */

    socket.on('disconnect', () => {
      presence.remove(me, socket.id);
      if (!presence.isOnline(me)) {
        io.emit('presence', { userId: me, online: false });
      }
    });
  });

  return io;
}

module.exports = { attachSocket };
