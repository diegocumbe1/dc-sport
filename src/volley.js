// Lógica pura de voleibol: no depende de Express ni de Socket.IO.
// El servidor aplica comandos sobre el estado de cada sala y difunde el resultado.
//
// Modelo:
// - teams: 2 a 6 equipos { name, color }.
// - court: [i, j] índices de los equipos en cancha (lado izquierdo / derecho).
//   Los comandos de punto usan el LADO (0 = izquierda, 1 = derecha).
// - queue: equipos en espera (con 3 o más equipos).
// - teamSets: sets ganados por equipo (índice de equipo).
// - Partido abierto (por defecto, totalSets = 0): no hay fin automático, se cuentan sets.
//   Con 2 equipos y totalSets 1/3/5 el partido termina al ganar la mayoría.
//   Con 3 o más equipos siempre es abierto: se juega por rotación.

// Las opciones de las listas desplegables viven en un JSON compartido con el cliente.
const OPTIONS = require('../public/config/options.json');
const values = key => OPTIONS[key].options.map(o => o.value);

const POINTS_OPTIONS = values('pointsPerSet');
const DECIDING_OPTIONS = values('decidingSetPoints');
const SETS_OPTIONS = values('totalSets');
const ROTATION_OPTIONS = values('rotation');
const TEAM_COUNTS = values('teamCount');
const MIN_TEAMS = Math.min(...TEAM_COUNTS);
const MAX_TEAMS = Math.max(...TEAM_COUNTS);
const VOICE_REPEAT_MAX = Math.max(...values('voiceRepeat'));
const VOICE_LANGS = values('voiceLang');
const MAX_UNDO = 200;
const MAX_LOG = 100;
const MAX_NAME = 20;
const PALETTE = OPTIONS.teamColors; // [{ value: '#hex', label: 'AZUL' }]
const DEFAULT_CONFIG = {
  pointsPerSet: OPTIONS.pointsPerSet.default,
  totalSets: OPTIONS.totalSets.default,
  decidingSetPoints: OPTIONS.decidingSetPoints.default,
  rotation: OPTIONS.rotation.default,
};
const DEFAULT_VOICE = { enabled: false, rate: 1, repeat: OPTIONS.voiceRepeat.default, interval: 3, lang: OPTIONS.voiceLang.default, v: 2 };

const defaultTeam = i => ({ name: PALETTE[i % PALETTE.length].label, color: PALETTE[i % PALETTE.length].value });
// Nombre por defecto de un equipo sin nombre: el nombre de su color, o «EQUIPO N» si el color no está en la paleta.
const colorName = hex => (PALETTE.find(c => c.value.toLowerCase() === String(hex).toLowerCase()) || {}).label;
const fallbackName = (color, i) => colorName(color) || `EQUIPO ${i + 1}`;

function makeGame(prev) {
  const teams = prev ? prev.teams.map(t => ({ ...t })) : [defaultTeam(0), defaultTeam(1)];
  return {
    teams,
    config: prev ? { ...prev.config } : { ...DEFAULT_CONFIG },
    voice: prev ? { ...prev.voice } : { ...DEFAULT_VOICE },
    court: [0, 1],
    queue: teams.map((_, i) => i).slice(2),
    points: [0, 0],
    teamSets: teams.map(() => 0),
    currentSet: 1,
    // playing | setOver (esperando confirmación del siguiente set) | matchOver
    phase: 'playing',
    serve: null, // lado con el saque: quien ganó el último punto (rally point)
    setWinner: null, // lado ganador del set
    matchWinner: null, // lado ganador del partido (solo con 2 equipos)
    setResults: [],
    undo: [],
    log: prev ? prev.log.slice(-MAX_LOG) : [],
    version: prev ? prev.version : 0,
    updatedAt: Date.now(),
  };
}

const rotationMode = g => g.teams.length > 2; // 3+ equipos: hay cola y rotación
// Partido abierto: sin fin automático (3+ equipos, o totalSets = 0 «sin límite»).
const openMatch = g => rotationMode(g) || !g.config.totalSets;
const setsToWin = g => Math.ceil(g.config.totalSets / 2);
const isDecidingSet = g => !openMatch(g) && g.config.totalSets > 1 && g.currentSet === g.config.totalSets;
const targetPoints = g => (isDecidingSet(g) ? g.config.decidingSetPoints : g.config.pointsPerSet);
const courtSets = g => g.court.map(i => g.teamSets[i]);

