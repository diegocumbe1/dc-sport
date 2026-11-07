// Utilidades compartidas por marcador, control y admin.
(function () {
  const params = new URLSearchParams(location.search);

  // ---------- Caché local con vencimiento (máx. 4 horas) ----------
  // Sin base de datos en el navegador: solo localStorage, y cada valor caduca.
  const LOCAL_TTL_MS = 4 * 3600 * 1000;
  const PREFIX = 'dc:';
  const local = {
    get(key) {
      try {
        const raw = localStorage.getItem(PREFIX + key);
        if (!raw) return null;
        const { v, exp } = JSON.parse(raw);
        if (!exp || Date.now() > exp) { localStorage.removeItem(PREFIX + key); return null; }
        return v;
      } catch { return null; }
    },
    set(key, value, ttl = LOCAL_TTL_MS) {
      try { localStorage.setItem(PREFIX + key, JSON.stringify({ v: value, exp: Date.now() + Math.min(ttl, LOCAL_TTL_MS) })); } catch {}
    },
    remove(key) { try { localStorage.removeItem(PREFIX + key); } catch {} },
    // Borra todo lo que guarda la app en este navegador.
    clear() {
      try {
        Object.keys(localStorage).filter(k => k.startsWith(PREFIX) || k.startsWith('dc-')).forEach(k => localStorage.removeItem(k));
        sessionStorage.clear();
      } catch {}
    },
    purgeExpired() {
      try { Object.keys(localStorage).filter(k => k.startsWith(PREFIX)).forEach(k => local.get(k.slice(PREFIX.length))); } catch {}
    },
  };
  local.purgeExpired();

  function cleanRoom(v) {
    return String(v || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
  }
  const room = cleanRoom(params.get('sala')) || local.get('room') || 'voley';
  if (room.length < 3) location.replace(location.pathname + '?sala=voley');
  else if (params.get('sala')) local.set('room', room);

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  // Conecta a la sala. El servidor es la fuente de verdad: cada cambio llega como 'state'.
  // role: 'marcador' | 'control' | 'admin'; team: 0 | 1 | null (control de un solo equipo).
  function connect({ role, team = null, onState, onConnection, onPresence } = {}) {
    const socket = io({
      // WebSocket primero: evita la página de aviso de ngrok en el long-polling.
      transports: ['websocket', 'polling'],
      tryAllTransports: true,
      extraHeaders: { 'ngrok-skip-browser-warning': '1' },
    });
    let version = -1;
    let joined = false;

    let retry = null;
    function join() {
      clearTimeout(retry);
      socket.emit('join', { room, role, team }, res => {
        joined = !!(res && res.ok);
        onConnection && onConnection(joined ? 'online' : res && res.full ? 'full' : 'error', res && res.error);
        // Sala llena: reintentar cada 5 s por si se libera un lugar.
        if (!joined && res && res.full) retry = setTimeout(() => socket.connected && join(), 5000);
      });
    }
    socket.on('connect', () => {
      version = -1; // el servidor pudo reiniciarse: aceptar su estado tal cual
      // Al (re)conectar se vuelve a unir a la sala y recibe el estado completo.
      join();
    });
    socket.on('disconnect', () => {
      joined = false;
      clearTimeout(retry);
      onConnection && onConnection('offline');
    });
    socket.io.on('reconnect_attempt', () => onConnection && onConnection('connecting'));
    socket.on('state', s => {
      // Descarta estados viejos que lleguen desordenados (misma sala).
      if (s.version < version) return;
      version = s.version;
      local.set('state:' + room, s);
      onState && onState(s);
    });
    // Mientras conecta, muestra el último estado conocido (si tiene menos de 4 h).
    // El servidor sigue siendo la fuente de verdad y lo reemplaza al llegar.
    const cached = local.get('state:' + room);
    if (cached && onState) setTimeout(() => { if (version === -1) onState(cached); }, 0);
    socket.on('presence', p => onPresence && onPresence(p));

    function send(cmd) {
      if (!socket.connected || !joined) return Promise.resolve({ ok: false, error: 'Sin conexión con el servidor' });
      // Sin conexión no se encola nada: así no se aplican toques viejos al reconectar.
      return socket.timeout(5000).emitWithAck('command', { ...cmd, id: uid() })
        .catch(() => ({ ok: false, error: 'El servidor no respondió' }));
    }
    function call(event, payload) {
      if (!socket.connected) return Promise.resolve({ ok: false, error: 'Sin conexión con el servidor' });
      return socket.timeout(5000).emitWithAck(event, payload).catch(() => ({ ok: false, error: 'El servidor no respondió' }));
    }
    return { socket, send, call };
  }

  function toast(text, kind) {
    let box = document.getElementById('toasts');
    if (!box) {
      box = document.createElement('div');
      box.id = 'toasts';
      document.body.appendChild(box);
    }
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = text;
    box.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  // Pinta el indicador de conexión estándar (<span class="conn">).
  function renderConnection(el, status, error) {
    const labels = { online: 'En vivo', offline: 'Sin conexión', connecting: 'Reconectando…', error: error || 'Error', full: 'Sala llena' };
    if ((status === 'full' || status === 'error') && el.dataset.error !== error) toast(error || labels[status], 'bad');
    el.dataset.error = error || '';
    el.dataset.status = status;
    el.textContent = labels[status] || status;
    document.body.classList.toggle('is-offline', status !== 'online');
  }

  function urlFor(view, base, extra) {
    return (base || location.origin) + '/' + view + '?sala=' + encodeURIComponent(room) + (extra || '');
  }
  // ?equipo=a | b  →  0 | 1 ; cualquier otro valor → null (control de ambos equipos)
  const teamParam = { a: 0, b: 1, '1': 0, '2': 1 }[String(params.get('equipo') || '').toLowerCase()];
  const team = teamParam === undefined ? null : teamParam;

  // ---------- Voz (Web Speech API, sin servicios externos) ----------
  // Anuncia `text` según la config de la sala: velocidad, repeticiones e intervalo (s).
  // Un anuncio nuevo cancela las repeticiones pendientes del anterior.
  let voiceTimer = null;
  const voiceSupported = 'speechSynthesis' in window;

  // Orden de preferencia de acentos: para Colombia, primero es-CO y luego otras voces latinoamericanas.
  const LANG_CHAINS = {
    'es-CO': ['es-CO', 'es-419', 'es-US', 'es-MX', 'es'],
    'es-MX': ['es-MX', 'es-419', 'es-US', 'es-CO', 'es'],
    'es-US': ['es-US', 'es-419', 'es-MX', 'es-CO', 'es'],
  };
  // Voces que suelen sonar naturales (neuronales / en línea / mejoradas) y voces "de efecto" a evitar.
  const NATURAL_RE = /natural|neural|online|premium|enhanced|mejorad|google|siri/i;
  const NOVELTY_RE = /eddy|flo\b|grandma|grandpa|reed|rocko|sandy|shelley|bad news|bells|boing|bubbles|cellos|jester|organ|superstar|trinoids|whisper|wobble|zarvox|albert|fred|junior|ralph|kathy/i;
  const normLang = l => String(l || '').replace('_', '-');

  function voiceScore(v, lang) {
    const chain = LANG_CHAINS[lang] || [lang, lang.slice(0, 2)];
    const vl = normLang(v.lang);
    let idx = chain.findIndex(c => vl === c || (c.length === 2 && vl.slice(0, 2) === c));
    if (idx === -1) return -1; // otro idioma
    let score = (chain.length - idx) * 100;
    if (NATURAL_RE.test(v.name)) score += 60;
    if (NOVELTY_RE.test(v.name)) score -= 80;
    if (!v.localService) score += 10; // las voces en línea suelen ser más naturales
    return score;
  }
  // Voces disponibles en ESTE dispositivo para el idioma, de mejor a peor.
  function listVoices(lang = 'es-CO') {
    if (!voiceSupported) return [];
    return speechSynthesis.getVoices()
      .map(v => ({ v, score: voiceScore(v, lang) }))
      .filter(x => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map(x => ({ voice: x.v, name: x.v.name, lang: normLang(x.v.lang), natural: NATURAL_RE.test(x.v.name), score: x.score }));
  }
  // Voz por defecto cuando el dispositivo la tiene (Chrome): «Google español» (es-ES).
  const DEFAULT_VOICE_NAME = 'Google español';
  // La voz elegida a mano en este dispositivo (DC.local 'voiceName') tiene prioridad;
  // luego la voz por defecto, y si no existe, la mejor según el idioma de la sala.
  function pickVoice(lang) {
    const list = listVoices(lang);
    const chosen = local.get('voiceName');
    return (chosen && list.find(x => x.name === chosen))
      || list.find(x => x.name === DEFAULT_VOICE_NAME)
      || list[0] || null;
  }
  // Algunos navegadores cargan las voces de forma asíncrona.
  function onVoicesReady(fn) {
    if (!voiceSupported) return;
    if (speechSynthesis.getVoices().length) fn();
    speechSynthesis.addEventListener('voiceschanged', fn);
  }

  // Texto hablado del marcador. Nombres en formato "Azul" (en MAYÚSCULAS algunas voces deletrean).
  const spoken = n => String(n).toLowerCase().replace(/(^|\s)\S/g, c => c.toUpperCase());
  function scoreSpeech(s) {
    const [A, B] = s.teams.map(t => spoken(t.name));
    const [a, b] = s.points;
    if (s.phase === 'matchOver') {
      return `¡${spoken(s.teams[s.matchWinner].name)} gana el partido! Sets, ${s.sets[s.matchWinner]} a ${s.sets[1 - s.matchWinner]}.`;
    }
    if (s.phase === 'setOver') {
      const w = s.setWinner;
      const next = s.rotationMode && s.nextIn !== null ? ` Se prepara ${spoken(s.allTeams[s.nextIn].name)}.` : '';
      return `¡Set para ${spoken(s.teams[w].name)}! Quedó ${s.points[w]} a ${s.points[1 - w]}.${next}`;
    }
    // Con orden de saque el anuncio es corto: marcador (primero quien saca) y quién saca.
    if (s.hasServeOrder) {
      const srv = s.serve === 1 ? 1 : 0;
      const saca = s.serveNumber !== null ? `Saca jugador número ${s.serveNumber}, ${[A, B][srv]}.` : `Saca ${[A, B][srv]}.`;
      if (a === b) return `${a === 0 ? 'Cero a cero' : `Empate a ${a}`}. ${saca}${a && s.maxPoints && a === s.maxPoints - 1 ? ' Punto decisivo.' : ''}`;
      return `${s.points[srv]} a ${s.points[1 - srv]}. ${saca}${Math.max(a, b) >= s.target - 1 ? ` Punto de set para ${[A, B][a > b ? 0 : 1]}.` : ''}`;
    }
    if (a === b && a === 0) return `${A} contra ${B}. Cero a cero.`;
    // Regla de canto: primero el equipo que tiene el saque (quien ganó el último punto).
    const first = s.serve === 1 ? 1 : 0;
    const names = [A, B];
    // Con tope de alargue (o muerte súbita), un empate a un punto del tope decide el set.
    if (a === b) return `Empate a ${a}. Saca ${names[first]}.${s.maxPoints && a === s.maxPoints - 1 ? ' Punto decisivo.' : ''}`;
    let text = `${names[first]}, ${s.points[first]}. ${names[1 - first]}, ${s.points[1 - first]}.`;
    const lead = a > b ? 0 : 1;
    if (Math.max(a, b) >= s.target - 1) text += ` Punto de set para ${names[lead]}.`;
    return text;
  }
  // ---------- Tabla de posiciones por sets ----------
  // Ganados: teamSets (incluye correcciones del admin). Perdidos y puntos: historial de sets.
  // Orden: más sets ganados, menos perdidos, mejor diferencia de puntos. Empates comparten puesto.
  function standings(s) {
    const rows = s.allTeams.map((t, i) => ({ i, name: t.name, color: t.color, won: s.teamSets[i] || 0, lost: 0, pf: 0, pa: 0 }));
    for (const r of s.setResults || []) {
      if (!Array.isArray(r.teams)) continue;
      r.teams.forEach((ti, side) => {
        const row = rows[ti];
        if (!row) return;
        row.pf += r.points[side];
        row.pa += r.points[1 - side];
        if (r.winner !== ti) row.lost++;
      });
    }
    const key = r => [r.won, -r.lost, r.pf - r.pa];
    rows.sort((a, b) => b.won - a.won || a.lost - b.lost || (b.pf - b.pa) - (a.pf - a.pa) || a.i - b.i);
    rows.forEach((r, k) => {
      r.played = r.won + r.lost;
      r.diff = r.pf - r.pa;
      const prev = rows[k - 1];
      r.pos = prev && key(prev).join() === key(r).join() ? prev.pos : k + 1;
      r.status = s.court.includes(r.i) ? 'En cancha' : s.queue.includes(r.i) ? `Espera ${s.queue.indexOf(r.i) + 1}` : '';
    });
    return { rows, total: (s.setResults || []).length };
  }

  // «a 10», «a 10 · sin alargue» o «a 10 · máx. 12», según el alargue configurado.
  function targetText(s) {
    if (s.maxPoints === null || s.maxPoints === undefined) return `a ${s.target}`;
    return s.maxPoints === s.target ? `a ${s.target} · sin alargue` : `a ${s.target} · máx. ${s.maxPoints}`;
  }
  function stopSpeaking() {
    clearTimeout(voiceTimer);
    clipToken++; // invalida el anuncio grabado en curso
    if (clipAudio) clipAudio.pause();
    // Solo se toca la voz del navegador si está hablando: en iPhone basta con usarla
    // (incluso cancel()) para que iOS pause la música de otras apps.
    if (ttsUsed && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel();
  }
  // Referencia al anuncio en curso: si el navegador lo libera de memoria, `onend` no llega
  // y las repeticiones se pierden (bug conocido de Chrome/WebKit).
  let currentUtterance = null;
  let ttsUsed = false; // la voz del navegador no se toca hasta que haga falta (ver stopSpeaking)
  function speak(text, cfg) {
    if (!voiceSupported) return false;
    ttsUsed = true;
    // En iOS (Safari y Chrome usan WebKit), hablar justo después de cancel() a veces no suena:
    // solo se cancela si hay algo sonando y se espera un instante antes del nuevo anuncio.
    // Sin nada sonando se habla de inmediato (el primer anuncio debe ir dentro del toque).
    const busy = speechSynthesis.speaking || speechSynthesis.pending;
    stopSpeaking();
    const c = { rate: 1, repeat: 1, interval: 3, lang: 'es-CO', ...cfg };
    let done = 0;
    const once = (useVoice = true) => {
      const u = new SpeechSynthesisUtterance(text);
      const v = useVoice ? pickVoice(c.lang) : null;
      // Siempre en español: casi ningún dispositivo trae voz es-CO, y pedir un idioma sin voz
      // hace que algunos (iPhone) usen la voz del sistema, que puede ser en inglés.
      u.lang = v ? v.lang : (c.lang === 'es-CO' ? 'es-MX' : c.lang);
      u.rate = c.rate;
      if (v) u.voice = v.voice;
      u.onend = () => {
        done++;
        if (done < c.repeat) voiceTimer = setTimeout(() => once(useVoice), c.interval * 1000);
      };
      // Algunas voces listadas no están instaladas en el iPhone y fallan en silencio:
      // se reintenta una vez con la voz por defecto del sistema para el idioma.
      u.onerror = e => {
        if (v && e.error !== 'interrupted' && e.error !== 'canceled') once(false);
      };
      currentUtterance = u;
      speechSynthesis.resume(); // iOS puede quedar «en pausa» tras ir a segundo plano
      speechSynthesis.speak(u);
    };
    if (busy) voiceTimer = setTimeout(() => once(), 120);
    else once();
    return true;
  }

  // ---------- Voz grabada (public/audio/voz, generada con scripts/generar-voz.sh) ----------
  // En iPhone la voz del navegador PAUSA la música (Spotify); un audio normal suena encima sin
  // pausarla. Cada anuncio se arma uniendo audios WAV (mono, 16 bits) en un solo WAV con un «ding»
  // al inicio, y se reproduce con un único <audio> desbloqueado en el primer toque (iOS bloquea
  // audios que no nacen de un toque). Si falta algún audio, se usa la voz del navegador.
  const CLIP_RATE = 22050;
  const CLIP_MAX_NUMBER = 99;
  const GAP = { ',': 0.18, '|': 0.35 }; // pausas (s): coma y punto
  const WORD_GAP = 0.04;
  const clipCache = new Map(); // clave → Promise<Int16Array>
  let palette = []; // colores de options.json: el anuncio usa el nombre del color del equipo
  let clipAudio = null;
  let clipUrl = null;
  let clipToken = 0;
  const audioSupported = typeof Audio !== 'undefined';
  const clipEl = () => (clipAudio = clipAudio || new Audio());

  function makeWav(samples) {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const v = new DataView(buf);
    const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, CLIP_RATE, true); v.setUint32(28, CLIP_RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, samples.length * 2, true);
    new Int16Array(buf, 44).set(samples);
    return new Blob([buf], { type: 'audio/wav' });
  }
  // Muestras de un WAV: busca el bloque «data» (por si el archivo trae otros bloques).
  function wavSamples(buf) {
    const v = new DataView(buf);
    for (let o = 12; o + 8 <= buf.byteLength;) {
      const id = String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
      const size = v.getUint32(o + 4, true);
      if (id === 'data') return new Int16Array(buf.slice(o + 8, o + 8 + size));
      o += 8 + size + (size % 2);
    }
    throw new Error('WAV sin datos');
  }
  function loadClip(key) {
    if (!clipCache.has(key)) {
      const p = fetch(`/audio/voz/${key}.wav`)
        .then(r => { if (!r.ok) throw new Error('Falta el audio ' + key); return r.arrayBuffer(); })
        .then(wavSamples);
      p.catch(() => clipCache.delete(key)); // se reintenta en el próximo anuncio
      clipCache.set(key, p);
    }
    return clipCache.get(key);
  }
  const colorKey = label => 'c_' + label.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  // Claves de audio del anuncio: mismo contenido que scoreSpeech. ',' y '|' son pausas.
  // Devuelve null si algo no tiene audio (número fuera de rango, color no grabado).
  function scoreClips(s) {
    const team = t => {
      const c = palette.find(p => p.value.toLowerCase() === String(t.color).toLowerCase());
      return c ? colorKey(c.label) : null;
    };
    const n = x => (Number.isInteger(x) && x >= 0 && x <= CLIP_MAX_NUMBER ? 'n' + x : null);
    const [a, b] = s.points;
    let parts;
    let lead = '|'; // pausa después del «ding»
    if (s.phase === 'matchOver') {
      const w = s.matchWinner;
      parts = [team(s.teams[w]), 'gana_el_partido', '|', 'sets', n(s.sets[w]), 'a', n(s.sets[1 - w])];
    } else if (s.phase === 'setOver') {
      const w = s.setWinner;
      parts = ['set_para', team(s.teams[w]), '|', 'quedo', n(s.points[w]), 'a', n(s.points[1 - w])];
      if (s.rotationMode && s.nextIn !== null) parts.push('|', 'se_prepara', team(s.allTeams[s.nextIn]));
    } else if (s.hasServeOrder) {
      // Con orden de saque el anuncio es corto: marcador (primero quien saca) y quién saca.
      const srv = s.serve === 1 ? 1 : 0;
      const names = s.teams.map(team);
      const saca = s.serveNumber !== null ? ['saca_jugador_numero', n(s.serveNumber), names[srv]] : ['saca', names[srv]];
      lead = ',';
      if (a === b) {
        parts = [...(a === 0 ? ['cero_a_cero'] : ['empate_a', n(a)]), ',', ...saca];
        if (a && s.maxPoints && a === s.maxPoints - 1) parts.push(',', 'punto_decisivo');
      } else {
        parts = [n(s.points[srv]), 'a', n(s.points[1 - srv]), ',', ...saca];
        if (Math.max(a, b) >= s.target - 1) parts.push(',', 'punto_de_set_para', names[a > b ? 0 : 1]);
      }
    } else if (a === 0 && b === 0) {
      parts = [team(s.teams[0]), 'contra', team(s.teams[1]), '|', 'cero_a_cero'];
    } else {
      // Regla de canto: primero el equipo que tiene el saque (quien ganó el último punto).
      const first = s.serve === 1 ? 1 : 0;
      const names = s.teams.map(team);
      if (a === b) {
        parts = ['empate_a', n(a), '|', 'saca', names[first]];
        if (s.maxPoints && a === s.maxPoints - 1) parts.push('|', 'punto_decisivo');
      } else {
        parts = [names[first], ',', n(s.points[first]), '|', names[1 - first], ',', n(s.points[1 - first])];
        if (Math.max(a, b) >= s.target - 1) parts.push('|', 'punto_de_set_para', names[a > b ? 0 : 1]);
      }
    }
    return parts.includes(null) ? null : ['ding', lead, ...parts];
  }

  // ---- Volumen y presencia de la voz (ajustes de la sala, en Administración) ----
  // Presencia: realce tipo radio en los medios-altos (~3 kHz) para que la voz se distinga
  // sobre la música sin subir tanto el volumen. Después, volumen y un limitador suave
  // (en vez de recortar, redondea los picos: así no suena ronca).
  const PRESENCE_HZ = 3000;
  function presenceFilter(x, db) {
    if (!db) return x;
    // Filtro «peaking» (RBJ Audio EQ Cookbook), Q ≈ 0.9.
    const A = Math.pow(10, db / 40);
    const w = 2 * Math.PI * PRESENCE_HZ / CLIP_RATE;
    const alpha = Math.sin(w) / (2 * 0.9);
    const cos = Math.cos(w);
    const a0 = 1 + alpha / A;
    const b0 = (1 + alpha * A) / a0, b1 = (-2 * cos) / a0, b2 = (1 - alpha * A) / a0;
    const a1 = (-2 * cos) / a0, a2 = (1 - alpha / A) / a0;
    const y = new Float32Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = v;
      y[i] = v;
    }
    return y;
  }
  const SOFT_KNEE = 0.8;
  const softLimit = v => {
    const a = Math.abs(v);
    if (a <= SOFT_KNEE) return v;
    return Math.sign(v) * (SOFT_KNEE + (1 - SOFT_KNEE) * Math.tanh((a - SOFT_KNEE) / (1 - SOFT_KNEE)));
  };
  function shapeVoice(samples, { gain = 1, presence = 0 } = {}) {
    if (gain === 1 && !presence) return samples;
    const x = Float32Array.from(samples, s => s / 32768);
    const y = presenceFilter(x, presence);
    const out = new Int16Array(y.length);
    for (let i = 0; i < y.length; i++) out[i] = Math.round(softLimit(y[i] * gain) * 32767);
    return out;
  }

  async function buildClip(parts, fx) {
    const raw = await Promise.all(parts.filter(p => !(p in GAP)).map(loadClip));
    // El ding no se procesa (es un tono de aviso); solo la voz.
    const keys = parts.filter(p => !(p in GAP));
    const data = raw.map((d, i) => (keys[i] === 'ding' ? d : shapeVoice(d, fx)));
    const chunks = [];
    let k = 0;
    let prevWord = false;
    for (const p of parts) {
      if (p in GAP) { chunks.push(new Int16Array(Math.round(GAP[p] * CLIP_RATE))); prevWord = false; continue; }
      if (prevWord) chunks.push(new Int16Array(Math.round(WORD_GAP * CLIP_RATE)));
      chunks.push(data[k++]);
      prevWord = true;
    }
    const out = new Int16Array(chunks.reduce((t, c) => t + c.length, 0));
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return makeWav(out);
  }
  // Reproduce el anuncio con repeticiones. false si no se pudo armar (para usar la voz del navegador).
  async function playClips(parts, c) {
    const token = ++clipToken;
    let blob;
    try { blob = await buildClip(parts, { gain: c.gain, presence: c.presence }); } catch { return false; }
    if (token !== clipToken) return true; // llegó un anuncio más nuevo
    const el = clipEl();
    if (clipUrl) URL.revokeObjectURL(clipUrl);
    clipUrl = URL.createObjectURL(blob);
    let done = 0;
    const once = () => {
      if (token !== clipToken) return;
      el.src = clipUrl;
      el.defaultPlaybackRate = el.playbackRate = c.rate;
      el.onended = () => {
        done++;
        if (done < c.repeat && token === clipToken) voiceTimer = setTimeout(once, c.interval * 1000);
      };
      el.play().catch(() => {});
    };
    once();
    return true;
  }
  // Debe llamarse dentro de un toque: deja el <audio> habilitado para los anuncios siguientes
  // y precarga los audios más usados.
  function unlockAudio(s) {
    if (!audioSupported) return;
    const el = clipEl();
    el.src = URL.createObjectURL(makeWav(new Int16Array(CLIP_RATE / 20)));
    el.play().catch(() => {});
    const common = ['ding', 'contra', 'cero_a_cero', 'empate_a', 'saca', 'saca_jugador_numero', 'punto_de_set_para', 'set_para', 'quedo', 'a'];
    for (let i = 0; i <= 30; i++) common.push('n' + i);
    // Números del orden de saque: se precargan para que el primer anuncio de cada uno no se demore.
    if (s) for (const t of s.allTeams) for (const j of t.serveOrder || []) common.push('n' + j);
    common.concat(palette.map(p => colorKey(p.label))).forEach(k => loadClip(k).catch(() => {}));
  }
  // Anuncia el marcador: voz grabada si hay audios para todo; si no, la voz del navegador.
  // Aviso (una vez por carga) cuando se usa la voz del navegador: en iPhone pausa la música.
  let fallbackWarned = false;
  function fallbackSpeak(s, cfg, reason) {
    if (!fallbackWarned) { fallbackWarned = true; toast(`Voz de respaldo (${reason}): en iPhone puede pausar la música`, 'bad'); }
    return speak(scoreSpeech(s), cfg);
  }
  const SERVE_ORDER_RATE = 1.4; // velocidad mínima de la voz con orden de saque
  function announce(s, voiceCfg) {
    const cfg = s.hasServeOrder ? { ...voiceCfg, rate: Math.max(voiceCfg.rate || 1, SERVE_ORDER_RATE) } : voiceCfg;
    const c = { rate: 1, repeat: 1, interval: 3, gain: 1.5, presence: 6, ...cfg };
    const parts = audioSupported && palette.length ? scoreClips(s) : null;
    stopSpeaking();
    if (!parts) return fallbackSpeak(s, cfg, !palette.length ? 'sin colores cargados' : 'sin audio para este anuncio');
    playClips(parts, c).then(ok => { if (!ok) fallbackSpeak(s, cfg, 'no se pudieron descargar los audios'); });
    return true;
  }

  // ---------- Anunciador por voz (compartido por marcador y control) ----------
  // Lo usan el marcador (modo dos pantallas) y el control (modo un solo dispositivo: celular +
  // parlante Bluetooth). Ambos reciben el mismo estado de la sala; solo cambia dónde suena.
  // Los navegadores solo dejan hablar después de un toque, por eso `voiceOn` arranca apagado
  // en cada carga y se activa con el botón (o con `unlock()` desde otro toque del usuario).
  function voiceAnnouncer({ btn, labels = {} }) {
    const L = { off: '🔇 Voz apagada', idle: '🔊 Activar voz', on: '🔊 Voz activa', ...labels };
    let voiceOn = false;
    let last = null;
    let debounce = null;
    const enabledInRoom = s => !!(s && s.voice && s.voice.enabled);
    function paint() {
      if (!btn) return;
      const enabled = enabledInRoom(last);
      btn.className = enabled && !voiceOn ? 'ok' : 'alt';
      btn.classList.toggle('hidden', !voiceSupported && !audioSupported);
      btn.textContent = !enabled ? L.off : voiceOn ? L.on : L.idle;
    }
    // Llamar en cada estado recibido.
    function update(s) {
      const prev = last;
      last = s;
      paint();
      if (!enabledInRoom(s) || (!voiceSupported && !audioSupported)) { stopSpeaking(); return; }
      if (!voiceOn || !prev) return;
      const changed = prev.points.join() !== s.points.join() || prev.phase !== s.phase || prev.currentSet !== s.currentSet || prev.serveNumber !== s.serveNumber;
      if (!changed) return;
      // Espera breve: si llegan varios cambios seguidos, solo se anuncia el último.
      clearTimeout(debounce);
      debounce = setTimeout(() => announce(last, last.voice), s.hasServeOrder ? 200 : 600);
    }
    // Debe llamarse dentro de un toque/clic del usuario (desbloquea el audio en móviles).
    function unlock() {
      if (!voiceSupported && !audioSupported) { toast('Este navegador no soporta voz', 'bad'); return false; }
      if (!enabledInRoom(last)) {
        toast('La voz está apagada para esta sala. Actívala en Administración → «Voz del marcador» o al crear el tablero.');
        return false;
      }
      voiceOn = true;
      unlockAudio(last);
      announce(last, { ...last.voice, repeat: 1 });
      paint();
      return true;
    }
    function pause() { voiceOn = false; stopSpeaking(); toast('Voz en pausa en esta pantalla'); paint(); }
    if (btn) btn.addEventListener('click', () => (voiceOn ? pause() : unlock()));
    paint();
    return { update, unlock, pause, isOn: () => voiceOn, state: () => last };
  }

  // Modal para elegir la voz de ESTE dispositivo (las voces dependen del navegador/sistema).
  function voicePicker(s) {
    const lang = (s && s.voice && s.voice.lang) || 'es-CO';
    const list = listVoices(lang);
    const current = pickVoice(lang);
    const hasCO = list.some(v => v.lang === 'es-CO');
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `<div class="box" style="text-align:left">
      <h2 style="text-align:center">Voz de esta pantalla</h2>
      ${list.length ? `<select id="vpSel" style="width:100%;padding:10px;border-radius:10px;background:#0c1220;color:var(--text);border:1px solid var(--line);font-size:16px">
        ${list.map(v => `<option value="${esc(v.name)}"${current && v.name === current.name ? ' selected' : ''}>${v.natural ? '⭐ ' : ''}${esc(v.name)} · ${v.lang}</option>`).join('')}
      </select>` : '<p>No hay voces en español en este navegador.</p>'}
      <p class="muted" style="font-size:14px">⭐ = voz natural (neuronal / en línea). La lista sale de este navegador; se recuerda máx. 4 h.</p>
      ${hasCO ? '' : `<p class="muted" style="font-size:14px">No hay voz colombiana en este navegador. Para una voz colombiana natural y gratuita abre la página en <b>Microsoft Edge</b> (voces «Salomé» y «Gonzalo», Español Colombia). En Chrome, la más cercana es «Google español de Estados Unidos».</p>`}
      <div class="row"><button class="alt" data-a="test">▶ Probar</button><button class="alt" data-a="close">Cerrar</button><button class="ok" data-a="save">Usar esta voz</button></div></div>`;
    document.body.appendChild(ov);
    const sel = ov.querySelector('#vpSel');
    ov.addEventListener('click', e => {
      const a = e.target.dataset.a;
      if (e.target === ov || a === 'close') return ov.remove();
      if (!sel) return;
      if (a === 'test' || a === 'save') local.set('voiceName', sel.value);
      if (a === 'test') speak(s ? scoreSpeech(s) : 'Azul, 6. Rojo, 4.', { ...(s && s.voice), repeat: 1 });
      if (a === 'save') { toast('Voz guardada: ' + sel.value, 'good'); ov.remove(); }
    });
  }

  // ---------- Opciones de listas desplegables (config/options.json) ----------
  let optionsPromise = null;
  const options = () => (optionsPromise = optionsPromise || fetch('/config/options.json').then(r => r.json()));
  // Llena un <select> con { default, options: [{ value, label }] } y selecciona `value` (o el default).
  function fillSelect(el, opt, value) {
    el.innerHTML = opt.options.map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
    el.value = String(value ?? opt.default);
  }

  // Selector de color con nombre (paleta de options.json). Un nombre vacío toma el nombre del color.
  const colorLabel = (palette, hex) => (palette.find(c => c.value.toLowerCase() === String(hex || '').toLowerCase()) || {}).label || null;
  function colorSelect(palette, value, cls = 't-color') {
    const v = String(value || palette[0].value).toLowerCase();
    const known = !!colorLabel(palette, v);
    const opts = (known ? '' : `<option value="${esc(v)}" selected>PERSONALIZADO</option>`) + palette.map(c =>
      `<option value="${esc(c.value)}" style="background:${c.value};color:#fff"${c.value.toLowerCase() === v ? ' selected' : ''}>${esc(c.label)}</option>`).join('');
    return `<select class="${cls} color-select" style="background:${esc(v)}" aria-label="Color">${opts}</select>`;
  }
  // Mantiene sincronizados el fondo del selector y el placeholder del nombre («vacío = AZUL»).
  function bindColorRows(container, palette) {
    const sync = row => {
      const sel = row.querySelector('.t-color');
      const name = row.querySelector('.t-name');
      if (!sel || !name) return;
      sel.style.background = sel.value;
      name.placeholder = `Vacío = ${colorLabel(palette, sel.value) || name.dataset.fallback || 'EQUIPO'}`;
    };
    container.querySelectorAll('.team-field').forEach(sync);
    if (container.dataset.colorBound) return; // un solo listener aunque se redibujen las filas
    container.dataset.colorBound = '1';
    container.addEventListener('change', e => { if (e.target.classList.contains('t-color')) sync(e.target.closest('.team-field')); });
  }

  // Modal de confirmación. Con `requireText` hay que escribir esa palabra para habilitar el botón.
  function confirmModal({ title, text, confirmLabel = 'Confirmar', danger = false, requireText = null }) {
    return new Promise(resolve => {
      const ov = document.createElement('div');
      ov.className = 'overlay';
      ov.innerHTML = `<div class="box" role="dialog" aria-modal="true">
        <h2>${esc(title)}</h2><p class="muted">${esc(text)}</p>
        ${requireText ? `<p>Escribe <b>${esc(requireText)}</b> para confirmar:</p><input class="modal-input" autocomplete="off" style="padding:10px;border-radius:10px;border:1px solid var(--line);background:#0c1220;color:var(--text);width:100%;font-size:18px;text-align:center">` : ''}
        <div class="row"><button class="alt" data-r="0">Cancelar</button><button class="${danger ? 'danger' : 'ok'}" data-r="1">${esc(confirmLabel)}</button></div></div>`;
      document.body.appendChild(ov);
      const ok = ov.querySelector('[data-r="1"]');
      const inp = ov.querySelector('.modal-input');
      if (inp) {
        ok.disabled = true;
        inp.addEventListener('input', () => { ok.disabled = inp.value.trim().toUpperCase() !== requireText.toUpperCase(); });
        setTimeout(() => inp.focus(), 50);
      }
      const close = v => { ov.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = e => { if (e.key === 'Escape') close(false); };
      document.addEventListener('keydown', onKey);
      ov.addEventListener('click', e => {
        if (e.target === ov) return close(false);
        const r = e.target.dataset && e.target.dataset.r;
        if (r !== undefined && !e.target.disabled) close(r === '1');
      });
    });
  }

  function clearLocalData() {
    if (!confirm('¿Borrar los datos guardados en este navegador (sala, PIN, ajustes y caché)? El marcador del servidor no se borra.')) return false;
    local.clear();
    toast('Datos locales borrados', 'good');
    return true;
  }

  // ---------- Spotify: música dentro de la página (Web Playback SDK, Premium) ----------
  // En iPhone la app de Spotify y el navegador no pueden sonar a la vez (cualquier audio de la
  // página pausa Spotify). Si la música suena en ESTA página (reproductor «DC Sport Score»),
  // la voz del marcador suena encima. Inicio de sesión PKCE: el Client ID viene del servidor
  // (SPOTIFY_CLIENT_ID) y todo lo demás ocurre entre el celular y Spotify.
  // La sesión de Spotify es la única excepción a la caché de 4 h: dura 30 días y se renueva sola.
  const spotify = (() => {
    const KEY = 'spotify';
    const AUTH_KEY = 'spAuth';
    const TTL_MS = 30 * 24 * 3600 * 1000;
    const SCOPES = 'streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state';
    const redirect = () => location.origin + '/spotify';
    const listeners = new Set();
    let clientIdP = null;
    let sdkP = null;
    let player = null;
    let deviceId = null;
    let wantPlay = false; // se tocó «música» antes de que el reproductor estuviera listo
    const emit = (status, msg) => listeners.forEach(fn => fn(status, msg));
    // Escritura directa con vencimiento propio (DC.local limita a 4 h); DC.local.get la lee igual.
    const saveToken = t => { try { localStorage.setItem(PREFIX + KEY, JSON.stringify({ v: t, exp: Date.now() + TTL_MS })); } catch {} };
    const token = () => local.get(KEY);
    const clientId = () => (clientIdP = clientIdP || fetch('/api/spotify-config', { headers: { 'ngrok-skip-browser-warning': '1' } })
      .then(r => r.json()).then(j => j.clientId || null).catch(() => { clientIdP = null; return null; }));
    const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    async function login() {
      const id = await clientId();
      if (!id) { toast('Spotify no está configurado en el servidor (falta SPOTIFY_CLIENT_ID)', 'bad'); return; }
      if (!crypto.subtle) { toast('Para Spotify abre la página por https', 'bad'); return; }
      const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
      const state = b64url(crypto.getRandomValues(new Uint8Array(12)));
      local.set(AUTH_KEY, { verifier, state, back: location.href }, 10 * 60 * 1000);
      const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
      location.href = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
        client_id: id, response_type: 'code', redirect_uri: redirect(), scope: SCOPES,
        code_challenge_method: 'S256', code_challenge: challenge, state,
      });
    }
    async function tokenRequest(params) {
      const r = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: await clientId(), ...params }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error_description || j.error || 'Spotify rechazó la sesión');
      const prev = token() || {};
      saveToken({ access: j.access_token, refresh: j.refresh_token || prev.refresh, exp: Date.now() + (j.expires_in - 60) * 1000 });
    }
    // Lo usa /spotify al volver del inicio de sesión. Devuelve la página a la que hay que regresar.
    async function finishLogin(q) {
      const auth = local.get(AUTH_KEY);
      local.remove(AUTH_KEY);
      if (q.get('error')) throw new Error(q.get('error') === 'access_denied' ? 'Cancelaste la conexión con Spotify' : 'Spotify: ' + q.get('error'));
      if (!auth || auth.state !== q.get('state')) throw new Error('La conexión expiró; vuelve a tocar «Conectar Spotify»');
      await tokenRequest({ grant_type: 'authorization_code', code: q.get('code'), redirect_uri: redirect(), code_verifier: auth.verifier });
      return auth.back;
    }
    async function access() {
      const t = token();
      if (!t) throw new Error('Conecta Spotify primero');
      if (Date.now() > t.exp) {
        try { await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh }); }
        catch (e) { local.remove(KEY); emit('off'); throw new Error('La sesión de Spotify venció; vuelve a conectar'); }
      }
      return token().access;
    }
    function loadSdk() {
      return (sdkP = sdkP || new Promise((resolve, reject) => {
        window.onSpotifyWebPlaybackSDKReady = resolve;
        const s = document.createElement('script');
        s.src = 'https://sdk.scdn.co/spotify-player.js';
        s.onerror = () => { sdkP = null; reject(new Error('No se pudo cargar el reproductor de Spotify')); };
        document.head.appendChild(s);
      }));
    }
    async function transfer() {
      const r = await fetch('https://api.spotify.com/v1/me/player', {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + await access(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_ids: [deviceId], play: true }),
      });
      if (!r.ok) throw new Error(`Spotify no pudo pasar la música aquí (${r.status})`);
    }
    // Prepara el reproductor al cargar la página (si hay sesión): así el toque de «música»
    // puede habilitar el audio al instante, como exige iOS.
    async function prepare() {
      if (!token() || player) return;
      try {
        await loadSdk();
        player = new window.Spotify.Player({ name: 'DC Sport Score', getOAuthToken: cb => access().then(cb).catch(e => emit('error', e.message)), volume: 1 });
        for (const ev of ['initialization_error', 'authentication_error', 'account_error', 'playback_error']) {
          player.addListener(ev, ({ message }) => emit('error', ev === 'account_error' ? 'Spotify requiere cuenta Premium' : message));
        }
        player.addListener('autoplay_failed', () => emit('error', 'iOS bloqueó la música: toca «🎵 Música» otra vez'));
        player.addListener('not_ready', () => { deviceId = null; emit('connecting'); });
        player.addListener('ready', ({ device_id }) => {
          deviceId = device_id;
          emit('ready');
          if (wantPlay) { wantPlay = false; transfer().then(() => emit('playing')).catch(e => emit('error', e.message)); }
        });
        player.addListener('player_state_changed', s => { if (s) emit(s.paused ? 'paused' : 'playing', s.track_window.current_track && s.track_window.current_track.name); });
        await player.connect();
      } catch (e) { emit('error', e.message); }
    }
    // Debe llamarse dentro de un toque: inicia sesión si hace falta, o pasa la música a esta página.
    function play() {
      if (!token()) { login(); return; }
      if (!player) { wantPlay = true; emit('connecting'); prepare(); return; }
      player.activateElement(); // habilita el audio del reproductor (requisito de iOS)
      if (!deviceId) { wantPlay = true; emit('connecting'); return; }
      transfer().then(() => emit('playing')).catch(e => emit('error', e.message));
    }
    function logout() {
      local.remove(KEY);
      if (player) player.disconnect();
      player = null; deviceId = null;
      emit('off');
    }
    return {
      connected: () => !!token(), login, finishLogin, prepare, play, logout,
      onChange: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    };
  })();

  // Paleta para la voz grabada (el anuncio usa el nombre del color de cada equipo).
  options().then(o => { palette = o.teamColors || []; }).catch(() => {});

  window.DC = { room, team, cleanRoom, esc, connect, toast, renderConnection, urlFor, params, speak, stopSpeaking, voiceSupported, announce, unlockAudio, scoreClips, clipBlob: buildClip, spotify, local, clearLocalData, options, fillSelect, colorLabel, colorSelect, bindColorRows, confirmModal, listVoices, pickVoice, onVoicesReady, scoreSpeech, targetText, standings, voiceAnnouncer, voicePicker };
})();
