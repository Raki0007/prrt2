# prrt2 — realtime chat

A working realtime chat app. Users register with a **unique ID + password**, **find each other**
by searching user IDs, and **chat in realtime** with live delivery, typing indicators, online
presence, unread badges and read receipts.

## Stack

- **Node.js + Express** — REST API + static hosting
- **Socket.IO** — realtime messaging, presence, typing, read receipts
- **`node:sqlite`** — built-in SQLite (zero native dependencies), WAL mode
- **bcryptjs** — password hashing (10 rounds)
- **Vanilla JS frontend** — single-page app, no build step

## Run it

```bash
npm install
npm start          # http://localhost:3000
```

Open the app in **two browser tabs**, register two different accounts (e.g. `alice` and `bob`),
search for the other user in the sidebar, and start chatting. Messages are delivered instantly
while both users are online and stored for delivery otherwise.

Configuration via environment variables:

| Variable   | Default      | Description                     |
| ---------- | ------------ | ------------------------------- |
| `PORT`     | `3000`       | HTTP/WebSocket port             |
| `HOST`     | `0.0.0.0`    | Bind address                    |
| `DATA_DIR` | `./data`     | Where `chat.db` is stored       |

## Features

**Accounts & auth**
- Register with a unique ID (3–24 chars: letters, numbers, `_`, `.`, `-`; case-insensitively unique)
- Passwords hashed with bcrypt, minimum 6 characters
- Token sessions (stored server-side), restored on reload via `localStorage`
- Login rate limiting after repeated failures

**Finding people**
- Live user search by ID substring
- Online/offline presence dots, online users sorted first

**Realtime chat**
- 1:1 direct messages, persisted to SQLite
- Instant delivery to all of a user's open tabs/devices
- Typing indicators while the other person composes
- Read receipts ("seen") when the peer opens the conversation
- Unread counters on conversations and the Chats tab
- Messages sent while someone is offline are waiting when they return

## API

| Method | Endpoint                          | Description                        |
| ------ | --------------------------------- | ---------------------------------- |
| GET    | `/api/health`                     | Health check                       |
| POST   | `/api/register`                   | `{ userId, password }` → `{ user, token }` |
| POST   | `/api/login`                      | `{ userId, password }` → `{ user, token }` |
| POST   | `/api/logout`                     | Invalidate session (Bearer)        |
| GET    | `/api/me`                         | Current user (Bearer)              |
| GET    | `/api/users?q=`                   | Search users (Bearer)              |
| GET    | `/api/conversations`              | Conversation list + unread (Bearer)|
| GET    | `/api/conversations/:peerId/messages` | Message history (Bearer)      |

Socket events are documented at the top of [`src/socket.js`](src/socket.js).

## Tests

```bash
npm test
```

Runs an end-to-end suite that boots a throwaway server instance and drives it with real HTTP
and Socket.IO clients: registration validation, duplicate/weak-credential rejection, login,
user discovery, realtime delivery between two clients, typing, read receipts, unread counts,
unauthorized socket rejection, logout invalidation, and persistence across a server restart.

## Project layout

```
server.js          # entry point: express + socket.io
src/
  db.js            # SQLite connection + schema
  store.js         # users, sessions, messages queries
  auth.js          # validation, register/login, rate limiting
  presence.js      # in-memory online tracking
  routes.js        # REST API
  socket.js        # realtime events
public/
  index.html       # app markup
  style.css        # styles
  app.js           # frontend logic
test/
  e2e.mjs          # end-to-end tests
```
