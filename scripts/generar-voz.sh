#!/usr/bin/env bash
# Genera los audios del anunciador (public/audio/voz/*.wav) con la voz «Paulina» de macOS.
# Requiere macOS (`say`) y ffmpeg (brew install ffmpeg). Se ejecuta una sola vez o al cambiar frases.
#
# Por qué audios grabados y no la voz del navegador: en iPhone la voz del navegador PAUSA la
# música (Spotify); un audio normal suena encima sin pausarla. Como una página web no puede bajar
# el volumen de otra app, cada audio se comprime y se refuerza (~2× más fuerte) para oírse
# sobre la música, y cada anuncio empieza con un «ding».
#
# Formato: WAV PCM 16 bits, mono, 22 050 Hz. El navegador los une en un solo WAV por anuncio.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=public/audio/voz
VOICE=${VOICE:-Paulina}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT"

# Cadena de refuerzo: recorta silencios, quita graves, realza la voz, comprime y normaliza.
FILTER="silenceremove=start_periods=1:start_threshold=-45dB:stop_periods=-1:stop_threshold=-45dB:stop_duration=0.08,\
highpass=f=200,equalizer=f=3000:t=q:w=1.2:g=6,\
acompressor=threshold=-30dB:ratio=10:attack=2:release=60:makeup=10,alimiter=limit=0.89:level=false,\
loudnorm=I=-6:TP=-0.5:LRA=3,alimiter=limit=0.95"
WAV_OPTS=(-ar 22050 -ac 1 -c:a pcm_s16le -map_metadata -1 -fflags +bitexact -flags:a +bitexact)

clip() { # clip <clave> <texto>
  say -v "$VOICE" -o "$TMP/$1.aiff" -- "$2"
  ffmpeg -hide_banner -loglevel error -y -i "$TMP/$1.aiff" -af "$FILTER" "${WAV_OPTS[@]}" "$OUT/$1.wav"
}

# Números 0–60 (n0.wav … n60.wav)
for i in $(seq 0 60); do clip "n$i" "$i"; done

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
