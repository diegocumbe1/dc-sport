// Prueba de integración: levanta el servidor real, conecta clientes Socket.IO
// y verifica rutas, sincronización, aislamiento de salas, límites y persistencia.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dcscore-')), 'scores.json');

function startServer() {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_FILE, ADMIN_PIN: '4321' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    proc.stdout.on('data', d => { if (String(d).includes('DC Sport Score en')) resolve(proc); });
    proc.stderr.on('data', d => process.stderr.write(d));
    proc.on('exit', code => reject(new Error('El servidor terminó con código ' + code)));
  });
}
const stopServer = proc => new Promise(r => { proc.on('exit', r); proc.kill('SIGTERM'); });

const clients = [];
function client(room, role, team = null) {
  const s = io(BASE, { transports: ['websocket'], forceNew: true, reconnection: false });
  clients.push(s);
  s.states = [];
  s.on('state', st => s.states.push(st));
  return new Promise((resolve, reject) => {
    s.on('connect', () => s.emit('join', { room, role, team }, res => resolve(Object.assign(s, { joinRes: res }))));
    s.on('connect_error', reject);
  });
}
const cmd = (s, c) => s.timeout(3000).emitWithAck('command', c);
const waitState = (s, pred) => new Promise((resolve, reject) => {
  const hit = s.states.find(pred);
  if (hit) return resolve(hit);
  const t = setTimeout(() => reject(new Error('No llegó el estado esperado')), 3000);
  s.on('state', st => { if (pred(st)) { clearTimeout(t); resolve(st); } });
});

let server;
test.before(async () => { server = await startServer(); });
test.after(async () => {
  clients.forEach(c => c.close());
  if (server && server.exitCode === null) await stopServer(server);
});

test('rutas HTTP responden', async () => {
  for (const [route, marker] of [['/', 'DC SPORT SCORE'], ['/marcador?sala=voley', 'Marcador'], ['/control?sala=voley', 'Control'], ['/admin?sala=voley', 'Administración']]) {
    const res = await fetch(BASE + route);
    assert.equal(res.status, 200, route);
    assert.match(await res.text(), new RegExp(marker), route);
  }
  for (const asset of ['/css/app.css', '/js/common.js', '/socket.io/socket.io.js', '/api/health']) {
    assert.equal((await fetch(BASE + asset)).status, 200, asset);
  }
});

test('sincronización, aislamiento y deduplicación', async () => {
  const screen = await client('sala1', 'marcador');
  const ctl = await client('sala1', 'control');
  const other = await client('sala2', 'marcador');
  assert.equal(screen.joinRes.ok, true);

  assert.equal((await cmd(ctl, { type: 'point', team: 0, delta: 1, set: 1, id: 'a1' })).ok, true);
  const dup = await cmd(ctl, { type: 'point', team: 0, delta: 1, set: 1, id: 'a1' });
  assert.equal(dup.duplicate, true);
  await cmd(ctl, { type: 'point', team: 1, delta: 1, id: 'a2' });
  await cmd(ctl, { type: 'point', team: 1, delta: -1, id: 'a3' });

  const st = await waitState(screen, s => s.version === 3);
  assert.deepEqual(st.points, [1, 0], 'el marcador recibe los cambios del control');
  await new Promise(r => setTimeout(r, 150));
  assert.ok(other.states.every(s => s.points[0] === 0 && s.points[1] === 0), 'sala2 no se ve afectada');
  assert.deepEqual((await (await fetch(BASE + '/api/rooms/sala2')).json()).points, [0, 0]);

  assert.equal((await cmd(screen, { type: 'point', team: 0, delta: 1, id: 'm1' })).ok, false, 'el marcador es solo lectura');
});

test('cierre automático de set vía socket', async () => {
  const screen = await client('sala3', 'marcador');
  const ctl = await client('sala3', 'control');
  for (let i = 0; i < 25; i++) await cmd(ctl, { type: 'point', team: 1, delta: 1, set: 1, id: 's3-' + i });
  const st = await waitState(screen, s => s.phase === 'setOver');
  assert.deepEqual(st.sets, [0, 1]);
  assert.equal((await cmd(ctl, { type: 'point', team: 0, delta: 1, set: 1, id: 's3-x' })).ok, false);
  assert.equal((await cmd(ctl, { type: 'nextSet', set: 1, id: 's3-n1' })).ok, true);
  assert.equal((await cmd(ctl, { type: 'nextSet', set: 1, id: 's3-n2' })).ok, false);
  assert.equal((await waitState(screen, s => s.currentSet === 2)).points[1], 0);
});

