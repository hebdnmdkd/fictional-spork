const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const rooms = new Map();
const REACTIONS = new Set(['poop', 'money', 'paramecium', 'rose']);
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const ROOM_ID_RE = /^[A-Z0-9]{4,10}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function getRoom(id) {
  let room = rooms.get(id);
  if (!room) {
    room = {
      id,
      clients: new Map(),
      users: new Map(),
      state: {
        videoId: null,
        currentTime: 0,
        playing: false,
        updatedAt: Date.now(),
        master: null,
      },
    };
    rooms.set(id, room);
  }
  return room;
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendEvent(res, type, data) {
  if (res.destroyed || res.writableEnded) return;
  try {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    // A disconnected browser will be removed by the response's close handler.
  }
}

function usersFor(room) {
  return [...room.users.values()].map((user) => ({
    id: user.id,
    name: user.name,
    joinedAt: user.joinedAt,
  }));
}

function broadcast(room, type, data) {
  for (const client of room.clients.values()) sendEvent(client.res, type, data);
}

function broadcastPresence(room) {
  broadcast(room, 'presence', {
    users: usersFor(room),
    master: room.state.master,
  });
}

function safeName(value) {
  const name = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 28);
  return name || 'Гость';
}

function validRoom(value) {
  const id = String(value || '').toUpperCase();
  return ROOM_ID_RE.test(id) ? id : null;
}

function validClient(value) {
  const id = String(value || '');
  return CLIENT_ID_RE.test(id) ? id : null;
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 20_000) throw new Error('Request body too large');
  }
  return JSON.parse(body || '{}');
}

function handleEvents(req, res, url) {
  const roomId = validRoom(url.searchParams.get('room'));
  const clientId = validClient(url.searchParams.get('clientId'));
  if (!roomId || !clientId) {
    sendJson(res, 400, { error: 'Invalid room or client id' });
    return;
  }

  const room = getRoom(roomId);
  const name = safeName(url.searchParams.get('name'));
  const previous = room.clients.get(clientId);
  if (previous) {
    clearInterval(previous.keepAlive);
    previous.res.end();
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (req.socket) req.socket.setNoDelay(true);
  res.write(': connected\n\n');

  const record = { id: clientId, name, res, keepAlive: null };
  room.clients.set(clientId, record);
  room.users.set(clientId, { id: clientId, name, joinedAt: Date.now() });
  if (!room.state.master || !room.clients.has(room.state.master)) {
    room.state.master = clientId;
  }

  sendEvent(res, 'snapshot', {
    room: roomId,
    state: room.state,
    users: usersFor(room),
    serverTime: Date.now(),
  });
  broadcastPresence(room);

  record.keepAlive = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) res.write(': keep-alive\n\n');
  }, 15_000);

  res.on('close', () => {
    clearInterval(record.keepAlive);
    if (room.clients.get(clientId) !== record) return;
    room.clients.delete(clientId);
    room.users.delete(clientId);
    if (room.state.master === clientId) {
      room.state.master = room.clients.keys().next().value || null;
    }
    broadcastPresence(room);
  });
}

async function handleCommand(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message === 'Request body too large' ? error.message : 'Invalid JSON' });
    return;
  }

  const roomId = validRoom(body.room);
  const clientId = validClient(body.clientId);
  if (!roomId || !clientId) {
    sendJson(res, 400, { error: 'Invalid room or client id' });
    return;
  }
  const room = rooms.get(roomId);
  const client = room && room.clients.get(clientId);
  if (!room || !client) {
    sendJson(res, 409, { error: 'Join the room before sending events' });
    return;
  }

  const now = Date.now();
  switch (body.type) {
    case 'video': {
      const videoId = String(body.videoId || '');
      if (!VIDEO_ID_RE.test(videoId)) {
        sendJson(res, 400, { error: 'Invalid YouTube video id' });
        return;
      }
      room.state = {
        videoId,
        currentTime: 0,
        playing: true,
        updatedAt: now,
        master: clientId,
      };
      broadcast(room, 'video', {
        videoId,
        time: 0,
        playing: true,
        serverTime: now,
        senderId: clientId,
        senderName: client.name,
      });
      broadcastPresence(room);
      sendJson(res, 200, { ok: true });
      return;
    }

    case 'playback': {
      if (!room.state.videoId || typeof body.playing !== 'boolean') {
        sendJson(res, 400, { error: 'No active video or invalid playback state' });
        return;
      }
      const time = Number(body.time);
      if (!Number.isFinite(time) || time < 0 || time > 10_000_000) {
        sendJson(res, 400, { error: 'Invalid playback time' });
        return;
      }
      room.state = {
        ...room.state,
        currentTime: time,
        playing: body.playing,
        updatedAt: now,
        master: clientId,
      };
      broadcast(room, 'playback', {
        videoId: room.state.videoId,
        time,
        playing: body.playing,
        serverTime: now,
        senderId: clientId,
        senderName: client.name,
      });
      broadcastPresence(room);
      sendJson(res, 200, { ok: true });
      return;
    }

    case 'tick': {
      if (!room.state.videoId || !room.state.playing || room.state.master !== clientId) {
        sendJson(res, 200, { ok: true, ignored: true });
        return;
      }
      const time = Number(body.time);
      if (!Number.isFinite(time) || time < 0 || time > 10_000_000) {
        sendJson(res, 400, { error: 'Invalid playback time' });
        return;
      }
      room.state.currentTime = time;
      room.state.updatedAt = now;
      broadcast(room, 'tick', {
        videoId: room.state.videoId,
        time,
        playing: true,
        serverTime: now,
        senderId: clientId,
      });
      sendJson(res, 200, { ok: true });
      return;
    }

    case 'reaction': {
      if (!REACTIONS.has(body.reaction)) {
        sendJson(res, 400, { error: 'Unknown reaction' });
        return;
      }
      broadcast(room, 'reaction', {
        id: crypto.randomUUID(),
        reaction: body.reaction,
        senderId: clientId,
        senderName: client.name,
        createdAt: now,
      });
      sendJson(res, 200, { ok: true });
      return;
    }

    case 'name': {
      client.name = safeName(body.name);
      room.users.set(clientId, { id: clientId, name: client.name, joinedAt: now });
      broadcastPresence(room);
      sendJson(res, 200, { ok: true, name: client.name });
      return;
    }

    default:
      sendJson(res, 400, { error: 'Unknown event type' });
  }
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(url, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    sendJson(res, 400, { error: 'Bad URL' });
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  const allowed = new Set(['/index.html', '/styles.css', '/app.js']);
  if (!allowed.has(pathname)) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  const filePath = path.join(ROOT, pathname.slice(1));
  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    sendJson(res, 400, { error: 'Bad URL' });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    handleEvents(req, res, url);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/command') {
    handleCommand(req, res);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, rooms: rooms.size });
    return;
  }
  if (req.method === 'GET') {
    serveStatic(url, res);
    return;
  }
  sendJson(res, 405, { error: 'Method not allowed' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Watch-together app listening on http://0.0.0.0:${PORT}`);
});

function closeServer() {
  for (const room of rooms.values()) {
    for (const client of room.clients.values()) {
      clearInterval(client.keepAlive);
      client.res.end();
    }
  }
  server.close(() => process.exit(0));
}
process.on('SIGTERM', closeServer);
process.on('SIGINT', closeServer);
