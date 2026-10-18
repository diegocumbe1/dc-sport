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
  assert.deepEqual(s3.sets, [0, 1]);
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
