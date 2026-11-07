#!/usr/bin/env node
// Simula al juez: juega un partido punto por punto en una sala que ya existe, por el mismo
// canal que usa el control. Sirve para mostrar el marcador en vivo sin nadie tocando el celular.
//
//   node scripts/simular-partido.js <sala> [url] [ms entre puntos]
//   node scripts/simular-partido.js t-abc123 http://localhost:3001 1200
const { io } = require('socket.io-client');

const [room, url = 'http://localhost:3000', ms = '1200'] = process.argv.slice(2);
if (!room) {
  console.error('Uso: node scripts/simular-partido.js <sala> [url] [ms entre puntos]');
  process.exit(1);
}
const pause = Number(ms);

// Entrar a una sala la crea si no existe, y una sala sin «mejor de N» nunca termina:
// se revisa antes para no inventar una sala ni simular un partido sin fin.
async function checkRoom() {
  const res = await fetch(`${url}/api/rooms/${room}`).catch(e => {
    console.error(`No se pudo conectar a ${url}: ${e.message}`);
    process.exit(1);
  });
  if (res.status === 404) {
    console.error(`La sala ${room} no existe. Copia el código sala=… del enlace del marcador.`);
    process.exit(1);
  }
  const s = await res.json();
  if (s.error) {
    console.error(s.error);
    process.exit(1);
  }
  if (s.openMatch) {
    console.error(`La sala ${room} no tiene «mejor de N»: el partido no terminaría nunca.`);
    process.exit(1);
  }
}
const wait = t => new Promise(resolve => setTimeout(resolve, t));

checkRoom().then(simulate);

function simulate() {
const socket = io(url, { transports: ['websocket'] });
let state = null;
let n = 0;
socket.on('state', s => { state = s; });
socket.on('connect_error', e => { console.error(`No se pudo conectar a ${url}: ${e.message}`); process.exit(1); });

const send = cmd => new Promise(resolve => socket.emit('command', { id: `sim-${Date.now()}-${++n}`, ...cmd }, resolve));

socket.on('connect', () => socket.emit('join', { room, role: 'control', team: null }, async res => {
  if (!res.ok) { console.error(res.error); process.exit(1); }
  await wait(200);
  console.log(`Simulando en ${room}: ${state.teams.map(t => t.name).join(' vs ')}`);
  while (state.phase === 'playing' || state.phase === 'setOver') {
    if (state.phase === 'setOver') {
      console.log(`Set ${state.currentSet} terminado: ${state.points.join('-')}`);
      await wait(pause * 3);
      await send({ type: 'nextSet' });
    } else {
      const r = await send({ type: 'point', team: Math.random() < 0.5 ? 0 : 1, delta: 1 });
      if (!r.ok) { console.error(r.error); break; }
    }
    await wait(pause);
  }
  console.log(`Fin: ${state.phase} · sets ${state.sets.join('-')}`);
  socket.close();
}));
}
