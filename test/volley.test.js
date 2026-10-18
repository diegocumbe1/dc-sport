const test = require('node:test');
const assert = require('node:assert/strict');
const { makeGame, apply, hydrate } = require('../src/volley');

const pt = (g, team, delta = 1) => apply(g, { type: 'point', team, delta });
function score(g, a, b) {
  for (let i = 0; i < a; i++) pt(g, 0);
  for (let i = 0; i < b; i++) pt(g, 1);
}

test('suma y resta sin negativos', () => {
  const g = makeGame();
  assert.equal(pt(g, 0).ok, true);
  assert.deepEqual(g.points, [1, 0]);
  assert.equal(pt(g, 0, -1).ok, true);
  assert.equal(pt(g, 0, -1).ok, false);
  assert.deepEqual(g.points, [0, 0]);
  assert.equal(pt(g, 2).ok, false);
  assert.equal(apply(g, { type: 'point', team: 0, delta: 5 }).ok, false);
});

test('cierre de set a 25 con diferencia de 2', () => {
  const g = makeGame();
  score(g, 24, 24);
  assert.equal(g.phase, 'playing');
  pt(g, 0);
  assert.equal(g.phase, 'playing'); // 25-24 no cierra
  pt(g, 0);
  assert.equal(g.phase, 'setOver');
  assert.deepEqual(g.teamSets, [1, 0]);
  assert.equal(g.setWinner, 0);
  assert.deepEqual(g.setResults[0].points, [26, 24]);
});

test('bloqueo durante la transición de set y confirmación única', () => {
  const g = makeGame();
  score(g, 25, 0);
  assert.equal(g.phase, 'setOver');
  assert.equal(pt(g, 1).ok, false, 'no se suma con el set cerrado');
  assert.equal(pt(g, 0, -1).ok, false, 'no se resta con el set cerrado');
  assert.equal(apply(g, { type: 'nextSet', set: 1 }).ok, true);
  assert.equal(apply(g, { type: 'nextSet', set: 1 }).ok, false, 'segunda confirmación ignorada');
  assert.equal(g.currentSet, 2);
  assert.deepEqual(g.points, [0, 0]);
  // Toque que se originó en el set 1 y llega tarde.
  assert.equal(apply(g, { type: 'point', team: 0, delta: 1, set: 1 }).ok, false);
  assert.deepEqual(g.points, [0, 0]);
});

test('deshacer revierte el punto que cerró el set', () => {
  const g = makeGame();
  score(g, 25, 0);
  assert.equal(apply(g, { type: 'undo' }).ok, true);
  assert.equal(g.phase, 'playing');
  assert.deepEqual(g.points, [24, 0]);
  assert.deepEqual(g.teamSets, [0, 0]);
  assert.equal(g.setResults.length, 0);
});

test('partido a 3 sets con decisivo a 15 y fin de partido', () => {
  const g = makeGame();
  apply(g, { type: 'setConfig', pointsPerSet: 21, totalSets: 3, decidingSetPoints: 15 }, { admin: true });
  score(g, 21, 0); apply(g, { type: 'nextSet' });
  score(g, 0, 21); apply(g, { type: 'nextSet' });
  assert.equal(g.currentSet, 3);
  score(g, 15, 13);
  assert.equal(g.phase, 'matchOver');
  assert.equal(g.matchWinner, 0);
  assert.equal(apply(g, { type: 'nextSet' }).ok, false);
  assert.equal(pt(g, 1).ok, false);
});

test('acciones admin requieren permiso', () => {
  const g = makeGame();
  assert.equal(apply(g, { type: 'setTeams', teams: [{ name: 'X' }, { name: 'Y' }] }).ok, false);
  assert.equal(apply(g, { type: 'setTeams', teams: [{ name: 'leones<script>' }, { name: 'Y', color: '#00ff00' }] }, { admin: true }).ok, true);
  assert.equal(g.teams[0].name, 'LEONESSCRIPT');
  assert.equal(g.teams[1].color, '#00ff00');
  assert.equal(apply(g, { type: 'newMatch' }).ok, false);
});

