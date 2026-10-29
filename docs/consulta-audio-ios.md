# Consulta: voz de una web app + Spotify en el mismo iPhone

## Qué necesito
Marcador de voleibol web (Node + Socket.IO, en Railway) usado en un **solo iPhone** conectado a un parlante Bluetooth. En cada punto la página anuncia el marcador por voz.
**Objetivo:** que Spotify siga sonando mientras la página habla (ideal: que la música **baje ~25 %** durante el anuncio, como una notificación, sin pausarse).
**Restricciones:** uso personal, **sin app nativa** y sin pagar Apple Developer. Tengo Spotify Premium.

## Entorno
iPhone con iOS 27.2, Chrome iOS (CriOS 156), Safari y Arc (todos WebKit). `navigator.audioSession` disponible.

## Ya probado (todo pausa Spotify)
| # | Método | Resultado |
|---|---|---|
| 1 | `speechSynthesis` | Pausa Spotify |
| 2–4 | `<audio>` m4a con `audioSession.type` = ambient / transient / sin modo | Pausa (un primer «no pausa» fue falso positivo) |
| 7–9 | `<audio>` WAV (archivo directo y blob armado en el cliente) | Pausa |
| 11–12 | `<audio>` WAV + `audioSession` ambient / transient | Pausa |
| 13 | Varios `<audio>` m4a en secuencia | Pausa |
| 14–15 | Web Audio (`AudioContext`), normal y con `audioSession` ambient | Pausa |

En todos, el navegador pasa a ser «lo que está sonando» (aparece en la Isla Dinámica y en los controles Bluetooth en lugar de Spotify).

## Spotify Web API (OAuth PKCE desde la página)
- Dispositivo iPhone: `supports_volume: false` → no se puede bajar volumen por API.
- `PUT /me/player/play` tras el anuncio: 502 / 403 «Restriction violated» (Spotify cree que sigue sonando).
- `PUT /me/player {device_ids, play:true}` 1 s después: `is_playing: true`, los minutos avanzan pero **no se oye** (el navegador no suelta el audio; pausa+play manual en Spotify lo arregla).
- Esperar 5 s + pause/play por API: **404 Device not found** (iOS suspende Spotify y sale de Connect).
- Liberar el audio (`removeAttribute('src')`, `load()`, `mediaSession.playbackState='none'`) no cambia nada.
- Solo funcionó con Spotify en **video Picture-in-Picture** (no sirve para música normal).

## Descartado
Spotify Web Playback SDK (no soporta navegadores móviles); app nativa / Capacitor (no la quiero).

## Opciones que tengo hoy
1. Portátil o Android como equipo de sonido (marcador + Spotify mezclan; en escritorio la API sí permite bajar volumen) y el iPhone solo como control.
2. Solo iPhone: anunciar únicamente en puntos clave y reanudar Spotify a mano.

## Pregunta
¿Existe alguna otra forma, **solo web, en iOS**, de reproducir audio corto desde una página sin pausar o interrumpir Spotify, o de que Spotify vuelva a sonar solo después del anuncio? (atajos de iOS, modos de `audioSession`, trucos de sesión de medios, otro navegador, etc.)