test('límite de dispositivos: 1 marcador + 2 controles, un control por equipo', async () => {
  const room = 'sala4';
  assert.equal((await client(room, 'marcador')).joinRes.ok, true);
  const second = await client(room, 'marcador');
  assert.equal(second.joinRes.ok, false);
  assert.equal(second.joinRes.full, true);

  const ctlA = await client(room, 'control', 0);
  assert.equal(ctlA.joinRes.ok, true);
  assert.equal((await client(room, 'control', 0)).joinRes.ok, false, 'no dos controles del equipo A');
  const ctlB = await client(room, 'control', 1);
  assert.equal(ctlB.joinRes.ok, true);
  assert.equal((await client(room, 'control')).joinRes.ok, false, 'máximo 2 controles');
  assert.equal((await client(room, 'admin')).joinRes.ok, true, 'admin no cuenta en el límite');

  assert.equal((await cmd(ctlA, { type: 'point', team: 1, delta: 1, id: 'x1' })).ok, false, 'control A no puntúa a B');
  assert.equal((await cmd(ctlA, { type: 'point', team: 0, delta: 1, id: 'x2' })).ok, true);

  // Al salir un control se libera su lugar.
  ctlB.close();
  await new Promise(r => setTimeout(r, 200));
  assert.equal((await client(room, 'control', 1)).joinRes.ok, true);
});

test('PIN de administración', async () => {
  const adm = await client('sala5', 'admin');
  assert.equal((await cmd(adm, { type: 'setTeams', teams: [{ name: 'A' }, { name: 'B' }], id: 'p0' })).ok, false);
  assert.equal((await adm.emitWithAck('admin-auth', '0000')).ok, false);
  assert.equal((await adm.emitWithAck('admin-auth', '4321')).ok, true);
  assert.equal((await cmd(adm, { type: 'setTeams', teams: [{ name: 'Leones' }, { name: 'Tigres' }], id: 'p1' })).ok, true);
  const ctl = await client('sala5', 'control');
  assert.equal((await ctl.emitWithAck('admin-auth', '4321')).ok, false, 'un control no puede volverse admin');
});

