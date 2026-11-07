# Control a distancia — qué considerar

Objetivo: sumar puntos sin tocar la pantalla, mientras el celular (o la pantalla) sigue
conectado a un parlante Bluetooth para la voz, y opcionalmente con música sonando.

> **Sin hardware:** el modo juez (`/control?sala=…&modo=juez`) ya funciona solo con el celular.
> Lo que sigue aplica si más adelante se quiere un control físico; la lectura de teclas aún no está hecha.

## 1. Opciones de control (de más a menos recomendable)

| Opción | Cómo se conecta | Ventajas | Cuidado con |
|---|---|---|---|
| **Presentador Bluetooth** (puntero láser, ~30–60 mil COP) | Como teclado (HID): envía `PageUp`, `PageDown`, a veces `B`, `.`, `F5`, `Esc` | Barato, 2–4 botones grandes, cabe en la mano, funciona en iPhone y Android | Cada marca envía teclas distintas → el mapeo debe ser configurable |
| **Mini teclado numérico Bluetooth** | Teclado (HID) | Muchos botones: sumar, restar, deshacer, confirmar set | Botones pequeños; se puede pegar al poste de la red |
| **Control de juego** (Xbox, PS, 8BitDo Micro) | Gamepad API del navegador | Resistente, muchos botones, **distingue entre 2 mandos** (uno por equipo) | Hay que leerlo con un ciclo continuo; en iPhone solo mandos compatibles (MFi/Xbox/PS) |
| **Segundo celular por equipo** | Ya existe: `?equipo=a` / `?equipo=b` | Sin hardware nuevo | Hay que tocar la pantalla igual |
| ~~Anillo de TikTok / disparador de cámara~~ | Simulan toques/deslizar o envían teclas de **volumen** | — | El navegador **no recibe** las teclas de volumen; además cambian el volumen del parlante |

## 2. Bluetooth con varios dispositivos (parlante + control)

- **Un celular puede tener a la vez el parlante y el control conectados.** Usan perfiles distintos
  (el parlante usa audio, A2DP; el control usa teclado, HID), así que no compiten entre sí. En la
  práctica, 2–3 dispositivos al mismo tiempo funcionan bien.
- **Todo comparte la banda de 2,4 GHz** (Bluetooth y el Wi-Fi de 2,4 GHz). Si el audio se corta:
  - conectar el celular a Wi-Fi de **5 GHz** o usar datos móviles;
  - dejar el celular cerca del parlante (el control sí puede estar más lejos);
  - el cuerpo bloquea la señal: no guardar el celular en un bolsillo del lado contrario.
- **Alcance real del control: ~10 m con línea de vista.** Desde la cancha hasta el poste suele
  bastar; atravesando personas o paredes, menos.
- **El control debe conectarse al dispositivo que tiene abierta la página de control**, no al del
  marcador. Si el marcador está en una TV y el control en el celular, el control va al celular.
- **Varios celulares cerca (varias canchas):** un control se reconecta al último dispositivo con el
  que se emparejó. Etiquetar cada control con su cancha o celular y no emparejarlo con dos a la vez.
- **No usar controles "multimedia"** (botones play/pausa/siguiente, AVRCP): esos botones los toma
  el sistema y controlan **Spotify**, no la página. Lo mismo pasa con los botones del parlante.
- **Dos controles de teclado en el mismo celular no se distinguen**: el navegador no sabe de cuál
  vino la tecla. Si hay un control por equipo, cada uno debe enviar **teclas distintas**, o usar
  mandos de juego (que sí se distinguen), o un celular por equipo.

## 3. Comportamiento del navegador

- **La página debe estar en primer plano y con la pantalla encendida.** Si el celular se bloquea,
  no llegan las teclas ni suena la voz. La app ya pide mantener la pantalla encendida con la voz
  activa (iOS 16.4+); en equipos viejos, quitar el bloqueo automático.
- **iPhone con teclado Bluetooth conectado oculta el teclado en pantalla.** No afecta al marcador,
  pero hay que saberlo si se escribe algo (nombres de equipos, PIN).
