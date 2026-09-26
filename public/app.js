'use strict';

/* ============================== prrt2 chat client ============================== */

const TOKEN_KEY = 'prrt2_token';

const state = {
  token: localStorage.getItem(TOKEN_KEY) || null,
  me: null,                 // { id, displayName, online }
  socket: null,
  users: new Map(),         // userId -> { id, displayName, online }
  conversations: new Map(), // peerId -> { peerId, lastMessage, unread }
  activePeer: null,
  searchQuery: '',
  navTab: 'people',         // 'people' | 'chats'
  typingTimer: null,
  lastTypingSent: 0,
};

const $ = (id) => document.getElementById(id);
const els = {
  authScreen: $('auth-screen'),
  chatScreen: $('chat-screen'),
  tabLogin: $('tab-login'),
  tabRegister: $('tab-register'),
  loginForm: $('login-form'),
  registerForm: $('register-form'),
  loginId: $('login-id'),
  loginPassword: $('login-password'),
  registerId: $('register-id'),
  registerPassword: $('register-password'),
  registerConfirm: $('register-confirm'),
  authError: $('auth-error'),
  meAvatar: $('me-avatar'),
  meId: $('me-id'),
  logoutBtn: $('logout-btn'),
  searchInput: $('search-input'),
  navPeople: $('nav-people'),
  navChats: $('nav-chats'),
  chatBadge: $('chat-badge'),
  peopleList: $('people-list'),
  conversationsList: $('conversations-list'),
  emptyState: $('empty-state'),
  conversationView: $('conversation-view'),
  peerAvatar: $('peer-avatar'),
  peerId: $('peer-id'),
  peerStatus: $('peer-status'),
  messages: $('messages'),
  typingIndicator: $('typing-indicator'),
  messageForm: $('message-form'),
  messageInput: $('message-input'),
  sendBtn: $('send-btn'),
  toast: $('toast'),
};

/* ------------------------------- utilities --------------------------------- */

function toast(message, ms = 2600) {
  els.toast.textContent = message;
  els.toast.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.add('hidden'), ms);
}

async function api(path, { body, method = 'GET' } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const AVATAR_COLORS = ['#5b8cff', '#3ecf8e', '#f2a94b', '#ff6b9d', '#9d7bff', '#38bdf8', '#fb7185', '#facc15'];
function avatarColor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function setAvatar(el, id) {
  el.textContent = (id || '?').slice(0, 2);
  el.style.background = avatarColor(id || '?');
}

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function formatRelative(iso) {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return formatTime(iso);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function formatDay(iso) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

/* ------------------------------- auth screen -------------------------------- */

function showAuthError(msg) {
  els.authError.textContent = msg || '';
}
function setAuthTab(which) {
  const isLogin = which === 'login';
  els.tabLogin.classList.toggle('active', isLogin);
  els.tabRegister.classList.toggle('active', !isLogin);
  els.loginForm.classList.toggle('hidden', !isLogin);
  els.registerForm.classList.toggle('hidden', isLogin);
  showAuthError('');
}

els.tabLogin.addEventListener('click', () => setAuthTab('login'));
els.tabRegister.addEventListener('click', () => setAuthTab('register'));

els.loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  showAuthError('');
  try {
    const data = await api('/login', {
      method: 'POST',
      body: { userId: els.loginId.value.trim(), password: els.loginPassword.value },
    });
    onAuthenticated(data);
  } catch (err) {
    showAuthError(err.message);
  }
});

els.registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  showAuthError('');
  const id = els.registerId.value.trim();
  const pw = els.registerPassword.value;
  if (pw !== els.registerConfirm.value) {
    showAuthError('Passwords do not match.');
    return;
  }
  try {
    const data = await api('/register', { method: 'POST', body: { userId: id, password: pw } });
    onAuthenticated(data);
    toast(`Welcome, ${data.user.id}! Your account is ready.`);
  } catch (err) {
    showAuthError(err.message);
  }
});

function onAuthenticated({ token, user }) {
  state.token = token;
  localStorage.setItem(TOKEN_KEY, token);
  state.me = user;
  enterChat();
}

function logout() {
  if (state.socket) state.socket.disconnect();
  api('/logout', { method: 'POST' }).catch(() => {});
  state.token = null;
  state.me = null;
  state.users.clear();
  state.conversations.clear();
  state.activePeer = null;
  localStorage.removeItem(TOKEN_KEY);
  els.chatScreen.classList.add('hidden');
  els.authScreen.classList.remove('hidden');
  els.loginPassword.value = '';
  setAuthTab('login');
}

