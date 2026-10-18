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
    if (a === b && a === 0) return `${A} contra ${B}. Cero a cero.`;
    // Regla de canto: primero el equipo que tiene el saque (quien ganó el último punto).
    const first = s.serve === 1 ? 1 : 0;
    const names = [A, B];
    if (a === b) return `Empate a ${a}. Saca ${names[first]}.`;
    let text = `${names[first]}, ${s.points[first]}. ${names[1 - first]}, ${s.points[1 - first]}.`;
    const lead = a > b ? 0 : 1;
    if (Math.max(a, b) >= s.target - 1) text += ` Punto de set para ${names[lead]}.`;
    return text;
  }
  function stopSpeaking() {
    clearTimeout(voiceTimer);
    if (voiceSupported) speechSynthesis.cancel();
  }
  function speak(text, cfg) {
    if (!voiceSupported) return false;
    stopSpeaking();
    const c = { rate: 1, repeat: 1, interval: 3, lang: 'es-CO', ...cfg };
    let done = 0;
    const once = () => {
      const u = new SpeechSynthesisUtterance(text);
      const v = pickVoice(c.lang);
      u.lang = v ? v.lang : c.lang;
      u.rate = c.rate;
      if (v) u.voice = v.voice;
      u.onend = () => {
        done++;
        if (done < c.repeat) voiceTimer = setTimeout(once, c.interval * 1000);
      };
      speechSynthesis.speak(u);
    };
    once();
    return true;
  }
  if (voiceSupported) speechSynthesis.getVoices(); // precarga la lista de voces

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
      btn.classList.toggle('hidden', !voiceSupported);
      btn.textContent = !enabled ? L.off : voiceOn ? L.on : L.idle;
    }
    // Llamar en cada estado recibido.
    function update(s) {
      const prev = last;
      last = s;
      paint();
      if (!enabledInRoom(s) || !voiceSupported) { stopSpeaking(); return; }
      if (!voiceOn || !prev) return;
      const changed = prev.points.join() !== s.points.join() || prev.phase !== s.phase || prev.currentSet !== s.currentSet;
      if (!changed) return;
      // Espera breve: si llegan varios cambios seguidos, solo se anuncia el último.
      clearTimeout(debounce);
      debounce = setTimeout(() => speak(scoreSpeech(last), last.voice), 600);
    }
    // Debe llamarse dentro de un toque/clic del usuario (desbloquea el audio en móviles).
    function unlock() {
      if (!voiceSupported) { toast('Este navegador no soporta voz', 'bad'); return false; }
      if (!enabledInRoom(last)) {
        toast('La voz está apagada para esta sala. Actívala en Administración → «Voz del marcador» o al crear el tablero.');
        return false;
      }
      voiceOn = true;
      speak(scoreSpeech(last), { ...last.voice, repeat: 1 });
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

  window.DC = { room, team, cleanRoom, esc, connect, toast, renderConnection, urlFor, params, speak, stopSpeaking, voiceSupported, local, clearLocalData, options, fillSelect, colorLabel, colorSelect, bindColorRows, confirmModal, listVoices, pickVoice, onVoicesReady, scoreSpeech, voiceAnnouncer, voicePicker };
})();
