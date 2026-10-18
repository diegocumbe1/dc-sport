// Persistencia sencilla en un archivo JSON con escritura atómica
// (se escribe un archivo temporal y luego se renombra sobre el definitivo).

const fs = require('fs');
const path = require('path');

function createStore(file, { delay = 250 } = {}) {
  let timer = null;
  let getData = () => ({});

  function load() {
    try {
      if (!fs.existsSync(file)) return {};
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      // Archivo dañado: se aparta para inspección y se arranca vacío.
      const bad = `${file}.corrupt-${Date.now()}`;
      try { fs.renameSync(file, bad); } catch {}
      console.error(`[store] No se pudo leer ${file} (${err.message}). Copia apartada en ${bad}`);
      return {};
    }
  }

  function writeNow() {
    clearTimeout(timer);
    timer = null;
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const fd = fs.openSync(tmp, 'w');
      fs.writeSync(fd, JSON.stringify(getData()));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fs.renameSync(tmp, file);
    } catch (err) {
      console.error(`[store] Error guardando ${file}: ${err.message}`);
    }
  }

  // Agrupa ráfagas de cambios (varios puntos seguidos) en una sola escritura.
  function scheduleSave() {
    if (!timer) timer = setTimeout(writeNow, delay);
  }

  return {
    load,
    scheduleSave,
    flush: () => { if (timer) writeNow(); },
    bind: fn => { getData = fn; },
  };
}

module.exports = { createStore };