els.logoutBtn.addEventListener('click', logout);

/* ------------------------------- chat screen -------------------------------- */

function enterChat() {
  els.authScreen.classList.add('hidden');
  els.chatScreen.classList.remove('hidden');
  els.meId.textContent = state.me.id;
  setAvatar(els.meAvatar, state.me.id);
  connectSocket();
}

function connectSocket() {
  if (state.socket) {
    state.socket.connect();
    return;
  }
  const socket = io({ auth: { token: state.token } });
  state.socket = socket;

  socket.on('connect', () => {
    refreshAll();
  });

  socket.on('connect_error', (err) => {
    if (err && err.message === 'unauthorized') {
      toast('Session expired. Please log in again.');
      logout();
    }
  });

  socket.on('presence:init', ({ online }) => {
    online.forEach((id) => { if (state.users.has(id)) state.users.get(id).online = true; });
    renderPeople();
  });

  socket.on('presence', ({ userId, online: isOnline }) => {
    if (state.users.has(userId)) state.users.get(userId).online = isOnline;
    if (state.activePeer === userId) renderPeerHeader();
    renderPeople();
    renderConversations();
  });

  socket.on('message:new', ({ message }) => {
    bumpConversation(message.from, message);
    if (state.activePeer === message.from) {
      appendMessage(message);
      scrollMessagesToBottom();
      // We are looking at this conversation: mark read right away.
      socket.emit('conversation:open', { userId: message.from });
    } else {
      renderConversations();
    }
  });

  socket.on('conversation:new', ({ peerId, message, unread }) => {
    const existing = state.conversations.get(peerId);
    if (existing) {
      existing.lastMessage = message;
      if (state.activePeer !== peerId) existing.unread = unread;
    } else {
      state.conversations.set(peerId, { peerId, lastMessage: message, unread });
    }
    renderConversations();
  });

  socket.on('message:read', ({ userId }) => {
    // The peer opened the conversation: refresh the thread so read receipts show.
    if (state.activePeer === userId) loadThread(userId);
    renderConversations();
  });

  socket.on('typing', ({ userId, isTyping }) => {
    if (state.activePeer !== userId) return;
    showTyping(isTyping);
  });
}

async function refreshAll() {
  await Promise.all([refreshUsers(), refreshConversations()]);
  if (state.activePeer) openConversation(state.activePeer, { silent: true });
}

async function refreshUsers() {
  try {
    const { users } = await api(`/users${state.searchQuery ? `?q=${encodeURIComponent(state.searchQuery)}` : ''}`);
    state.users = new Map(users.map((u) => [u.id, { ...u, online: state.socket && state.socket.connected ? u.online : u.online }]));
    renderPeople();
  } catch (err) {
    if (err.status === 401) logout();
  }
}

async function refreshConversations() {
  try {
    const { conversations } = await api('/conversations');
    state.conversations = new Map(conversations.map((c) => [c.peerId, c]));
    renderConversations();
  } catch (err) {
    if (err.status === 401) logout();
  }
}

/* ------------------------------- rendering ---------------------------------- */

function renderPeople() {
  const q = state.searchQuery.trim().toLowerCase();
  const users = [...state.users.values()]
    .filter((u) => !q || u.id.toLowerCase().includes(q) || (u.displayName || '').toLowerCase().includes(q))
    .sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.id.localeCompare(b.id);
    });

  els.peopleList.innerHTML = '';
  if (users.length === 0) {
    const li = document.createElement('li');
    li.className = 'list-empty';
    li.textContent = q ? `No users match “${state.searchQuery}”.` : 'No other users yet. Invite someone to register!';
    els.peopleList.appendChild(li);
    return;
  }
  users.forEach((u) => els.peopleList.appendChild(peopleItem(u)));
}

function peopleItem(u) {
  const li = document.createElement('li');
  li.className = `list-item${state.activePeer === u.id ? ' active' : ''}`;
  li.dataset.userId = u.id;

  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  setAvatar(avatar, u.id);

  const main = document.createElement('div');
  main.className = 'item-main';
  const title = document.createElement('div');
  title.className = 'item-title';
  const id = document.createElement('span');
  id.className = 'id';
  id.textContent = u.id;
  title.appendChild(id);
  const sub = document.createElement('div');
  sub.className = 'item-sub';
  sub.textContent = u.online ? 'online' : 'offline';
  main.append(title, sub);

  const dot = document.createElement('span');
  dot.className = `dot ${u.online ? 'dot-online' : 'dot-offline'}`;

  li.append(avatar, main, dot);
  li.addEventListener('click', () => openConversation(u.id));
  return li;
}