test('corrección de marcador recalcula set y ganador', () => {
  const g = makeGame();
  apply(g, { type: 'setConfig', totalSets: 5 }, { admin: true }); // mejor de 5
  assert.equal(apply(g, { type: 'setScore', points: [10, 8], sets: [2, 1] }, { admin: true }).ok, true);
  assert.equal(g.currentSet, 4);
  assert.equal(g.phase, 'playing');
  assert.equal(apply(g, { type: 'setScore', points: [0, 0], sets: [3, 1] }, { admin: true }).ok, true);
  assert.equal(g.phase, 'matchOver');
  assert.equal(g.matchWinner, 0);
  assert.equal(apply(g, { type: 'setScore', points: [-1, 0], sets: [0, 0] }, { admin: true }).ok, false);
});

test('reinicio de set y de partido (deshacible)', () => {
  const g = makeGame();
  score(g, 5, 3);
  apply(g, { type: 'resetSet' });
  assert.deepEqual(g.points, [0, 0]);
  score(g, 25, 0); apply(g, { type: 'nextSet' }); score(g, 4, 0);
  apply(g, { type: 'resetMatch' });
  assert.deepEqual([g.points, g.teamSets, g.currentSet], [[0, 0], [0, 0], 1]);
  apply(g, { type: 'undo' });
  assert.deepEqual([g.points, g.teamSets, g.currentSet], [[4, 0], [1, 0], 2]);
});

test('cambio de puntos por set solo en 0-0 (acción del control)', () => {
  const g = makeGame();
  assert.equal(apply(g, { type: 'target', target: 15 }).ok, true);
  pt(g, 0);
  assert.equal(apply(g, { type: 'target', target: 21 }).ok, false);
  assert.equal(g.config.pointsPerSet, 15);
});

test('hydrate tolera datos parciales', () => {
  const g = hydrate({ points: [3, 4], undo: 'x' });
  assert.deepEqual(g.points, [3, 4]);
  assert.deepEqual(g.undo, []);
});

test('nombre por defecto = nombre del color (AZUL / ROJO)', () => {
  const g = makeGame();
  assert.deepEqual(g.teams.map(t => t.name), ['AZUL', 'ROJO']);
  assert.notEqual(g.teams[0].color, g.teams[1].color);
  // Nombre vacío toma el nombre del color elegido.
  apply(g, { type: 'setTeams', teams: [{ name: '', color: '#1f9d55' }, { name: 'Halcones' }] }, { admin: true });
  assert.deepEqual(g.teams.map(t => t.name), ['VERDE', 'HALCONES']);
  // Color fuera de la paleta y sin nombre: «EQUIPO N».
  apply(g, { type: 'setTeams', teams: [{ name: '', color: '#123456' }, { name: 'Halcones' }] }, { admin: true });
  assert.equal(g.teams[0].name, 'EQUIPO 1');
});

function threeTeams(rotation = 'winnerStays') {
  const g = makeGame();
  apply(g, { type: 'setTeams', teams: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] }, { admin: true });
  apply(g, { type: 'setConfig', pointsPerSet: 15, totalSets: 3, decidingSetPoints: 15, rotation }, { admin: true });
  return g;
}

test('3 equipos: cancha inicial y cola', () => {
  const g = threeTeams();
  assert.deepEqual(g.court, [0, 1]);
  assert.deepEqual(g.queue, [2]);
  assert.deepEqual(g.teamSets, [0, 0, 0]);
});

test('3 equipos, ganador se queda: sale el perdedor y entra el siguiente', () => {
  const g = threeTeams();
  score(g, 15, 3); // gana A (lado izq.)
  assert.equal(g.phase, 'setOver');
  apply(g, { type: 'nextSet' }); // por defecto rota
  assert.deepEqual(g.court, [0, 2], 'C entra en el lado de B');
  assert.deepEqual(g.queue, [1]);
  score(g, 2, 15); // gana C (lado der.)
  apply(g, { type: 'nextSet' });
  assert.deepEqual(g.court, [1, 2], 'B entra en el lado de A');
  assert.deepEqual(g.queue, [0]);
  assert.deepEqual(g.teamSets, [1, 0, 1]);
});

test('3 equipos: se puede elegir mismos equipos al confirmar', () => {
  const g = threeTeams();
  score(g, 15, 0);
  apply(g, { type: 'nextSet', rotate: false });
  assert.deepEqual(g.court, [0, 1]);
  assert.deepEqual(g.queue, [2]);
});

test('3 equipos con rotación "none" por defecto mantiene equipos; rotate:true fuerza cambio', () => {
  const g = threeTeams('none');
  score(g, 15, 0);
  apply(g, { type: 'nextSet' });
  assert.deepEqual(g.court, [0, 1]);
  score(g, 0, 15);
  apply(g, { type: 'nextSet', rotate: true });
  assert.deepEqual(g.court, [2, 1], 'pierde A (izq.), entra C');
});

