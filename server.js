const express = require('express');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { Server } = require('socket.io');
const path = require('path');
const volley = require('./src/volley');
const { createStore } = require('./src/store');

const PORT = process.env.PORT || 3000;
const ADMIN_PIN = String(process.env.ADMIN_PIN || '1234');
const DATA_FILE = process.env.DATA_FILE || path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'scores.json');
const MAX_ROOMS = 1000;
const ROOM_TTL_MS = 30 * 24 * 3600 * 1000; // salas sin uso en 30 días se descartan al arrancar
const PUBLIC = path.join(__dirname, 'public');

const app = express();
app.set('trust proxy', true); // ngrok / Render envían X-Forwarded-*
const server = http.createServer(app);
// Latidos cortos: un celular que pierde la red libera su lugar en ~20 s.
const io = new Server(server, { pingInterval: 10_000, pingTimeout: 10_000 });

// Límite de dispositivos por sala: 1 marcador + 2 controles (admin no cuenta).
const LIMITS = { marcador: 1, control: 2 };
const ROLES = ['marcador', 'control', 'admin'];

// ---------- Estado por sala + persistencia ----------
const games = new Map();
const store = createStore(DATA_FILE);
store.bind(() => ({ savedAt: Date.now(), rooms: Object.fromEntries(games) }));
{
  const data = store.load();
  const now = Date.now();
  for (const [room, raw] of Object.entries(data.rooms || {})) {
    const g = volley.hydrate(raw);
    if (now - (g.updatedAt || 0) < ROOM_TTL_MS) games.set(room, g);
  }
  console.log(`[store] ${games.size} sala(s) cargada(s) desde ${DATA_FILE}`);
}

const normRoom = room => (typeof room === 'string' ? room.trim().toLowerCase() : '');
const validRoom = room => /^[a-z0-9_-]{3,24}$/.test(room);
function getGame(room, create = true) {
  if (!games.has(room) && create) {
    if (games.size >= MAX_ROOMS) return null;
    games.set(room, volley.makeGame());
  }
  return games.get(room) || null;
}
const stateOf = room => volley.publicState(room, getGame(room));
function broadcast(room) {
  io.to(room).emit('state', stateOf(room));
}
function membersOf(room, except) {
  const ids = io.sockets.adapter.rooms.get(room) || new Set();
  return [...ids].filter(id => id !== except).map(id => io.sockets.sockets.get(id)?.data).filter(Boolean);
}
function emitPresence(room) {
  const m = membersOf(room);
  io.to(room).emit('presence', {
    marcador: m.filter(d => d.role === 'marcador').length,
    controls: m.filter(d => d.role === 'control').map(d => d.team),
    admins: m.filter(d => d.role === 'admin').length,
  });
}
// Verifica si hay lugar para este rol/equipo en la sala.
function seatError(room, role, team, socketId) {
  if (role === 'admin') return null;
  const others = membersOf(room, socketId).filter(d => d.role === role);
  if (others.length >= LIMITS[role]) {
    return role === 'marcador'
      ? 'Ya hay un marcador conectado en esta sala (máximo 1)'
      : 'Ya hay 2 controles conectados en esta sala (máximo 2)';
  }
  if (role === 'control' && team !== null && others.some(d => d.team === team)) {
    return `Ya hay un control para el equipo ${team === 0 ? 'A' : 'B'} en esta sala`;
  }
  return null;
}

// Ids de comandos ya procesados por sala: evita aplicar dos veces un mismo
// comando reenviado por el cliente (reintentos, reconexiones).
const seen = new Map();
function alreadySeen(room, id) {
  if (typeof id !== 'string' || id.length > 64) return false;
  let ids = seen.get(room);
  if (!ids) seen.set(room, (ids = new Set()));
  if (ids.has(id)) return true;
  ids.add(id);
  if (ids.size > 300) ids.delete(ids.values().next().value);
  return false;
}

// Borra una sala. Si hay dispositivos conectados, la sala vuelve a quedar en blanco
// (en vez de desaparecer) para que sus pantallas muestren el estado limpio.
function deleteRoom(room) {
  const old = games.get(room);
  games.delete(room);
  seen.delete(room);
  if (io.sockets.adapter.rooms.get(room)?.size) {
    const fresh = volley.makeGame();
    fresh.version = (old ? old.version : 0) + 1; // los clientes descartan versiones menores
    games.set(room, fresh);
    broadcast(room);
  }
}