function totalUnread() {
  let n = 0;
  state.conversations.forEach((c) => { if (state.activePeer !== c.peerId) n += c.unread; });
  return n;
}

function renderConversations() {
  const total = totalUnread();
  els.chatBadge.textContent = total > 99 ? '99+' : String(total);
  els.chatBadge.classList.toggle('hidden', total === 0);

  const convs = [...state.conversations.values()].sort(
    (a, b) => (b.lastMessage?.id || 0) - (a.lastMessage?.id || 0)
  );
  els.conversationsList.innerHTML = '';
  if (convs.length === 0) {
    const li = document.createElement('li');
    li.className = 'list-empty';
    li.textContent = 'No conversations yet. Find someone under People and say hi!';
    els.conversationsList.appendChild(li);
    return;
  }
  convs.forEach((c) => els.conversationsList.appendChild(conversationItem(c)));
}

function conversationItem(c) {
  const li = document.createElement('li');
  li.className = `list-item${state.activePeer === c.peerId ? ' active' : ''}`;
  li.dataset.peerId = c.peerId;

  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  setAvatar(avatar, c.peerId);

  const main = document.createElement('div');
  main.className = 'item-main';
  const title = document.createElement('div');
  title.className = 'item-title';
  const id = document.createElement('span');
  id.className = 'id';
  id.textContent = c.peerId;
  const time = document.createElement('span');
  time.className = 'item-time';
  time.textContent = c.lastMessage ? formatRelative(c.lastMessage.createdAt) : '';
  title.append(id, time);

  const sub = document.createElement('div');
  sub.className = 'item-sub';
  const mine = c.lastMessage && c.lastMessage.from === state.me.id;
  sub.textContent = `${mine ? 'You: ' : ''}${c.lastMessage ? c.lastMessage.text : ''}`;
  if (c.unread > 0 && state.activePeer !== c.peerId) sub.classList.add('unread');
  main.append(title, sub);

  li.append(avatar, main);
  if (c.unread > 0 && state.activePeer !== c.peerId) {
    const badge = document.createElement('span');
    badge.className = 'item-badge';
    badge.textContent = c.unread > 99 ? '99+' : String(c.unread);
    li.appendChild(badge);
  }
  li.addEventListener('click', () => openConversation(c.peerId));
  return li;
}

function bumpConversation(peerId, message) {
  const existing = state.conversations.get(peerId);
  if (existing) {
    existing.lastMessage = message;
    if (state.activePeer !== peerId) existing.unread += 1;
  } else {
    state.conversations.set(peerId, { peerId, lastMessage: message, unread: 1 });
  }
}

function renderPeerHeader() {
  const peer = state.users.get(state.activePeer);
  els.peerId.textContent = state.activePeer;
  setAvatar(els.peerAvatar, state.activePeer);
  const online = peer ? peer.online : false;
  els.peerStatus.textContent = online ? 'online' : 'offline';
  els.peerStatus.classList.toggle('online', online);
}

function renderThread() {
  els.messages.innerHTML = '';
  const conv = state.conversations.get(state.activePeer);
  const messages = conv && conv.messages ? conv.messages : [];
  let lastDay = '';
  messages.forEach((m) => {
    const day = formatDay(m.createdAt);
    if (day !== lastDay) {
      lastDay = day;
      const div = document.createElement('div');
      div.className = 'day-divider';
      div.textContent = day;
      els.messages.appendChild(div);
    }
    els.messages.appendChild(messageRow(m));
  });
  scrollMessagesToBottom();
}

function messageRow(m) {
  const row = document.createElement('div');
  const mine = m.from === state.me.id;
  row.className = `msg-row ${mine ? 'mine' : 'theirs'}`;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = m.text;

  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  const time = document.createElement('span');
  time.textContent = formatTime(m.createdAt);
  meta.appendChild(time);
  if (mine && m.readAt) {
    const seen = document.createElement('span');
    seen.className = 'seen';
    seen.textContent = '· seen';
    meta.appendChild(seen);
  }

  row.append(bubble, meta);
  return row;
}