const setup = (room, body) => fetch(`${BASE}/api/rooms/${room}/setup`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(async r => ({ status: r.status, ...(await r.json()) }));


test('crear tablero: orden de saque opcional, y reconfigurar sin él lo quita', async () => {
  const made = await setup('saque1', { teams: [{ name: 'Rojo' }, { name: 'Azul' }], serveOrders: [[5, 8, 21, 0, 10], [1, 0, 34, 10, 6]], firstServer: 1 });
  assert.equal(made.status, 200);
  assert.equal(made.state.hasServeOrder, true);
  assert.equal(made.state.serve, 1);
  assert.equal(made.state.serveNumber, 1);
  const again = await setup('saque1', { teams: [{ name: 'Rojo' }, { name: 'Azul' }] });
  assert.equal(again.state.hasServeOrder, false);
  assert.equal(again.state.serve, null);
  assert.equal((await setup('saque2', { teams: [{}, {}], serveOrders: [[100]] })).status, 400);
});

test('voz: se elige al crear el tablero y el control la cambia en pleno partido', async () => {
  const made = await setup('voz1', { teams: [{ name: 'Los Tigres', color: '#1f9d55' }, {}], voice: { enabled: true, speaker: 'mx-m', announce: 'color' } });
  assert.equal(made.status, 200);
  assert.equal(made.state.voice.speaker, 'mx-m');
  assert.equal(made.state.voice.announce, 'color');
  assert.equal((await setup('voz2', { teams: [{}, {}] })).state.voice.speaker, 'co-f');
  assert.equal((await setup('voz2', { teams: [{}, {}] })).state.voice.announce, 'name');
  assert.equal((await setup('voz3', { teams: [{}, {}], voice: { speaker: 'robot' } })).status, 400);
  const c = await client('voz1', 'control');
  assert.equal((await cmd(c, { type: 'point', team: 0, delta: 1 })).ok, true);
  assert.equal((await cmd(c, { type: 'setVoiceStyle', speaker: 'la-f', announce: 'name' })).ok, true);
  const st = await waitState(c, x => x.voice.speaker === 'la-f');
  assert.equal(st.voice.announce, 'name');
  assert.deepEqual(st.points, [1, 0]); // la voz no toca el marcador
  assert.equal((await cmd(c, { type: 'setVoiceStyle', speaker: 'robot' })).ok, false);
  // El nombre de un equipo solo se sintetiza si existe en alguna sala.
  assert.equal((await fetch(`${BASE}/api/voz/co-f?t=${encodeURIComponent('Nadie Juega')}`)).status, 404);
  assert.equal((await fetch(`${BASE}/api/voz/robot?t=x`)).status, 400);
});

test('música: llega desde /setup y la pantalla la cambia, pero no marca puntos', async () => {
  const made = await setup('musica1', { teams: [{}, {}], music: { youtube: 'https://music.youtube.com/playlist?list=OLAK5uy_abcdefghijk' } });
  assert.deepEqual(made.state.music.youtube, { video: null, list: 'OLAK5uy_abcdefghijk' });
  assert.equal((await setup('musica2', { teams: [{}, {}], music: { youtube: 'no es un enlace' } })).status, 400);
  const screen = await client('musica1', 'marcador');
  assert.equal((await cmd(screen, { type: 'setMusic', youtube: 'https://youtu.be/dQw4w9WgXcQ' })).ok, true);
  const st = await waitState(screen, x => x.music.youtube && x.music.youtube.video === 'dQw4w9WgXcQ');
  assert.equal(st.music.youtube.list, null);
  assert.equal((await cmd(screen, { type: 'setVoiceStyle', speaker: 'mx-f' })).ok, true);
  assert.equal((await cmd(screen, { type: 'point', team: 0, delta: 1 })).ok, false);
  assert.equal((await cmd(screen, { type: 'setMusic', youtube: null })).ok, true);
});

test('crear tablero: solo es sala de torneo si se pide', async () => {
  assert.equal((await setup('recreativa1', { teams: [{}, {}] })).state.torneo, false);
  assert.equal((await setup('torneo1', { teams: [{}, {}], torneo: true })).state.torneo, true);
});

test('borrar una sala: las de torneo avisan el cierre y no quedan en blanco', async () => {
  const borrar = room => fetch(`${BASE}/api/rooms/${room}`, { method: 'DELETE', headers: { 'x-admin-pin': '4321' } });

  await setup('cierre1', { teams: [{}, {}], torneo: true });
  const juez = await client('cierre1', 'control');
  const aviso = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('No llegó el aviso de cierre')), 3000);
    juez.once('room-closed', () => { clearTimeout(t); resolve(); });
  });
  assert.equal((await borrar('cierre1')).status, 200);
  await aviso;
  assert.equal((await fetch(`${BASE}/api/rooms/cierre1`)).status, 404, 'no se recrea en blanco');

  await setup('cierre2', { teams: [{}, {}] });
  const normal = await client('cierre2', 'control');
  let cerrada = false;
  normal.once('room-closed', () => { cerrada = true; });
  await borrar('cierre2');
  assert.equal((await fetch(`${BASE}/api/rooms/cierre2`)).status, 200, 'la recreativa sigue en blanco');
  assert.equal(cerrada, false);
});

test('sala de partido de torneo: un enlace viejo no la crea, /setup sí', async () => {
  const sala = 't-0123456789ab';
  const viejo = await client(sala, 'control');
  assert.equal(viejo.joinRes.closed, true);
  assert.equal((await fetch(`${BASE}/api/rooms/${sala}`)).status, 404);

  assert.equal((await setup(sala, { teams: [{ name: 'A' }, { name: 'B' }], torneo: true })).ok, true);
  const juez = await client(sala, 'control');
  assert.equal(juez.joinRes.ok, true);
  assert.equal((await cmd(juez, { type: 'point', team: 0, delta: 1, id: 'cerrada1' })).ok, true);

  await fetch(`${BASE}/api/rooms/${sala}`, { method: 'DELETE', headers: { 'x-admin-pin': '4321' } });
  const tarde = await cmd(juez, { type: 'point', team: 0, delta: 1, id: 'cerrada2' });
  assert.equal(tarde.closed, true);
  assert.equal((await fetch(`${BASE}/api/rooms/${sala}`)).status, 404, 'un toque tardío no la revive');

  // Otros códigos siguen creando sala al abrirlos, como siempre.
  assert.equal((await client('t-recreativa', 'control')).joinRes.ok, true);
});

