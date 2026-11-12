const test = require('node:test');
const assert = require('node:assert/strict');
const { makeGame, apply, hydrate, publicState } = require('../src/volley');

const pt = (g, team, delta = 1) => apply(g, { type: 'point', team, delta });
function score(g, a, b) {
  for (let i = 0; i < a; i++) pt(g, 0);
  for (let i = 0; i < b; i++) pt(g, 1);
}

test('sala de torneo: el control no reinicia el partido ni cambia las reglas; el admin sí', () => {
  const g = makeGame();
  g.torneo = true;
  score(g, 3, 1);
  assert.equal(apply(g, { type: 'resetMatch' }).ok, false);
  assert.deepEqual(g.points, [3, 1]);
  assert.equal(apply(g, { type: 'target', target: 15 }).ok, false);
  assert.equal(makeGame(g).torneo, true);
  assert.equal(apply(g, { type: 'resetMatch' }, { admin: true }).ok, true);
  assert.deepEqual(g.points, [0, 0]);
  assert.equal(g.torneo, true);
  assert.equal(hydrate(JSON.parse(JSON.stringify(g))).torneo, true);
});

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
  score(g, 21, 0); apply(g, { type: 'nextSet' }); // gana A; A pasa a la derecha
  score(g, 21, 0); apply(g, { type: 'nextSet' }); // gana B (izq.); vuelven a sus lados
  assert.equal(g.currentSet, 3);
  assert.deepEqual(g.teamSets, [1, 1]);
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

test('2 equipos: cambian de lado en cada set y los puntos siguen al lado correcto', () => {
  const g = makeGame();
  score(g, 25, 10); // gana A (izq.)
  apply(g, { type: 'nextSet' });
  assert.deepEqual(g.court, [1, 0], 'B pasa a la izquierda');
  assert.deepEqual(publicState('x', g).sets, [0, 1], 'los sets siguen a su equipo');
  apply(g, { type: 'point', team: 0, delta: 1 });
  assert.equal(g.log[g.log.length - 1].text.includes(g.teams[1].name), true, 'el punto del lado izq. es de B');
  apply(g, { type: 'undo' }); apply(g, { type: 'undo' });
  assert.deepEqual([g.court, g.phase], [[0, 1], 'setOver'], 'deshacer devuelve los lados');
});

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
  assert.deepEqual(g.court, [1, 0], 'mismos equipos: cambian de lado');
  assert.deepEqual(g.queue, [2]);
});

test('3 equipos con rotación "none" por defecto mantiene equipos; rotate:true fuerza cambio', () => {
  const g = threeTeams('none');
  score(g, 15, 0);
  apply(g, { type: 'nextSet' });
  assert.deepEqual(g.court, [1, 0], 'mismos equipos: cambian de lado');
  score(g, 15, 0);
  apply(g, { type: 'nextSet', rotate: true });
  assert.deepEqual(g.court, [1, 2], 'pierde A (der.), entra C');
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
  assert.equal(g.voice.enabled, true); // voz activa por defecto
});