function appendMessage(m) {
  // Day divider handling for the streaming case.
  const rows = els.messages.querySelectorAll('.day-divider');
  const day = formatDay(m.createdAt);
  const lastDay = rows.length ? rows[rows.length - 1].textContent : '';
  if (day !== lastDay) {
    const div = document.createElement('div');
    div.className = 'day-divider';
    div.textContent = day;
    els.messages.appendChild(div);
  }
  els.messages.appendChild(messageRow(m));
}

function scrollMessagesToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function showTyping(isTyping) {
  clearTimeout(showTyping._t);
  if (isTyping) {
    els.typingIndicator.classList.remove('hidden');
    showTyping._t = setTimeout(() => els.typingIndicator.classList.add('hidden'), 3500);
  } else {
    els.typingIndicator.classList.add('hidden');
  }
}

/* ----------------------------- conversations -------------------------------- */

async function loadThread(peerId) {
  try {
    const { messages } = await api(`/conversations/${encodeURIComponent(peerId)}/messages`);
    const conv = state.conversations.get(peerId) || { peerId, lastMessage: null, unread: 0 };
    conv.messages = messages;
    state.conversations.set(peerId, conv);
    conv.unread = 0;
    renderThread();
    renderConversations();
  } catch (err) {
    toast(err.message || 'Could not load messages.');
  }
}

async function openConversation(peerId, { silent = false } = {}) {
  state.activePeer = peerId;
  els.emptyState.classList.add('hidden');
  els.conversationView.classList.remove('hidden');
  renderPeerHeader();
  renderPeople();
  renderConversations();
  showTyping(false);

  await loadThread(peerId);
  // Persist read state server-side (also triggers the peer's read receipt).
  state.socket.emit('conversation:open', { userId: peerId });
  if (!silent) els.messageInput.focus();
}

/* -------------------------------- composer ---------------------------------- */

function autoGrow() {
  els.messageInput.style.height = 'auto';
  els.messageInput.style.height = `${Math.min(els.messageInput.scrollHeight, 140)}px`;
}
els.messageInput.addEventListener('input', autoGrow);

els.messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    els.messageForm.requestSubmit();
  }
});

els.messageForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = els.messageInput.value.trim();
  if (!text || !state.activePeer || !state.socket) return;

  const peerId = state.activePeer;
  els.sendBtn.disabled = true;
  state.socket.emit('message:send', { toUserId: peerId, text }, (res) => {
    els.sendBtn.disabled = false;
    if (!res || !res.ok) {
      toast((res && res.error) || 'Message could not be delivered.');
      return;
    }
    els.messageInput.value = '';
    autoGrow();
    bumpConversation(peerId, res.message);
    appendMessage(res.message);
    scrollMessagesToBottom();
    renderConversations();
    // Stop the typing indicator once the message is out.
    state.socket.emit('typing', { toUserId: peerId, isTyping: false });
    state.lastTypingSent = 0;
  });
});

// Emit "typing" while the user composes (throttled to one event per second).
els.messageInput.addEventListener('input', () => {
  if (!state.activePeer || !state.socket) return;
  const now = Date.now();
  if (now - state.lastTypingSent > 1000 && els.messageInput.value.trim()) {
    state.lastTypingSent = now;
    state.socket.emit('typing', { toUserId: state.activePeer, isTyping: true });
  }
});

/* ------------------------------- navigation --------------------------------- */

els.searchInput.addEventListener('input', () => {
  state.searchQuery = els.searchInput.value;
  refreshUsers();
});

function setNavTab(tab) {
  state.navTab = tab;
  els.navPeople.classList.toggle('active', tab === 'people');
  els.navChats.classList.toggle('active', tab === 'chats');
  els.peopleList.classList.toggle('hidden', tab !== 'people');
  els.conversationsList.classList.toggle('hidden', tab !== 'chats');
}
els.navPeople.addEventListener('click', () => setNavTab('people'));
els.navChats.addEventListener('click', () => setNavTab('chats'));

/* --------------------------------- bootstrap -------------------------------- */

(async function init() {
  setNavTab('people');
  if (!state.token) return;
  try {
    const { user } = await api('/me');
    state.me = user;
    enterChat();
  } catch {
    localStorage.removeItem(TOKEN_KEY);
    state.token = null;
  }
})();
