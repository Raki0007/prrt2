'use strict';

/**
 * End-to-end test for the prrt2 chat server.
 * Spins up a throwaway server instance and drives it with real HTTP + Socket.IO clients.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
let failures = 0;

function check(name, cond, extra = '') {
  const ok = !!cond;
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra && !ok ? ` — ${extra}` : ''}`);
  if (!ok) failures += 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  throw new Error('server did not start in time');
}

function api(path, { token, body, method = 'GET' } = {}) {
  const canHaveBody = method !== 'GET' && method !== 'HEAD';
  return fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      ...(canHaveBody && body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: canHaveBody && body ? JSON.stringify(body) : undefined,
  }).then(async (res) => ({ status: res.status, data: await res.json().catch(() => null) }));
}

function connect(token, label = 'socket') {
  return new Promise((resolve, reject) => {
    const socket = io(BASE, { auth: { token }, reconnection: false, timeout: 5000 });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => reject(new Error(`connect(${label}): ${err.message}`)));
  });
}

/** Resolve on the next occurrence of `event`, or null on timeout. */
function nextEvent(socket, event, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(t); socket.off(event, handler); resolve(v); } };
    const handler = (payload) => finish(payload);
    const t = setTimeout(() => finish(null), timeoutMs);
    socket.on(event, handler);
  });
}