// ---------- PIN de administración ----------
const pinFails = new Map(); // ip -> { count, until }
function checkPin(ip, pin) {
  const now = Date.now();
  const f = pinFails.get(ip);
  if (f && f.until > now) return { ok: false, error: 'Demasiados intentos. Espera un minuto.' };
  const a = crypto.createHash('sha256').update(String(pin ?? '')).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PIN).digest();
  if (crypto.timingSafeEqual(a, b)) {
    pinFails.delete(ip);
    return { ok: true };
  }
  const count = (f && f.until <= now && f.count >= 5 ? 0 : f?.count || 0) + 1;
  pinFails.set(ip, { count, until: count >= 5 ? now + 60_000 : 0 });
  return { ok: false, error: 'PIN incorrecto' };
}
const clientIp = socket => (socket.handshake.headers['x-forwarded-for'] || '').split(',')[0].trim() || socket.handshake.address;

// ---------- Socket.IO ----------
io.on('connection', socket => {
  const reply = (ack, res) => typeof ack === 'function' && ack(res);

  // join acepta 'sala' (formato original) o { room, role, team }.
  socket.on('join', (payload, ack) => {
    const opts = typeof payload === 'object' && payload ? payload : { room: payload };
    const room = normRoom(opts.room);
    const role = ROLES.includes(opts.role) ? opts.role : 'control';
    const team = opts.team === 0 || opts.team === 1 ? opts.team : null;
    if (!validRoom(room)) {
      socket.emit('error-msg', 'Código de sala inválido');
      return reply(ack, { ok: false, error: 'Código de sala inválido' });
    }
    const seat = seatError(room, role, team, socket.id);
    if (seat) return reply(ack, { ok: false, full: true, error: seat });
    if (!getGame(room)) return reply(ack, { ok: false, error: 'Límite de salas alcanzado' });
    const prev = socket.data.room;
    if (prev && prev !== room) {
      socket.leave(prev);
      socket.data.admin = false;
      emitPresence(prev);
    }
    socket.data.role = role;
    socket.data.team = role === 'control' ? team : null;
    socket.data.room = room;
    socket.join(room);
    socket.emit('state', stateOf(room));
    emitPresence(room);
    reply(ack, { ok: true, room });
  });

  socket.on('admin-auth', (pin, ack) => {
    if (socket.data.role !== 'admin') return reply(ack, { ok: false, error: 'Solo desde la vista de administración' });
    const res = checkPin(clientIp(socket), pin);
    socket.data.admin = res.ok;
    reply(ack, res);
  });

  // ---- Gestión de salas guardadas (solo admin autenticado) ----
  const isAdmin = ack => {
    if (socket.data.admin === true) return true;
    reply(ack, { ok: false, error: 'Requiere PIN de administración' });
    return false;
  };
  // El ack es siempre el último argumento (el cliente puede enviar un payload vacío).
  const lastFn = args => (typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null);
  socket.on('admin-rooms', (...args) => {
    const ack = lastFn(args);
    if (!isAdmin(ack)) return;
    const rooms = [...games.entries()].map(([room, g]) => ({
      room,
      teams: g.teams.map(t => t.name),
      points: g.points,
      currentSet: g.currentSet,
      updatedAt: g.updatedAt,
      connected: io.sockets.adapter.rooms.get(room)?.size || 0,
    })).sort((a, b) => b.updatedAt - a.updatedAt);
    reply(ack, { ok: true, rooms });
  });
  socket.on('admin-delete-room', (rawRoom, ack) => {
    if (!isAdmin(ack)) return;
    const room = normRoom(rawRoom);
    if (!games.has(room)) return reply(ack, { ok: false, error: 'La sala no existe' });
    deleteRoom(room);
    store.scheduleSave();
    reply(ack, { ok: true });
  });
  socket.on('admin-delete-all', (...args) => {
    const ack = lastFn(args);
    if (!isAdmin(ack)) return;
    const n = games.size;
    for (const room of [...games.keys()]) deleteRoom(room);
    store.scheduleSave();
    reply(ack, { ok: true, deleted: n });
  });

  socket.on('command', (cmd, ack) => {
    const room = socket.data.room;
    if (!room) return reply(ack, { ok: false, error: 'No estás en una sala' });
    if (!cmd || typeof cmd !== 'object') return reply(ack, { ok: false, error: 'Comando inválido' });
    if (socket.data.role === 'marcador') return reply(ack, { ok: false, error: 'El marcador es solo de lectura' });
    if (cmd.type === 'point' && socket.data.team !== null && socket.data.team !== undefined && cmd.team !== socket.data.team) {
      return reply(ack, { ok: false, error: 'Este control solo maneja a su equipo' });
    }
    if (alreadySeen(room, cmd.id)) return reply(ack, { ok: true, duplicate: true });
    const res = volley.apply(getGame(room), cmd, { admin: socket.data.admin === true });
    if (res.ok) {
      broadcast(room);
      store.scheduleSave();
    }
    reply(ack, res);
  });

  socket.on('disconnect', () => {
    if (socket.data.room) emitPresence(socket.data.room);
  });
});