test('crear tablero desde el inicio con N equipos', async () => {
  const r = await setup('torneo', { teams: [{ name: 'Leones' }, { name: '' }, { name: 'Tigres', color: '#00aa00' }], pointsPerSet: 15, rotation: 'winnerStays' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.state.allTeams.map(t => t.name), ['LEONES', 'ROJO', 'TIGRES']);
  assert.equal(r.state.allTeams[2].color, '#00aa00');
  assert.deepEqual([r.state.court, r.state.queue], [[0, 1], [2]]);
  assert.equal(r.state.config.pointsPerSet, 15);
  assert.equal(r.state.canUndo, false);

  // Sin juego todavía: se puede reconfigurar sin PIN.
  assert.equal((await setup('torneo', { teams: [{}, {}, {}, {}] })).state.allTeams.length, 4);

  // Con marcador en curso: exige PIN.
  const ctl = await client('torneo', 'control');
  await cmd(ctl, { type: 'point', team: 0, delta: 1, id: 't1' });
  const denied = await setup('torneo', { teams: [{}, {}] });
  assert.equal(denied.status, 403);
  assert.equal(denied.needPin, true);
  const wrong = await setup('torneo', { teams: [{}, {}], pin: '0000' });
  assert.equal(wrong.status, 403);
  const ok = await setup('torneo', { teams: [{}, {}], pin: '4321' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.state.points, [0, 0]);
  assert.equal(ok.state.allTeams.length, 2);

  // Datos inválidos: la sala queda como estaba.
  const bad = await setup('torneo', { teams: [{}] });
  assert.equal(bad.status, 400);
  assert.equal((await (await fetch(BASE + '/api/rooms/torneo')).json()).allTeams.length, 2);
  assert.equal((await setup('x', { teams: [{}, {}] })).status, 400);
});

test('persistencia tras reiniciar el servidor', async () => {
  clients.forEach(c => c.close());
  await stopServer(server);
  assert.ok(fs.existsSync(DATA_FILE), 'se escribió el archivo de datos');
  server = await startServer();
  const s1 = await (await fetch(BASE + '/api/rooms/sala1')).json();
  assert.deepEqual(s1.points, [1, 0]);
  const s3 = await (await fetch(BASE + '/api/rooms/sala3')).json();
  assert.equal(s3.currentSet, 2);
  assert.deepEqual(s3.sets, [1, 0], 'B ganó el set 1 y cambió al lado izquierdo');
  const s5 = await (await fetch(BASE + '/api/rooms/sala5')).json();
  assert.equal(s5.teams[0].name, 'LEONES');
  // Deshacer sigue funcionando con el historial persistido (la última acción fue −1 B).
  const ctl = await client('sala1', 'control');
  assert.equal((await cmd(ctl, { type: 'undo', id: 'u1' })).ok, true);
  assert.deepEqual((await waitState(ctl, s => s.version === 4)).points, [1, 1]);
});

test('admin: listar y borrar salas', async () => {
  await setup('prueba1', { teams: [{}, {}] });
  await setup('prueba2', { teams: [{}, {}] });
  const adm = await client('prueba1', 'admin');
  assert.equal((await adm.emitWithAck('admin-rooms', undefined)).ok, false, 'sin PIN no lista');
  await adm.emitWithAck('admin-auth', '4321');
  const list = await adm.emitWithAck('admin-rooms', undefined);
  assert.ok(list.rooms.some(r => r.room === 'prueba2'));
  assert.equal((await adm.emitWithAck('admin-delete-room', 'prueba2')).ok, true);
  assert.equal((await fetch(BASE + '/api/rooms/prueba2')).status, 404);
  // La sala con dispositivos conectados queda en blanco con versión mayor.
  const before = adm.states.at(-1).version;
  assert.equal((await adm.emitWithAck('admin-delete-room', 'prueba1')).ok, true);
  const fresh = await waitState(adm, s => s.version > before);
  assert.deepEqual(fresh.points, [0, 0]);
  const all = await adm.emitWithAck('admin-delete-all');
  assert.equal(all.ok, true);
  assert.ok(all.deleted >= 1);
});
