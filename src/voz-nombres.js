// Nombres de equipos dichos con la voz grabada de la sala (voces neuronales de Microsoft Edge,
// gratis y sin clave, vía msedge-tts). Los números, colores y frases ya vienen grabados en
// public/audio/voz/<voz>/ (scripts/generar-voces.js); los nombres cambian en cada partido, así que
// se generan al vuelo una sola vez y quedan guardados en disco y en memoria.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

const MEMORY_MAX = 300;
const TIMEOUT_MS = 10_000;

// «LOS TIGRES» → «Los Tigres»: en MAYÚSCULAS algunas voces deletrean.
const spoken = n => String(n).toLowerCase().replace(/(^|\s)\S/g, c => c.toUpperCase());

function synth(voice, text) {
  const tts = new MsEdgeTTS();
  const work = (async () => {
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(text);
    const chunks = [];
    for await (const c of audioStream) chunks.push(c);
    const buf = Buffer.concat(chunks);
    if (!buf.length) throw new Error('audio vacío');
    return buf;
  })();
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('la voz no respondió')), TIMEOUT_MS); });
  return Promise.race([work, timeout]).finally(() => { clearTimeout(timer); tts.close(); });
}

function createNameVoice({ dir, speakers }) {
  const ttsOf = new Map(speakers.map(s => [s.value, s.tts]));
  const memory = new Map(); // clave → Promise<Buffer> (también deduplica pedidos simultáneos)

  function get(speaker, name) {
    const text = spoken(name);
    const hash = crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
    const key = `${speaker}/${hash}`;
    if (memory.has(key)) {
      const p = memory.get(key);
      memory.delete(key); // al final: los más usados no salen
      memory.set(key, p);
      return p;
    }
    const file = path.join(dir, speaker, hash + '.mp3');
    const p = fs.promises.readFile(file).catch(async () => {
      const buf = await synth(ttsOf.get(speaker), text);
      fs.promises.mkdir(path.dirname(file), { recursive: true })
        .then(() => fs.promises.writeFile(file, buf))
        .catch(e => console.warn('[voz] no se pudo guardar', file, e.message));
      return buf;
    });
    p.catch(() => memory.delete(key)); // un fallo se reintenta en el próximo pedido
    memory.set(key, p);
    if (memory.size > MEMORY_MAX) memory.delete(memory.keys().next().value);
    return p;
  }

  // Frase completa (prueba de voz antes del partido). Sin disco: solo memoria.
  const phrases = new Map();
  function phrase(speaker, text) {
    const key = speaker + '|' + text;
    if (!phrases.has(key)) {
      const p = synth(ttsOf.get(speaker), text);
      p.catch(() => phrases.delete(key));
      phrases.set(key, p);
      if (phrases.size > 50) phrases.delete(phrases.keys().next().value);
    }
    return phrases.get(key);
  }

  return { has: speaker => ttsOf.has(speaker), get, phrase, spoken };
}

module.exports = { createNameVoice, spoken };