function emitWithAck(socket, event, payload, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, error: 'timeout' }); } }, timeoutMs);
    socket.emit(event, payload, (res) => {
      if (!done) { done = true; clearTimeout(t); resolve(res); }
    });
  });
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prrt2-test-'));
  const child = spawn(process.execPath, ['--no-warnings', 'server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  try {
    await waitForServer();

    /* ------------------------------ registration ------------------------------ */

    let res = await api('/register', { method: 'POST', body: { userId: 'alice', password: 'secret123' } });
    check('register alice -> 201', res.status === 201, JSON.stringify(res.data));
    const aliceToken = res.data && res.data.token;

    res = await api('/register', { method: 'POST', body: { userId: 'ALICE', password: 'secret123' } });
    check('duplicate ID (case-insensitive) rejected -> 409', res.status === 409, JSON.stringify(res.data));

    res = await api('/register', { method: 'POST', body: { userId: 'ab', password: 'secret123' } });
    check('too-short ID rejected -> 400', res.status === 400, JSON.stringify(res.data));

    res = await api('/register', { method: 'POST', body: { userId: 'bad id!', password: 'secret123' } });
    check('illegal ID characters rejected -> 400', res.status === 400, JSON.stringify(res.data));

    res = await api('/register', { method: 'POST', body: { userId: 'shortpw', password: '123' } });
    check('weak password rejected -> 400', res.status === 400, JSON.stringify(res.data));

    res = await api('/register', { method: 'POST', body: { userId: 'bob', password: 'hunter2!' } });
    check('register bob -> 201', res.status === 201, JSON.stringify(res.data));
    const bobToken = res.data && res.data.token;

    /* --------------------------------- login ---------------------------------- */

    res = await api('/login', { method: 'POST', body: { userId: 'alice', password: 'wrong' } });
    check('wrong password -> 401', res.status === 401, JSON.stringify(res.data));

    res = await api('/login', { method: 'POST', body: { userId: 'Alice', password: 'secret123' } });
    check('login is case-insensitive on ID -> 200', res.status === 200, JSON.stringify(res.data));

    res = await api('/me', { token: bobToken });
    check('GET /me with token', res.status === 200 && res.data.user.id === 'bob', JSON.stringify(res.data));

    res = await api('/me', { token: 'not-a-real-token' });
    check('GET /me with bad token -> 401', res.status === 401, JSON.stringify(res.data));

    /* ------------------------------- discovery -------------------------------- */

    res = await api('/users', { token: aliceToken });
    const ids = (res.data.users || []).map((u) => u.id);
    check('user discovery lists others, excludes self', res.status === 200 && ids.includes('bob') && !ids.includes('alice'), JSON.stringify(ids));

    res = await api('/users?q=bo', { token: aliceToken });
    check('user search by ID substring', res.status === 200 && res.data.users.length === 1 && res.data.users[0].id === 'bob', JSON.stringify(res.data));

    /* ---------------------------- realtime session ---------------------------- */

    const alice = await connect(aliceToken, 'alice');
    const bob = await connect(bobToken, 'bob');
    check('both sockets connected', alice.connected && bob.connected);

    // Log every presence event from the start so none are missed to timing races.
    const presenceLog = [];
    alice.on('presence', (p) => presenceLog.push(p));

    bob.disconnect();
    await sleep(400);
    const bob2 = await connect(bobToken, 'bob2');
    await sleep(400);

    check(
      'presence: peer goes offline',
      presenceLog.some((p) => p.userId === 'bob' && p.online === false),
      JSON.stringify(presenceLog)
    );
    check(
      'presence: peer comes back online',
      presenceLog.some((p) => p.userId === 'bob' && p.online === true),
      JSON.stringify(presenceLog)
    );

    /* -------------------------------- messaging ------------------------------- */

    const bobIncoming = nextEvent(bob2, 'message:new');
    const sendRes = await emitWithAck(alice, 'message:send', { toUserId: 'bob', text: 'Hey Bob, realtime?' });
    check('message:send acked', sendRes.ok === true, JSON.stringify(sendRes));
    const delivered = await bobIncoming;
    check('message delivered in realtime to bob', delivered && delivered.message.text === 'Hey Bob, realtime?' && delivered.message.from === 'alice', JSON.stringify(delivered));

    const aliceTyping = nextEvent(alice, 'typing');
    bob2.emit('typing', { toUserId: 'alice', isTyping: true });
    const typingEvt = await aliceTyping;
    check('typing indicator propagates', typingEvt && typingEvt.userId === 'bob' && typingEvt.isTyping === true, JSON.stringify(typingEvt));

    const aliceRead = nextEvent(alice, 'message:read');
    const openRes = await emitWithAck(bob2, 'conversation:open', { userId: 'alice' });
    check('conversation:open returns history', openRes.ok === true && Array.isArray(openRes.messages) && openRes.messages.length === 1, JSON.stringify(openRes));
    const readEvt = await aliceRead;
    check('read receipt reaches sender', readEvt && readEvt.userId === 'bob', JSON.stringify(readEvt));

    const aliceIncoming = nextEvent(alice, 'message:new');
    const send2 = await emitWithAck(bob2, 'message:send', { toUserId: 'alice', text: 'Yes! Instant.' });
    check('bob reply acked', send2.ok === true, JSON.stringify(send2));
    const delivered2 = await aliceIncoming;
    check('reply delivered in realtime to alice', delivered2 && delivered2.message.text === 'Yes! Instant.', JSON.stringify(delivered2));

    /* ----------------------------- offline delivery --------------------------- */

    const send3 = await emitWithAck(alice, 'message:send', { toUserId: 'bob', text: 'stored while away' });
    check('message to offline-capable flow still acked', send3.ok === true, JSON.stringify(send3));

    /* ------------------------------- edge cases ------------------------------- */

    res = await api('/conversations/bob/messages', { token: aliceToken });
    check('history via REST has all messages', res.status === 200 && res.data.messages.length === 3, JSON.stringify(res.data));
    const fromBob = res.data.messages.filter((m) => m.from === 'bob');
    check(
      'bob\'s message to alice is unread before alice opens the chat',
      fromBob.length === 1 && !fromBob[0].readAt,
      JSON.stringify(res.data.messages)
    );

    await emitWithAck(alice, 'conversation:open', { userId: 'bob' });
    res = await api('/conversations/bob/messages', { token: aliceToken });
    const fromBobAfter = res.data.messages.filter((m) => m.from === 'bob');
    const fromAliceAfter = res.data.messages.filter((m) => m.from === 'alice');
    check(
      'bob\'s messages to alice are marked read once alice opens the chat',
      fromBobAfter.length === 1 && fromBobAfter.every((m) => m.readAt),
      JSON.stringify(res.data.messages)
    );
    check(
      'alice\'s newest message stays unread for bob (bob has not reopened)',
      fromAliceAfter.some((m) => !m.readAt),
      JSON.stringify(res.data.messages)
    );

    const badSend = await emitWithAck(alice, 'message:send', { toUserId: 'ghost_user', text: 'hello?' });
    check('message to unknown user rejected', badSend.ok === false, JSON.stringify(badSend));

    const selfSend = await emitWithAck(alice, 'message:send', { toUserId: 'alice', text: 'note to self' });
    check('message to self rejected', selfSend.ok === false, JSON.stringify(selfSend));

    res = await api('/conversations', { token: bobToken });
    const bobConv = (res.data.conversations || []).find((c) => c.peerId === 'alice');
    check('conversation summary shows unread for bob', bobConv && bobConv.unread === 1, JSON.stringify(res.data));

    /* --------------------------- unauthenticated socket ----------------------- */

    let unauthRejected = false;
    try {
      await new Promise((resolve, reject) => {
        const s = io(BASE, { auth: { token: 'bogus' }, reconnection: false, timeout: 4000 });
        s.on('connect', () => { s.disconnect(); reject(new Error('connected with bad token')); });
        s.on('connect_error', (e) => { s.disconnect(); resolve(e); });
      });
      unauthRejected = true;
    } catch {
      unauthRejected = false;
    }
    check('socket with bad token is rejected', unauthRejected);

    /* --------------------------------- logout --------------------------------- */

    res = await api('/logout', { token: aliceToken, method: 'POST' });
    check('logout ok', res.status === 200, JSON.stringify(res.data));
    res = await api('/me', { token: aliceToken });
    check('token invalid after logout -> 401', res.status === 401, JSON.stringify(res.data));

    alice.disconnect();
    bob2.disconnect();

    /* ------------------------- persistence across restart --------------------- */

    const dbFile = path.join(dataDir, 'chat.db');
    check('database file persisted on disk', fs.existsSync(dbFile));

    // Restart the server against the same data dir and verify history survives.
    const child2 = spawn(process.execPath, ['--no-warnings', 'server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child2.stderr.on('data', (d) => process.stderr.write(`[server2] ${d}`));
    try {
      await waitForServer();
      res = await api('/login', { method: 'POST', body: { userId: 'bob', password: 'hunter2!' } });
      check('login works after restart', res.status === 200, JSON.stringify(res.data));
      res = await api('/conversations/alice/messages', { token: res.data.token });
      check('message history survives restart', res.status === 200 && res.data.messages.length === 3, JSON.stringify(res.data));
    } finally {
      child2.kill();
    }
  } finally {
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log('\n================ TEST RESULTS ================');
  results.forEach((r) => console.log(r));
  console.log('==============================================');
  console.log(`${results.length - failures}/${results.length} checks passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('test harness error:', err);
  process.exit(1);
});