// Campos que se guardan en cada instantánea para poder deshacer
// (la voz no: es un ajuste del marcador, no parte del partido).
const SNAP_KEYS = ['teams', 'config', 'court', 'queue', 'points', 'teamSets', 'currentSet', 'phase', 'serve', 'setWinner', 'matchWinner', 'setResults'];
function snapshot(g) {
  return JSON.parse(JSON.stringify(Object.fromEntries(SNAP_KEYS.map(k => [k, g[k]]))));
}
function pushUndo(g, label) {
  g.undo.push({ label, snap: snapshot(g) });
  if (g.undo.length > MAX_UNDO) g.undo.shift();
}
function addLog(g, text, by) {
  g.log.push({ ts: Date.now(), text, by: by || 'control' });
  if (g.log.length > MAX_LOG) g.log.shift();
}

// Revisa si el set actual terminó; si es así, suma el set y cambia de fase.
function evaluateSet(g) {
  if (g.phase !== 'playing') return;
  const [a, b] = g.points;
  if (Math.max(a, b) < targetPoints(g) || Math.abs(a - b) < 2) return;
  const side = a > b ? 0 : 1;
  const team = g.court[side];
  g.teamSets[team]++;
  g.setWinner = side;
  g.setResults.push({ set: g.currentSet, teams: [...g.court], points: [a, b], winner: team });
  if (!openMatch(g) && g.teamSets[team] >= setsToWin(g)) {
    g.phase = 'matchOver';
    g.matchWinner = side;
  } else {
    g.phase = 'setOver';
  }
}

// Ganador se queda: el perdedor va al final de la cola y entra el primero de la cola en su lado.
function rotate(g) {
  if (!g.queue.length || g.setWinner === null) return null;
  const loserSide = 1 - g.setWinner;
  const out = g.court[loserSide];
  const inn = g.queue.shift();
  g.court[loserSide] = inn;
  g.queue.push(out);
  return { out, inn };
}

function cleanName(v, fallback) {
  if (typeof v !== 'string') return fallback;
  const s = v.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, MAX_NAME);
  return s || fallback;
}
const cleanColor = (v, fallback) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : fallback);
const isSide = t => t === 0 || t === 1;
const nonNegInt = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;
const inRange = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

const fail = error => ({ ok: false, error });

