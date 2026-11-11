#!/usr/bin/env node
// Genera los audios del anunciador para cada voz de config/options.json → voiceSpeaker:
//   public/audio/voz/<voz>/<clave>.mp3   (números, colores y frases)
//   public/audio/voz/ding.wav            («ding» de aviso, igual para todas las voces)
//
// Voces neuronales de Microsoft Edge (gratis, sin clave) con el paquete msedge-tts; ffmpeg deja
// todas al mismo nivel. Requiere internet y ffmpeg (brew install ffmpeg). Se ejecuta una sola
// vez o al cambiar frases/voces:
//
//   node scripts/generar-voces.js            # todas las voces
//   node scripts/generar-voces.js co-f mx-m  # solo esas
//
// Los NOMBRES de los equipos no se graban aquí: el servidor los genera al vuelo con la misma voz
// (GET /api/voz/:voz?t=NOMBRE) y el navegador los empareja en volumen.
//
// El VOLUMEN y la PRESENCIA (realce para oírse sobre la música) NO se ajustan aquí: son ajustes de
// la sala en Administración → «Voz del marcador» y se aplican en el navegador al anunciar.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const OPTIONS = require('../public/config/options.json');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'public/audio/voz');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-voz-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

// Voz base: recorta silencios, quita graves, compresión suave (picos más parejos para poder
// subir el volumen en el navegador sin saturar) y normaliza a -17.5 LUFS (volumen 1×).
const FILTER = [
  'silenceremove=start_periods=1:start_threshold=-45dB:stop_periods=-1:stop_threshold=-45dB:stop_duration=0.08',
  'highpass=f=150',
  'acompressor=threshold=-24dB:ratio=3:attack=8:release=120:makeup=2',
  'loudnorm=I=-17.5:TP=-4:LRA=7',
].join(',');
const FF = ['-hide_banner', '-loglevel', 'error', '-y'];
const MP3_OPTS = ['-ar', '22050', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '48k', '-map_metadata', '-1'];

const colorKey = label => label.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const CLIPS = [
  // Números 0–99: puntajes y camisetas del orden de saque
  ...Array.from({ length: 100 }, (_, i) => ['n' + i, String(i)]),
  // Colores de la paleta (la clave es el nombre en minúsculas, sin tildes)
  ...OPTIONS.teamColors.map(c => ['c_' + colorKey(c.label), c.label.toLowerCase()]),
  ['contra', 'contra'],
  ['cero_a_cero', 'Cero a cero.'],
  ['empate_a', 'Empate a'],
  ['saca', 'Saca'],
  ['saca_jugador_numero', 'Saca jugador número'],
  ['punto_decisivo', 'Punto decisivo.'],
  ['punto_de_set_para', 'Punto de set para'],
  ['set_para', '¡Set para'],
  ['quedo', 'Quedó'],
  ['a', 'a'],
  ['se_prepara', 'Se prepara'],
  ['gana_el_partido', '¡gana el partido!'],
  ['sets', 'Sets,'],
  ['sets_ganados', 'Sets ganados,'],
  ['partido_finalizado', 'Partido finalizado.'],
  ['empate_en_sets', 'Empate en sets.'],
];

async function synth(voice, text, file) {
  for (let attempt = 1; ; attempt++) {
    const tts = new MsEdgeTTS();
    try {
      await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      const { audioStream } = tts.toStream(text);
      const chunks = [];
      for await (const c of audioStream) chunks.push(c);
      const buf = Buffer.concat(chunks);
      if (!buf.length) throw new Error('audio vacío');
      fs.writeFileSync(file, buf);
      return;
    } catch (e) {
      if (attempt >= 4) throw new Error(`${voice} «${text}»: ${e.message || e}`);
      await new Promise(r => setTimeout(r, 800 * attempt));
    } finally {
      tts.close();
    }
  }
}

async function speaker(sp) {
  const dir = path.join(OUT, sp.value);
  fs.mkdirSync(dir, { recursive: true });
  const queue = [...CLIPS];
  const worker = async () => {
    for (let item; (item = queue.shift());) {
      const [key, text] = item;
      const raw = path.join(TMP, `${sp.value}-${key}.mp3`);
      await synth(sp.tts, text, raw);
      execFileSync('ffmpeg', [...FF, '-i', raw, '-af', FILTER, ...MP3_OPTS, path.join(dir, key + '.mp3')]);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  console.log(`${sp.value} (${sp.tts}): ${CLIPS.length} audios`);
}

function ding() {
  execFileSync('ffmpeg', [...FF,
    '-f', 'lavfi', '-i', 'sine=f=1320:d=0.12', '-f', 'lavfi', '-i', 'sine=f=1760:d=0.22',
    '-filter_complex', '[0]afade=t=out:st=0.08:d=0.04[a];[1]afade=t=out:st=0.05:d=0.17[b];[a][b]concat=n=2:v=0:a=1[c];[c]volume=0.8[d]',
    '-map', '[d]', '-ar', '22050', '-ac', '1', '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact',
    path.join(OUT, 'ding.wav')]);
}

(async () => {
  const only = process.argv.slice(2);
  const list = OPTIONS.voiceSpeaker.options.filter(s => !only.length || only.includes(s.value));
  if (!list.length) throw new Error('Voces válidas: ' + OPTIONS.voiceSpeaker.options.map(s => s.value).join(', '));
  fs.mkdirSync(OUT, { recursive: true });
  ding();
  for (const sp of list) await speaker(sp);
})().catch(e => { console.error(e.message || e); process.exit(1); });