test('3 equipos: no hay fin automático de partido', () => {
  const g = threeTeams();
  for (let i = 0; i < 4; i++) {
    score(g, 15, 0);
    assert.equal(g.phase, 'setOver');
    apply(g, { type: 'nextSet' });
  }
  assert.equal(g.teamSets[0], 4);
});

test('deshacer el inicio de set revierte la rotación', () => {
  const g = threeTeams();
  score(g, 15, 0);
  apply(g, { type: 'nextSet' });
  apply(g, { type: 'undo' });
  assert.deepEqual([g.court, g.queue, g.phase], [[0, 1], [2], 'setOver']);
});

test('reducir de 3 a 2 equipos reacomoda la cancha', () => {
  const g = threeTeams();
  score(g, 15, 0);
  apply(g, { type: 'nextSet' }); // cancha [0,2]
  apply(g, { type: 'setTeams', teams: [{ name: 'A' }, { name: 'B' }] }, { admin: true });
  assert.deepEqual(g.court, [0, 1]);
  assert.deepEqual(g.queue, []);
  assert.deepEqual(g.teamSets, [1, 0]);
});

test('setCourt elige quién juega (solo en 0-0)', () => {
  const g = threeTeams();
  assert.equal(apply(g, { type: 'setCourt', court: [2, 0] }, { admin: true }).ok, true);
  assert.deepEqual([g.court, g.queue], [[2, 0], [1]]);
  apply(g, { type: 'point', team: 0, delta: 1 });
  assert.equal(apply(g, { type: 'setCourt', court: [1, 0] }, { admin: true }).ok, false);
});

test('configuración de voz validada y fuera del deshacer', () => {
  const g = makeGame();
  assert.equal(apply(g, { type: 'setVoice', voice: { enabled: true, rate: 1.2, repeat: 2, interval: 4 } }).ok, false);
  pt(g, 0);
  assert.equal(apply(g, { type: 'setVoice', voice: { enabled: true, rate: 1.2, repeat: 2, interval: 4 } }, { admin: true }).ok, true);
  assert.equal(apply(g, { type: 'setVoice', voice: { enabled: true, rate: 9, repeat: 2, interval: 4 } }, { admin: true }).ok, false);
  apply(g, { type: 'undo' });
  assert.equal(g.voice.enabled, true);
  assert.equal(g.voice.repeat, 2);
});

test('hydrate migra el formato anterior (sets por lado)', () => {
  const g = hydrate({ points: [1, 2], sets: [2, 1], teams: [{ name: 'AZUL', color: '#1e6fd9' }, { name: 'ROJO', color: '#d62f4b' }], config: { pointsPerSet: 21, totalSets: 5, decidingSetPoints: 15 } });
  assert.deepEqual(g.teamSets, [2, 1]);
  assert.deepEqual(g.court, [0, 1]);
  assert.equal(g.config.rotation, 'winnerStays');
  assert.equal(g.voice.enabled, false);
});

test('por defecto partido abierto: 2 equipos sin fin automático', () => {
  const g = makeGame();
  assert.equal(g.config.totalSets, 0);
  for (let i = 0; i < 6; i++) {
    score(g, 25, 0);
    assert.equal(g.phase, 'setOver');
    apply(g, { type: 'nextSet' });
  }
  assert.deepEqual(g.teamSets, [6, 0]);
  assert.equal(g.currentSet, 7);
});

test('opciones de puntos desde options.json: 10, 15, 20, 21, 25', () => {
  const { OPTIONS } = require('../src/volley');
  assert.deepEqual(OPTIONS.pointsPerSet.options.map(o => o.value), [10, 15, 20, 21, 25]);
  assert.equal(OPTIONS.pointsPerSet.default, 25);
  const g = makeGame();
  assert.equal(apply(g, { type: 'setConfig', pointsPerSet: 10 }, { admin: true }).ok, true);
  score(g, 10, 8);
  assert.equal(g.phase, 'setOver');
  assert.equal(apply(g, { type: 'setConfig', pointsPerSet: 30 }, { admin: true }).ok, false);
  assert.equal(apply(g, { type: 'target', target: 20 }).ok, false, 'solo en 0-0');
});