// Aplica un comando. Devuelve { ok, error? }. Solo modifica `g` si ok === true.
// `admin` indica que el comando viene autenticado con PIN.
function apply(g, cmd, { admin = false } = {}) {
  if (!cmd || typeof cmd !== 'object') return fail('Comando inválido');
  const by = admin ? 'admin' : 'control';
  const name = i => g.teams[i].name;
  const sideName = s => name(g.court[s]);

  // Los comandos ligados a un set concreto se descartan si llegan tarde
  // (por ejemplo, un toque pendiente que se dispara después de cambiar de set).
  if (cmd.set !== undefined && cmd.set !== g.currentSet) return fail('El set ya cambió; acción ignorada');

  switch (cmd.type) {
    case 'point': {
      const { team: side, delta } = cmd;
      if (!isSide(side) || (delta !== 1 && delta !== -1)) return fail('Punto inválido');
      if (g.phase === 'setOver') return fail('Set terminado: confirma el siguiente set o deshaz');
      if (g.phase === 'matchOver') return fail('Partido terminado');
      if (delta === -1 && g.points[side] === 0) return fail('El puntaje no puede ser negativo');
      pushUndo(g, `${delta > 0 ? '+1' : '−1'} ${sideName(side)}`);
      g.points[side] += delta;
      // Quien gana el rally pasa a sacar. Una resta (corrección) no cambia el saque; deshacer sí lo revierte.
      if (delta > 0) g.serve = side;
      addLog(g, `${delta > 0 ? '+1' : '−1'} ${sideName(side)} (${g.points[0]}-${g.points[1]})`, by);
      evaluateSet(g);
      if (g.phase === 'setOver') addLog(g, `Set ${g.currentSet} para ${sideName(g.setWinner)}`, 'sistema');
      if (g.phase === 'matchOver') addLog(g, `Partido para ${sideName(g.matchWinner)}`, 'sistema');
      break;
    }
    case 'undo': {
      const prev = g.undo.pop();
      if (!prev) return fail('Nada que deshacer');
      Object.assign(g, prev.snap);
      addLog(g, `Deshacer: ${prev.label}`, by);
      break;
    }
    case 'nextSet': {
      if (g.phase !== 'setOver') return fail('El set actual no ha terminado');
      // rotate: true = entra el siguiente equipo; false = mismos equipos; omitido = según config.
      const wantRotate = typeof cmd.rotate === 'boolean' ? cmd.rotate : g.config.rotation === 'winnerStays';
      pushUndo(g, `Inicio set ${g.currentSet + 1}`);
      const change = wantRotate ? rotate(g) : null;
      g.currentSet++;
      g.points = [0, 0];
      g.serve = null; // el primer saque del set se define con el primer punto
      g.phase = 'playing';
      g.setWinner = null;
      addLog(g, `Comienza el set ${g.currentSet}${change ? `: entra ${name(change.inn)}, sale ${name(change.out)}` : ''}`, by);
      break;
    }
    case 'resetSet': {
      if (g.phase !== 'playing') return fail('El set ya terminó; usa deshacer');
      if (g.points[0] === 0 && g.points[1] === 0) return fail('El set ya está en 0-0');
      pushUndo(g, `Reinicio set ${g.currentSet}`);
      g.points = [0, 0];
      g.serve = null;
      addLog(g, `Puntos del set ${g.currentSet} reiniciados`, by);
      break;
    }
    case 'resetMatch': {
      // Conserva equipos, configuración y bitácora; permite deshacer el reinicio.
      pushUndo(g, 'Reinicio de partido');
      const keepUndo = g.undo;
      Object.assign(g, makeGame(g));
      g.undo = keepUndo;
      addLog(g, 'Partido reiniciado', by);
      break;
    }
    case 'target': {
      // Acción heredada del control original: solo con el set en 0-0.
      if (!POINTS_OPTIONS.includes(cmd.target)) return fail('Puntos por set inválidos');
      if (g.points.some(x => x !== 0)) return fail('Solo se puede cambiar con el set en 0-0');
      pushUndo(g, 'Cambio de puntos por set');
      g.config.pointsPerSet = cmd.target;
      addLog(g, `Sets a ${cmd.target} puntos`, by);
      break;
    }

    // ---- Acciones administrativas (requieren PIN) ----
    case 'setTeams': {
      if (!admin) return fail('Requiere PIN de administración');
      const list = cmd.teams;
      if (!Array.isArray(list) || list.length < MIN_TEAMS || list.length > MAX_TEAMS) return fail(`Entre ${MIN_TEAMS} y ${MAX_TEAMS} equipos`);
      pushUndo(g, 'Cambio de equipos');
      const n = list.length;
      g.teams = list.map((t, i) => {
        const base = g.teams[i] || defaultTeam(i);
        const color = cleanColor(t && t.color, base.color);
        return { name: cleanName(t && t.name, fallbackName(color, i)).toUpperCase(), color };
      });
      g.teamSets = g.teams.map((_, i) => g.teamSets[i] || 0);
      // Si sobran o faltan equipos, se reordena la cancha y la cola sin perder el orden existente.
      const court = g.court.filter(i => i < n);
      const queue = g.queue.filter(i => i < n && !court.includes(i));
      for (let i = 0; i < n; i++) if (!court.includes(i) && !queue.includes(i)) queue.push(i);
      while (court.length < 2) court.push(queue.shift());
      g.court = court;
      g.queue = queue;
      if (!openMatch(g) && g.phase === 'setOver' && g.teamSets[g.court[g.setWinner]] >= setsToWin(g)) {
        g.phase = 'matchOver';
        g.matchWinner = g.setWinner;
      } else if (openMatch(g) && g.phase === 'matchOver') {
        g.phase = 'setOver';
        g.setWinner = g.matchWinner;
        g.matchWinner = null;
      }
      addLog(g, `Equipos: ${g.teams.map(t => t.name).join(', ')}`, by);
      break;
    }
    case 'setCourt': {
      if (!admin) return fail('Requiere PIN de administración');
      const c = cmd.court;
      if (!Array.isArray(c) || c.length !== 2 || !c.every(i => Number.isInteger(i) && i >= 0 && i < g.teams.length) || c[0] === c[1]) return fail('Selección de equipos inválida');
      if (g.phase !== 'playing' || g.points.some(p => p !== 0)) return fail('Solo con el set en 0-0');
      pushUndo(g, 'Cambio de equipos en cancha');
      g.court = [...c];
      g.serve = null;
      g.queue = [...g.queue.filter(i => !c.includes(i)), ...g.teams.map((_, i) => i).filter(i => !c.includes(i) && !g.queue.includes(i))];
      addLog(g, `En cancha: ${name(c[0])} vs ${name(c[1])}`, by);
      break;
    }
    case 'setConfig': {
      if (!admin) return fail('Requiere PIN de administración');
      // Campos omitidos conservan su valor actual (la UI hoy no muestra «mejor de N»).
      const keep = (k) => (cmd[k] === undefined ? g.config[k] : cmd[k]);
      const pointsPerSet = keep('pointsPerSet');
      const totalSets = keep('totalSets');
      const decidingSetPoints = keep('decidingSetPoints');
      const rotation = keep('rotation');
      if (!POINTS_OPTIONS.includes(pointsPerSet)) return fail('Puntos por set inválidos');
      if (!SETS_OPTIONS.includes(totalSets)) return fail('Cantidad de sets inválida');
      if (!DECIDING_OPTIONS.includes(decidingSetPoints)) return fail('Puntos del set decisivo inválidos');
      if (!ROTATION_OPTIONS.includes(rotation)) return fail('Rotación inválida');
      const need = Math.ceil(totalSets / 2);
      const willBeOpen = rotationMode(g) || !totalSets;
      if (!willBeOpen) {
        if (Math.max(...g.teamSets) > need) return fail('Ya hay más sets ganados que los necesarios para ese formato');
        if (g.currentSet > totalSets) return fail('El partido ya superó esa cantidad de sets');
      }
      pushUndo(g, 'Cambio de configuración');
      g.config = { pointsPerSet, totalSets, decidingSetPoints, rotation };
      // Si el formato cambió, el partido puede quedar decidido o reabierto.
      if (openMatch(g) && g.phase === 'matchOver') {
        g.phase = 'setOver';
        g.setWinner = g.matchWinner;
        g.matchWinner = null;
      } else if (!openMatch(g)) {
        if (g.phase === 'matchOver' && Math.max(...g.teamSets) < need) {
          g.phase = 'setOver';
          g.setWinner = g.matchWinner;
          g.matchWinner = null;
        } else if (g.phase === 'setOver' && g.teamSets[g.court[g.setWinner]] >= need) {
          g.phase = 'matchOver';
          g.matchWinner = g.setWinner;
        }
      }
      evaluateSet(g);
      addLog(g, `Config: sets a ${pointsPerSet}, mejor de ${totalSets}, decisivo a ${decidingSetPoints}, rotación ${rotation === 'winnerStays' ? 'ganador se queda' : 'mismos equipos'}`, by);
      break;
    }
    case 'setVoice': {
      if (!admin) return fail('Requiere PIN de administración');
      const v = cmd.voice || {};
      if (typeof v.enabled !== 'boolean') return fail('Voz: valor inválido');
      if (!inRange(v.rate, 0.5, 2)) return fail('Velocidad entre 0.5 y 2');
      if (!nonNegInt(v.repeat, VOICE_REPEAT_MAX) || v.repeat < 1) return fail(`Repeticiones entre 1 y ${VOICE_REPEAT_MAX}`);
      if (!inRange(v.interval, 1, 30)) return fail('Intervalo entre 1 y 30 segundos');
      const lang = VOICE_LANGS.includes(v.lang) ? v.lang : DEFAULT_VOICE.lang;
      g.voice = { enabled: v.enabled, rate: Math.round(v.rate * 10) / 10, repeat: v.repeat, interval: v.interval, lang, v: 2 };
      addLog(g, `Voz ${v.enabled ? `activada (x${v.repeat}, cada ${v.interval} s, vel. ${g.voice.rate})` : 'desactivada'}`, by);
      break;
    }
    case 'setScore': {
      if (!admin) return fail('Requiere PIN de administración');
      const { points } = cmd;
      // teamSets: sets por equipo. `sets` (por lado) se acepta por compatibilidad.
      let teamSets = cmd.teamSets;
      if (!teamSets && Array.isArray(cmd.sets) && cmd.sets.length === 2) {
        teamSets = [...g.teamSets];
        teamSets[g.court[0]] = cmd.sets[0];
        teamSets[g.court[1]] = cmd.sets[1];
      }
      const maxSets = openMatch(g) ? 99 : setsToWin(g);
      if (!Array.isArray(points) || points.length !== 2 || !points.every(p => nonNegInt(p, 99))) return fail('Puntos inválidos');
      if (!Array.isArray(teamSets) || teamSets.length !== g.teams.length || !teamSets.every(s => nonNegInt(s, maxSets))) return fail('Sets inválidos');
      if (!openMatch(g) && teamSets.filter(s => s >= setsToWin(g)).length > 1) return fail('Ambos equipos no pueden ganar el partido');
      pushUndo(g, 'Corrección de marcador');
      g.points = [...points];
      g.serve = null;
      g.teamSets = [...teamSets];
      g.currentSet = teamSets.reduce((a, b) => a + b, 0) + 1;
      g.setResults = g.setResults.filter(r => r.set < g.currentSet);
      g.setWinner = null;
      g.matchWinner = null;
      g.phase = 'playing';
      const won = openMatch(g) ? -1 : g.court.findIndex(i => g.teamSets[i] >= setsToWin(g));
      if (won !== -1) {
        g.phase = 'matchOver';
        g.matchWinner = won;
        g.currentSet--;
      } else {
        evaluateSet(g);
      }
      addLog(g, `Marcador corregido: ${points.join('-')} · sets ${g.teams.map((t, i) => `${t.name} ${teamSets[i]}`).join(', ')}`, by);
      break;
    }
    case 'newMatch': {
      if (!admin) return fail('Requiere PIN de administración');
      Object.assign(g, makeGame(g));
      addLog(g, 'Nuevo partido', by);
      break;
    }
    default:
      return fail('Comando desconocido');
  }
  g.version++;
  g.updatedAt = Date.now();
  return { ok: true };
}

