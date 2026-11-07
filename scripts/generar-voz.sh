#!/usr/bin/env bash
# Genera los audios del anunciador (public/audio/voz/*.wav) con la voz «Paulina» de macOS.
# Requiere macOS (`say`) y ffmpeg (brew install ffmpeg). Se ejecuta una sola vez o al cambiar frases.
#
# Por qué audios grabados y no la voz del navegador: la voz del navegador suena distinta en cada
# equipo y en iPhone falla más; los audios suenan igual en todos y cada anuncio empieza con un «ding».
#
# Formato: WAV PCM 16 bits, mono, 22 050 Hz. El navegador los une en un solo WAV por anuncio.
#
# El VOLUMEN y la PRESENCIA (realce para oírse sobre la música) NO se ajustan aquí: son ajustes de
# la sala en Administración → «Voz del marcador» y se aplican en el navegador al anunciar.
# Este script solo genera la voz base, neutra y con margen para poder subirla sin saturar.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=public/audio/voz
VOICE=${VOICE:-Paulina}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT"

# Voz base: recorta silencios, quita graves, compresión suave (picos más parejos para poder
# subir el volumen en el navegador sin saturar) y normaliza al nivel de la voz original
# (-17.5 LUFS = volumen 1×) con margen en los picos.
FILTER="silenceremove=start_periods=1:start_threshold=-45dB:stop_periods=-1:stop_threshold=-45dB:stop_duration=0.08,\
highpass=f=150,\
acompressor=threshold=-24dB:ratio=3:attack=8:release=120:makeup=2,\
loudnorm=I=-17.5:TP=-4:LRA=7"
WAV_OPTS=(-ar 22050 -ac 1 -c:a pcm_s16le -map_metadata -1 -fflags +bitexact -flags:a +bitexact)

clip() { # clip <clave> <texto>
  say -v "$VOICE" -o "$TMP/$1.aiff" -- "$2"
  ffmpeg -hide_banner -loglevel error -y -i "$TMP/$1.aiff" -af "$FILTER" "${WAV_OPTS[@]}" "$OUT/$1.wav"
}

# Números 0–99 (n0.wav … n99.wav): puntajes y camisetas del orden de saque
for i in $(seq 0 99); do clip "n$i" "$i"; done

# Colores de config/options.json (la clave es el nombre en minúsculas, sin tildes)
node -e '
  const o = require("./public/config/options.json");
  for (const c of o.teamColors) console.log(c.label.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "") + "\t" + c.label.toLowerCase());
' | while IFS=$'\t' read -r key label; do clip "c_$key" "$label"; done

# Frases
clip contra "contra"
clip cero_a_cero "Cero a cero."
clip empate_a "Empate a"
clip saca "Saca"
clip punto_decisivo "Punto decisivo."
clip punto_de_set_para "Punto de set para"
clip set_para "¡Set para"
clip quedo "Quedó"
clip a "a"
clip se_prepara "Se prepara"
clip gana_el_partido "¡gana el partido!"
clip sets "Sets,"

# «Ding» de aviso (dos tonos cortos)
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "sine=f=1320:d=0.12" -f lavfi -i "sine=f=1760:d=0.22" \
  -filter_complex "[0]afade=t=out:st=0.08:d=0.04[a];[1]afade=t=out:st=0.05:d=0.17[b];[a][b]concat=n=2:v=0:a=1[c];[c]volume=0.8[d]" \
  -map "[d]" "${WAV_OPTS[@]}" "$OUT/ding.wav"

ls "$OUT" | wc -l | xargs echo "Audios generados en $OUT:"
du -sh "$OUT"