// ---------- HTTP ----------
// Cada vista es un archivo HTML propio. Antes solo existía express.static,
// por eso /marcador y /control respondían "Cannot GET".
const page = file => (req, res) => res.sendFile(path.join(PUBLIC, file));
app.get('/', page('index.html'));
app.get('/marcador', page('marcador.html'));
app.get('/control', page('control.html'));
app.get('/admin', page('admin.html'));
app.get('/guia', page('guia.html'));

app.get('/api/health', (req, res) => res.json({ ok: true, rooms: games.size, uptime: process.uptime() }));
app.get('/api/info', (req, res) => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  res.json({ port: Number(PORT), ips });
});
// Crear / configurar un tablero desde la pantalla de inicio: cantidad de equipos,
// nombres, colores y formato. Sin PIN si el tablero es nuevo o no tiene puntos;
// si ya tiene marcador, exige el PIN de administración.
app.post('/api/rooms/:room/setup', express.json({ limit: '10kb' }), (req, res) => {
  const room = normRoom(req.params.room);
  if (!validRoom(room)) return res.status(400).json({ ok: false, error: 'Código de sala inválido (3 a 24 letras, números, - o _)' });
  const body = req.body || {};
  const existing = games.get(room);
  if (existing && !volley.isPristine(existing)) {
    const pin = checkPin(req.ip, body.pin);
    if (!pin.ok) {
      return res.status(403).json({ ok: false, needPin: true, error: `La sala ya tiene un marcador en curso. ${body.pin ? pin.error : 'Ingresa el PIN de administración para reconfigurarla.'}` });
    }
  }
  const g = getGame(room);
  if (!g) return res.status(503).json({ ok: false, error: 'Límite de salas alcanzado' });
  // Se aplica sobre una copia: si algo es inválido, la sala queda como estaba.
  const draft = volley.hydrate(JSON.parse(JSON.stringify(g)));
  const prevVersion = draft.version;
  Object.assign(draft, volley.makeGame(draft));
  const steps = [
    { type: 'setTeams', teams: body.teams },
    {
      type: 'setConfig',
      pointsPerSet: body.pointsPerSet ?? draft.config.pointsPerSet,
      // Por defecto partido abierto (sin «mejor de N»), según config/options.json.
      totalSets: body.totalSets ?? volley.OPTIONS.totalSets.default,
      decidingSetPoints: body.decidingSetPoints ?? volley.OPTIONS.decidingSetPoints.default,
      rotation: body.rotation ?? draft.config.rotation,
    },
  ];
  // Voz opcional desde el inicio: solo encender/apagar; el resto se ajusta en /admin.
  if (body.voice && typeof body.voice.enabled === 'boolean') {
    steps.push({ type: 'setVoice', voice: { ...draft.voice, enabled: body.voice.enabled } });
  }
  for (const step of steps) {
    const r = volley.apply(draft, step, { admin: true });
    if (!r.ok) return res.status(400).json(r);
  }
  draft.undo = [];
  draft.version = prevVersion + 1;
  draft.log.push({ ts: Date.now(), text: `Tablero creado con ${draft.teams.length} equipos`, by: 'inicio' });
  Object.assign(g, draft);
  broadcast(room);
  store.scheduleSave();
  res.json({ ok: true, state: stateOf(room) });
});

// Borrar una sala del servidor desde la página de inicio (requiere PIN en el header x-admin-pin).
app.delete('/api/rooms/:room', (req, res) => {
  const room = normRoom(req.params.room);
  if (!validRoom(room)) return res.status(400).json({ ok: false, error: 'Código de sala inválido' });
  const pin = checkPin(req.ip, req.get('x-admin-pin'));
  if (!pin.ok) return res.status(403).json({ ok: false, error: pin.error });
  if (!games.has(room)) return res.json({ ok: true, existed: false });
  deleteRoom(room);
  store.scheduleSave();
  res.json({ ok: true, existed: true });
});

app.get('/api/rooms/:room', (req, res) => {
  const room = normRoom(req.params.room);
  if (!validRoom(room)) return res.status(400).json({ error: 'Código de sala inválido' });
  if (!games.has(room)) return res.status(404).json({ error: 'Sala sin datos' });
  res.json(stateOf(room));
});

app.use(express.static(PUBLIC, { extensions: ['html'] }));
app.use((req, res) => res.status(404).sendFile(path.join(PUBLIC, 'index.html')));

// Guardar pendientes antes de salir (Ctrl+C, reinicio de Render).
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    store.flush();
    process.exit(0);
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`DC Sport Score en http://localhost:${PORT}`);
  if (!process.env.ADMIN_PIN) console.log('[admin] Usando PIN por defecto 1234. Define ADMIN_PIN para cambiarlo.');
});