// Estado que se envía a los clientes (sin la pila interna de deshacer).
// `teams` y `sets` están en orden de LADO (izquierda, derecha) para que las vistas
// no tengan que conocer la rotación; `allTeams`/`teamSets` traen la lista completa.
function publicState(room, g) {
  const nextIn = g.queue.length ? g.queue[0] : null;
  return {
    room,
    teams: g.court.map(i => g.teams[i]),
    sets: courtSets(g),
    court: g.court,
    queue: g.queue,
    allTeams: g.teams,
    teamSets: g.teamSets,
    rotationMode: rotationMode(g),
    openMatch: openMatch(g),
    nextIn,
    config: g.config,
    voice: g.voice,
    points: g.points,
    serve: g.serve,
    currentSet: g.currentSet,
    target: targetPoints(g),
    decidingSet: isDecidingSet(g),
    setsToWin: setsToWin(g),
    phase: g.phase,
    setWinner: g.setWinner,
    matchWinner: g.matchWinner,
    setResults: g.setResults,
    canUndo: g.undo.length > 0,
    lastUndo: g.undo.length ? g.undo[g.undo.length - 1].label : null,
    log: g.log.slice(-30),
    version: g.version,
    updatedAt: g.updatedAt,
  };
}

// Tablero sin juego todavía: se puede configurar desde el inicio sin PIN.
function isPristine(g) {
  return g.currentSet === 1 && g.phase === 'playing' && g.points.every(p => p === 0) && g.teamSets.every(s => s === 0);
}