- **Tecla mantenida = repetición automática.** Se deben ignorar las repeticiones (`e.repeat`) para
  no sumar varios puntos con una sola pulsación larga.
- **Ahorro de energía del control:** muchos presentadores y teclados se duermen tras unos minutos
  sin uso y **la primera pulsación solo los despierta** (se pierde). La confirmación por voz ayuda a
  notarlo; conviene configurar el control para que no se duerma, si lo permite.

## 4. Evitar errores sin mirar la pantalla

- **Confirmación por voz** de cada punto: ya existe con el anunciador.
- **Restar con un botón aparte**, no con doble pulsación: el doble toque que se usa en pantalla es
  poco fiable con botones físicos.
- **Deshacer con pulsación larga** o un botón dedicado.
- **Confirmar el siguiente set con un botón específico** (por ejemplo `Enter`); los botones de punto
  quedan bloqueados mientras el set está terminado (ya es así hoy).
- **Cambio de lado entre sets:** ahora los equipos cambian de lado. El mapeo debe ser **por lado**
  (izquierda/derecha), no por color: el botón izquierdo siempre suma al equipo que está a la
  izquierda. La voz anuncia los equipos al iniciar el set para confirmar.
- Un sonido corto de confirmación sería útil, pero en iPhone podría pausar la música (ver sección 5).

## 5. Voz y música en paralelo

- **iPhone:** la voz del navegador pausa Spotify. No hay forma confiable desde la web de que la
  música solo baje. Probar `navigator.audioSession` en modo de mezcla (experimental), sabiendo que
  en ese modo el interruptor de silencio apaga la voz.
- **Android:** depende del motor de voz; con la voz de Google a menudo la música solo baja.
- **Solución práctica:** música en un dispositivo y voz en otro (por ejemplo, voz en el marcador de
  la TV, música desde otro celular). **Solución definitiva:** app nativa (Capacitor) que pida al
  sistema bajar la música mientras habla.

## 6. Configuraciones recomendadas

**A. Un solo celular** (`?modo=uno`)
Celular → parlante Bluetooth (voz) + presentador Bluetooth (puntos). Música desde otro dispositivo.

**B. Marcador en TV + celular de control**
TV o computador → voz por sus parlantes. Celular → página de control + presentador Bluetooth.
El celular queda libre de audio, así que se puede poner música desde él (en Android).

**C. Un control por equipo**
Dos mandos de juego en el mismo celular, o dos celulares con `?equipo=a` / `?equipo=b`, cada
uno con su presentador.

## 7. Implementación propuesta (solo en el cliente, sin cambiar el servidor)

1. Escuchar `keydown` en `control.html`, ignorando `e.repeat` y cuando hay un modal abierto.
2. Mapeo por defecto: `PageUp`/`←` = +1 izquierda, `PageDown`/`→` = +1 derecha,
   `Backspace`/`Z` = deshacer, `Enter` = confirmar siguiente set.
3. **Modo "aprender botón"** en el menú: pulsar el botón del control para asignarle una acción;
   guardar en `DC.local` (cada control envía teclas distintas).
4. Mandos de juego: leer `navigator.getGamepads()` con `requestAnimationFrame`, con asignación por
   índice de mando (mando 1 → izquierda, mando 2 → derecha) o por botón.
5. Reutilizar `sendPoint()` y el bloqueo de fase y espera tras el cambio de set que ya existen.

## 8. Lista de pruebas antes de jugar

- [ ] Parlante y control conectados a la vez: la voz no se corta al pulsar botones.
- [ ] Probar a la distancia real de juego (desde la cancha hasta donde está el celular).
- [ ] Dejar el control quieto 10 min y verificar si la primera pulsación se pierde.
- [ ] Mantener un botón presionado: debe sumar un solo punto.
- [ ] Tras ganar un set y confirmar, el botón izquierdo suma al equipo que **ahora** está a la izquierda.
- [ ] Pantalla del celular no se apaga durante 15 min con la voz activa.
- [ ] iPhone: interruptor de silencio desactivado y volumen arriba.
- [ ] Con Spotify sonando: anotar si la voz pausa la música o la baja (por dispositivo).