test('por defecto partido abierto: 2 equipos sin fin automático', () => {
  const g = makeGame();
  assert.equal(g.config.totalSets, 0);
  for (let i = 0; i < 6; i++) {
    score(g, 25, 0); // gana siempre el lado izquierdo; los equipos alternan de lado
    assert.equal(g.phase, 'setOver');
    apply(g, { type: 'nextSet' });
  }
  assert.deepEqual(g.teamSets, [3, 3]);
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

test('saque: lo tiene quien ganó el último punto; deshacer lo revierte; nuevo set lo limpia', () => {
  const g = makeGame();
  assert.equal(g.serve, null);
  pt(g, 1);
  assert.equal(g.serve, 1);
  pt(g, 0);
  assert.equal(g.serve, 0);
  apply(g, { type: 'undo' });
  assert.equal(g.serve, 1, 'deshacer devuelve el saque');
  pt(g, 1, -1);
  assert.equal(g.serve, 1, 'una resta no cambia el saque');
  score(g, 25, 0);
  apply(g, { type: 'nextSet' });
  assert.equal(g.serve, null);
});

// Lleva el set a un empate a `n` alternando puntos (sin que nadie gane antes).
function tie(g, n) { for (let i = 0; i < n; i++) { pt(g, 0); pt(g, 1); } }
const withOvertime = overtime => {
  const g = makeGame();
  assert.equal(apply(g, { type: 'setConfig', pointsPerSet: 10, overtime }, { admin: true }).ok, true);
  return g;
};

test('alargue sin tope (por defecto): se gana por 2', () => {
  const g = makeGame();
  assert.equal(g.config.overtime, 99);
  apply(g, { type: 'setConfig', pointsPerSet: 10 }, { admin: true });
  tie(g, 9); pt(g, 0);
  assert.equal(g.phase, 'playing', '10-9 no cierra');
  pt(g, 1); tie(g, 5); pt(g, 0);
  assert.equal(g.phase, 'playing', '16-15 no cierra');
  pt(g, 0);
  assert.equal(g.phase, 'setOver');
  assert.equal(publicState('x', g).maxPoints, null);
});

test('muerte súbita: 10-9 termina el set', () => {
  const g = withOvertime(0);
  tie(g, 9); pt(g, 0);
  assert.deepEqual([g.points, g.phase, g.setWinner], [[10, 9], 'setOver', 0]);
  assert.equal(publicState('x', g).maxPoints, 10);
});

test('alargue con tope +2: a 10 se gana por 2 hasta llegar a 12', () => {
  const g = withOvertime(2);
  tie(g, 9); pt(g, 0);
  assert.equal(g.phase, 'playing', '10-9 sigue');
  pt(g, 1); pt(g, 1);
  assert.equal(g.phase, 'playing', '10-11 sigue');
  pt(g, 0); pt(g, 1);
  assert.deepEqual([g.points, g.phase, g.setWinner], [[11, 12], 'setOver', 1], 'al tope gana por 1');
});

test('alargue: valor inválido rechazado; salas viejas toman el predeterminado', () => {
  const g = makeGame();
  assert.equal(apply(g, { type: 'setConfig', overtime: 3 }, { admin: true }).ok, false);
  const old = hydrate({ config: { pointsPerSet: 15, totalSets: 0, decidingSetPoints: 15, rotation: 'none' }, voice: { enabled: true, lang: 'en-US', v: 2 } });
  assert.equal(old.config.overtime, 99);
  assert.equal(old.voice.lang, 'es-CO', 'la voz siempre en español');
});

// ---------- Orden de saque ----------
const withOrder = (first = 0, orders = [[5, 8, 21, 0, 10], [1, 0, 34, 10, 6]]) => {
  const g = makeGame();
  assert.equal(apply(g, { type: 'setServeOrder', orders, first }, { admin: true }).ok, true);
  return g;
};
const saca = g => { const s = publicState('x', g); return [s.serve, s.serveNumber]; };

test('orden de saque: el número solo avanza cuando el equipo recupera el saque', () => {
  const g = withOrder();
  assert.deepEqual(saca(g), [0, 5], 'empieza el primero del equipo que saca');
  pt(g, 0);
  assert.deepEqual(saca(g), [0, 5], 'si gana quien saca, sigue el mismo');
  pt(g, 1);
  assert.deepEqual(saca(g), [1, 1], 'el que recibía empieza por el primero de su lista');
  pt(g, 1);
  assert.deepEqual(saca(g), [1, 1]);
  pt(g, 0);
  assert.deepEqual(saca(g), [0, 8], 'al recuperar el saque pasa al siguiente');
  pt(g, 1);
  assert.deepEqual(saca(g), [1, 0], 'la camiseta 0 es válida');
});

test('orden de saque: la lista vuelve a empezar al terminar', () => {
  const g = withOrder(0, [[5, 8], [1, 2]]);
  const seen = [];
  for (let i = 0; i < 6; i++) { pt(g, i % 2 === 0 ? 1 : 0); seen.push(saca(g)[1]); }
  assert.deepEqual(seen, [1, 8, 2, 5, 1, 8]);
});

test('orden de saque: deshacer y restar corrigen quién saca', () => {
  const g = withOrder();
  pt(g, 1);
  assert.deepEqual(saca(g), [1, 1]);
  apply(g, { type: 'undo' });
  assert.deepEqual(saca(g), [0, 5], 'deshacer');
  pt(g, 1);
  pt(g, 1, -1);
  assert.deepEqual(saca(g), [0, 5], 'restar el último punto');
  pt(g, 0);
  pt(g, 1);
  pt(g, 0, -1);
  assert.deepEqual(saca(g), [1, 1], 'restar a otro equipo no cambia el saque');
});

test('orden de saque: cada set reinicia la lista y alterna quién saca primero', () => {
  const g = withOrder();
  g.config.pointsPerSet = 10;
  score(g, 10, 0);
  apply(g, { type: 'nextSet' });
  assert.deepEqual(g.court, [1, 0], 'cambian de lado');
  assert.deepEqual(saca(g), [0, 1], 'saca primero el equipo que recibió, ahora a la izquierda');
  score(g, 10, 0);
  apply(g, { type: 'nextSet' });
  assert.deepEqual(saca(g), [0, 5], 'tercer set: los equipos vuelven a su lado y saca el primero');
});

test('orden de saque: se elige quién saca primero y se puede cambiar en 0-0', () => {
  const g = withOrder(1);
  assert.deepEqual(saca(g), [1, 1]);
  assert.equal(apply(g, { type: 'swapServe' }).ok, true);
  assert.deepEqual(saca(g), [0, 5]);
  pt(g, 0);
  assert.equal(apply(g, { type: 'swapServe' }).ok, false, 'no con puntos');
  apply(g, { type: 'undo' });
  apply(g, { type: 'undo' });
  assert.deepEqual(saca(g), [1, 1], 'deshacer revierte el cambio');
});

test('orden de saque: opcional y por equipo', () => {
  const none = makeGame();
  assert.equal(publicState('x', none).hasServeOrder, false);
  assert.equal(none.serve, null);
  assert.equal(apply(none, { type: 'swapServe' }).ok, false);
  const one = withOrder(0, [[], [7]]);
  assert.deepEqual(saca(one), [0, null], 'equipo sin lista: se sabe el lado, sin número');
  pt(one, 1);
  assert.deepEqual(saca(one), [1, 7]);
});

test('orden de saque: reinicios y corrección de marcador', () => {
  const g = withOrder(1);
  pt(g, 0); pt(g, 1);
  apply(g, { type: 'resetSet' });
  assert.deepEqual(saca(g), [1, 1], 'reiniciar set');
  pt(g, 0);
  apply(g, { type: 'resetMatch' });
  assert.deepEqual(saca(g), [1, 1], 'reiniciar partido conserva lista y equipo que saca primero');
  pt(g, 0);
  apply(g, { type: 'setScore', points: [3, 2], teamSets: [0, 0] }, { admin: true });
  assert.deepEqual(saca(g), [0, 5], 'corregir el marcador no borra quién saca');
});

test('orden de saque: validaciones y permisos', () => {
  const g = makeGame();
  const set = (orders, first, opts = { admin: true }) => apply(g, { type: 'setServeOrder', orders, first }, opts).ok;
  assert.equal(set([[1]], 0, {}), false, 'requiere PIN');
  assert.equal(set([[100]], 0), false);
  assert.equal(set([[-1]], 0), false);
  assert.equal(set([[1.5]], 0), false);
  assert.equal(set(['5 8'], 0), false);
  assert.equal(set([Array(13).fill(1)], 0), false);
  assert.equal(set([[1], [2], [3]], 0), false, 'más listas que equipos');
  assert.equal(set([[1]], 2), false);
  pt(g, 0);
  assert.equal(set([[1]], 0), false, 'solo antes de iniciar');
});

test('orden de saque: el juez lo define sin PIN solo antes de iniciar', () => {
  const g = makeGame();
  assert.equal(apply(g, { type: 'serveOrder', orders: [[3, 7, 9], [2, 4]], first: 1 }, {}).ok, true);
  assert.deepEqual(g.teams[0].serveOrder, [3, 7, 9]);
  assert.equal(g.setServer, 1);
  assert.equal(apply(g, { type: 'serveOrder', orders: [[1]], first: 0 }, {}).ok, true, 'se puede corregir mientras 0-0');
  pt(g, 0);
  assert.equal(apply(g, { type: 'serveOrder', orders: [[1]], first: 0 }, {}).ok, false, 'ya inició');
});

test('orden de saque: se conserva al guardar y cargar, y al renombrar equipos', () => {
  const g = withOrder();
  pt(g, 1);
  const loaded = hydrate(JSON.parse(JSON.stringify(g)));
  assert.deepEqual(saca(loaded), [1, 1]);
  apply(loaded, { type: 'setTeams', teams: [{ name: 'Leones' }, { name: 'Tigres' }] }, { admin: true });
  assert.deepEqual(loaded.teams[0].serveOrder, [5, 8, 21, 0, 10]);
});

// ---------- Finalizar partido ----------
test('finalizar: cierra el partido y bloquea los puntos', () => {
  const g = makeGame();
  g.config.pointsPerSet = 10;
  assert.equal(apply(g, { type: 'endMatch' }).ok, false, 'sin haber jugado');
  score(g, 10, 0);
  assert.equal(g.phase, 'setOver');
  assert.equal(apply(g, { type: 'endMatch' }).ok, true);
  assert.equal(g.phase, 'finished');
  assert.equal(g.openSet, null, 'el set cerrado no queda a medias');
  assert.equal(pt(g, 0).ok, false);
  assert.equal(apply(g, { type: 'nextSet' }).ok, false);
  assert.equal(apply(g, { type: 'endMatch' }).ok, false, 'no dos veces');
});

test('finalizar: un set a medias queda registrado sin contar', () => {
  const g = makeGame();
  score(g, 3, 2);
  apply(g, { type: 'endMatch' });
  const s = publicState('x', g);
  assert.deepEqual(s.openSet, { set: 1, teams: [0, 1], points: [3, 2] });
  assert.deepEqual(s.teamSets, [0, 0]);
  assert.deepEqual(s.setResults, []);
});

test('finalizar: se reanuda con deshacer y nuevo partido limpia', () => {
  const g = makeGame();
  score(g, 3, 2);
  apply(g, { type: 'endMatch' });
  apply(g, { type: 'undo' });
  assert.equal(g.phase, 'playing');
  assert.equal(g.openSet, null);
  assert.deepEqual(g.points, [3, 2]);
  assert.equal(pt(g, 0).ok, true);
  apply(g, { type: 'endMatch' });
  apply(g, { type: 'resetMatch' });
  assert.equal(g.phase, 'playing');
  assert.equal(g.openSet, null);
  assert.deepEqual(g.points, [0, 0]);
});

test('finalizar: se conserva al guardar y cargar', () => {
  const g = makeGame();
  score(g, 3, 2);
  apply(g, { type: 'endMatch' });
  const loaded = hydrate(JSON.parse(JSON.stringify(g)));
  assert.equal(loaded.phase, 'finished');
  assert.deepEqual(loaded.openSet.points, [3, 2]);
});

test('voz: el control cambia quién habla y nombre/color sin deshacer ni PIN', () => {
  const g = makeGame();
  assert.equal(g.voice.speaker, 'co-f');
  assert.equal(g.voice.announce, 'name');
  assert.equal(apply(g, { type: 'setVoiceStyle', speaker: 'co-m' }).ok, true);
  assert.equal(apply(g, { type: 'setVoiceStyle', announce: 'color' }).ok, true);
  assert.deepEqual([g.voice.speaker, g.voice.announce], ['co-m', 'color']);
  assert.equal(g.undo.length, 0);
  assert.equal(apply(g, { type: 'setVoiceStyle', announce: 'grito' }).ok, false);
  // Salas guardadas antes de esta opción: toman los valores por defecto.
  const old = hydrate({ ...makeGame(), voice: { enabled: true, rate: 1, repeat: 1, interval: 3, lang: 'es-CO', v: 2 } });
  assert.deepEqual([old.voice.speaker, old.voice.announce], ['co-f', 'name']);
});