// Repara estados cargados desde disco (versiones previas o archivo editado a mano).
function hydrate(raw) {
  const g = makeGame();
  if (!raw || typeof raw !== 'object') return g;
  for (const k of Object.keys(g)) if (raw[k] !== undefined) g[k] = raw[k];
  // Formato anterior: `sets` por lado y sin cancha/cola.
  if (!Array.isArray(raw.teamSets)) g.teamSets = Array.isArray(raw.sets) ? [...raw.sets] : g.teams.map(() => 0);
  if (!Array.isArray(raw.court)) g.court = [0, 1];
  if (!Array.isArray(raw.queue)) g.queue = g.teams.map((_, i) => i).slice(2);
  g.config = { ...makeGame().config, ...g.config };
  g.voice = { ...DEFAULT_VOICE, ...g.voice };
  // Migración única: antes el idioma por defecto era es-ES; ahora es es-CO.
  if (!g.voice.v) {
    if (g.voice.lang === 'es-ES') g.voice.lang = DEFAULT_VOICE.lang;
    g.voice.v = 2;
  }
  if (!Array.isArray(g.undo)) g.undo = [];
  if (!Array.isArray(g.log)) g.log = [];
  return g;
}

module.exports = { makeGame, apply, publicState, hydrate, isPristine, targetPoints, OPTIONS };
