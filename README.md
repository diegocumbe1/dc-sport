# DC Sport Score Beta

Marcador deportivo en tiempo real (beta de voleibol). Un PC o TV muestra el marcador y uno o dos celulares hacen de control remoto. Todos se sincronizan con Socket.IO por **código de sala**.

## Requisitos

- Node.js **20 o superior** (probado con Node 22.17).
- npm.
- Navegador moderno (Chrome, Safari, Edge o Firefox). La voz usa la Web Speech API del navegador.

## Instalación y ejecución

```bash
npm install
npm start            # producción: http://localhost:3000
npm run dev          # desarrollo: se reinicia solo al guardar cambios
npm test             # pruebas de lógica y de integración (servidor + Socket.IO)
```

Variables de entorno opcionales (ver `.env.example`):

| Variable    | Por defecto       | Uso                                                        |
|-------------|-------------------|------------------------------------------------------------|
| `PORT`      | `3000`            | Puerto HTTP                                                |
| `ADMIN_PIN` | `1234`            | PIN de `/admin` y para reconfigurar salas con juego        |
| `DATA_DIR`  | `./data`          | Carpeta de `scores.json`                                   |
| `DATA_FILE` | `DATA_DIR/scores.json` | Ruta exacta del archivo de datos                      |

```bash
ADMIN_PIN=5678 npm start
```

## URLs

| Ruta                                 | Para qué sirve                                                                 |
|--------------------------------------|--------------------------------------------------------------------------------|
| `/`                                  | Inicio: código de sala, **crear tablero**, abrir vistas y copiar enlaces       |
| `/marcador?sala=voley`               | Pantalla del marcador (TV/PC), con pantalla completa y voz opcional           |
| `/control?sala=voley`                | Control de ambos equipos (celular en horizontal)                               |
| `/control?sala=voley&equipo=a`       | Control de **un solo lado** (izquierdo = A, derecho = B), como un pulsador     |
| `/admin?sala=voley`                  | Administración protegida con PIN                                              |
| `/api/health`                        | Estado del servidor (para Render)                                             |
| `/api/rooms/:sala`                   | Estado de una sala en JSON (lectura)                                          |

**Límite por sala:** 1 marcador y 2 controles. Un control por lado si se usa `equipo=a|b`. El admin no cuenta en el límite.

## Uso rápido

1. Abre `http://localhost:3000`, escribe un código de sala (3 a 24 letras, números, `-` o `_`).
2. En **Crear tablero** elige la cantidad de equipos (2 a 6), los puntos por set y, opcionalmente, nombres y colores. Si un nombre queda vacío, el equipo toma el nombre de su color (AZUL, ROJO…). Al crear el tablero aparece un aviso verde con los botones **Abrir marcador** y **Abrir control**.
3. Abre el marcador en la TV o el PC y el control en el celular.

### Control remoto

- **1 toque**: +1 punto. **2 toques rápidos**: −1 punto. El +1 no se envía hasta que vence la ventana de doble toque (350 ms por defecto, configurable en el menú ☰ o con `?dt=400`).
- Cuando termina un set, el control bloquea los toques y pide confirmación para empezar el siguiente. Con equipos en espera ofrece **«Entra X (sale Y)»** o **«Mismos equipos»**.
- En el menú ☰: deshacer, reiniciar set, reiniciar partido (con confirmación), puntos por set, ventana de doble toque, borrar datos locales.

### Reglas implementadas

- Puntos por set: 10, 15, 20, 21 o 25 (por defecto 25). Para ganar el set hace falta diferencia de 2.
- Cierre automático del set y confirmación antes del siguiente. No hay puntajes negativos.
- **Partido abierto**: no hay fin automático y se cuentan los sets ganados. El modo «mejor de N» está implementado pero oculto en la interfaz (comentado en el HTML).
- **3 o más equipos**: dos juegan y el resto espera en cola. La rotación por defecto es «ganador se queda, sale el perdedor y entra el siguiente»; también se puede configurar «mismos equipos».
- Historial de acciones, deshacer (también revierte rotaciones y cierres de set), reiniciar set, reiniciar partido.

### Administración (`/admin`)

- Equipos (2 a 6, nombre y color), equipos en cancha, puntos por set y regla de rotación.
- **Voz del marcador**: activar/desactivar, velocidad, repeticiones, segundos entre repeticiones e idioma (Español Colombia por defecto). En la pantalla del marcador hay que tocar **«🔊 Activar voz»** una vez, porque los navegadores no dejan hablar sin una interacción.
  - **Orden de canto:** primero el equipo con el saque, es decir, el que ganó el último punto (regla de rally). Ejemplos: «Rojo, 7. Azul, 6.», «Empate a 5. Saca Rojo.», «Azul, 24. Rojo, 23. Punto de set para Azul.», «¡Set para Rojo! Quedó 25 a 23.». El marcador muestra 🏐 junto al equipo que saca.
  - **Elegir voz:** el botón ⚙ del marcador lista las voces de ese dispositivo; ⭐ marca las naturales. Si no se elige ninguna, se toma la mejor: es-CO, luego otras latinoamericanas, y se prefieren las voces neuronales o en línea.
  - **Voz colombiana natural (gratis):** abre el marcador en **Microsoft Edge**, que ofrece las voces neuronales «Salomé» y «Gonzalo» (Español, Colombia). En Chrome, la más cercana es «Google español de Estados Unidos». macOS no trae voces colombianas.
- Corrección manual de puntos y sets, deshacer, restablecer marcador y nuevo partido.
- **Salas guardadas**: lista de salas, borrar una sala o **borrar todas** (hay que escribir BORRAR en el modal).
- El PIN se recuerda en ese navegador hasta 4 horas.

### Listas configurables

Todas las listas desplegables (puntos por set, colores, cantidad de equipos, rotación, ventana de doble toque, repeticiones e idiomas de voz) salen de **`public/config/options.json`**. El servidor usa el mismo archivo para validar, así que basta editarlo para agregar o quitar opciones.

## Persistencia

- **Servidor:** cada sala se guarda en `data/scores.json`. La escritura es atómica (archivo temporal + `rename` + `fsync`) y se agrupa cada 250 ms. Al recibir Ctrl+C o SIGTERM se guarda lo pendiente. Las salas sin uso por 30 días se descartan al arrancar. No hace falta base de datos.
- **Navegador:** `localStorage` guarda la sala, el borrador del tablero, el PIN, la ventana de doble toque y el último estado de la sala. Cada valor **vence a las 4 horas**.
- **Borrar:** el botón **«Borrar datos»** del inicio limpia este navegador y, si marcas la opción e ingresas el PIN, borra también la sala del servidor. En control y admin, «Borrar datos locales» solo limpia el navegador. Admin → «Salas guardadas» permite borrar cualquier sala o todas.

## Abrir desde el celular

### Misma red Wi‑Fi

1. Averigua la IP local del Mac:
   ```bash
   ipconfig getifaddr en0      # Wi‑Fi (si no responde, prueba en1)
   ```
   También aparece en la página de inicio cuando la abres desde `localhost`.
2. En el celular abre `http://<IP>:3000/control?sala=voley`.
3. Si no carga, revisa el firewall de macOS (Ajustes → Red → Firewall) y que ambos estén en la misma red.

### Redes distintas (ngrok)

```bash
ngrok http 3000
```

Abre la página de inicio **desde la URL de ngrok** (`https://xxxx.ngrok-free.app`): los enlaces para compartir usarán ese dominio. El cliente Socket.IO prioriza WebSocket y envía el header `ngrok-skip-browser-warning`, así la página de aviso de ngrok free no corta la conexión.

## Probar con dos dispositivos

1. PC: `http://localhost:3000` → crear tablero en la sala `prueba` → **Abrir marcador** → pantalla completa.
2. Celular (ngrok o IP local): `/control?sala=prueba` en horizontal.
3. Toca el lado izquierdo: el marcador del PC suma un punto unos 350 ms después. Con doble toque, resta.
4. Apaga el Wi‑Fi del celular: ambos muestran «Sin conexión». Al volver se resincronizan solos con el estado del servidor.
5. Detén el servidor con Ctrl+C y vuelve a iniciarlo: el marcador sigue igual.

## Despliegue

### Render (recomendado para esta beta)

Render ejecuta un proceso Node permanente con soporte de WebSocket, que es lo que necesita Socket.IO.

1. Sube el proyecto a GitHub (el `.gitignore` excluye `node_modules/` y `data/`).
2. En Render: **New → Web Service** → conecta el repositorio.
3. Runtime **Node** · Build `npm install` · Start `npm start` · Health check `/api/health`.
4. En Environment define `ADMIN_PIN`.
5. **Persistencia:** el disco de las instancias gratuitas es efímero, así que `scores.json` se pierde en cada redeploy, reinicio **o suspensión**. Para conservarlo, agrega un disco persistente (plan pago), móntalo en `/var/data` y define `DATA_DIR=/var/data`.
6. El plan gratuito se suspende tras 15 minutos sin peticiones HTTP ni mensajes WebSocket, y tarda cerca de un minuto en despertar. Durante un partido no se duerme, porque los controles envían mensajes.
7. Usa **una sola instancia**: el estado vive en memoria del proceso y en un archivo local.

### Railway (alternativa con persistencia barata)

Railway también corre un proceso Node permanente con WebSocket y ofrece **volúmenes persistentes**.

1. New Project → Deploy from GitHub repo. Detecta Node y usa `npm start`. El servidor ya lee `PORT` y escucha en `0.0.0.0`.
2. Variables: `ADMIN_PIN` y `DATA_DIR=/data`.
3. Agrega un **Volume** montado en `/data`: así `scores.json` sobrevive a redeploys y reinicios.
4. Genera un dominio público en Settings → Networking.

Planes (verificar en la [página oficial](https://docs.railway.com/pricing/plans), cambian seguido): una prueba con crédito único, luego un plan Free con muy poco crédito mensual (puede no alcanzar para tenerlo encendido todo el mes) y Hobby desde 5 USD/mes con volúmenes de hasta 5 GB.

### Vercel: qué haría falta

**Vercel no puede ejecutar este servidor tal como está.** Sus Functions son serverless, no mantienen un proceso abierto ni actúan como servidor WebSocket, y su sistema de archivos no es persistente. Socket.IO y `scores.json` no funcionarían. Opciones:

| Opción | Cambios necesarios | Comentario |
|---|---|---|
| **A. Todo en Render/Railway/Fly.io** | Ninguno | El camino más simple. |
| **B. Frontend en Vercel + backend en Render** | Hacer configurable la URL del servidor en el cliente (`io(URL)`, cargar `socket.io.js` desde ese servidor o un CDN), habilitar CORS en Socket.IO y en `/api/*`, y apuntar las llamadas `fetch('/api/...')` a esa URL | Vercel solo sirve los archivos de `public/`. |
| **C. Solo Vercel** | Reemplazar Socket.IO por un servicio de tiempo real gestionado (Pusher, Ably o Supabase Realtime) y guardar el estado en un almacén externo (Upstash Redis o Vercel KV), moviendo la lógica de `src/volley.js` a Functions | Reescribe la capa de sincronización y suma servicios externos (con planes gratis limitados). |

Para la beta: **opción A**. Si más adelante se quiere Vercel por el dominio o el CDN, la **opción B** es la menor de las tres.

## Estructura

```
server.js                 Express + Socket.IO: rutas, salas, límites, PIN, persistencia
src/volley.js             Lógica pura de voleibol (sets, rotación, deshacer, validaciones)
src/store.js              Guardado atómico en JSON
public/index.html         Inicio y creación de tablero
public/marcador.html      Marcador para TV/PC
public/control.html       Control remoto táctil
public/admin.html         Administración
public/js/common.js       Conexión, caché local con vencimiento, voz, modales, utilidades
public/css/app.css        Estilos
public/config/options.json Opciones de las listas desplegables
test/                     Pruebas (node:test)
```

## Limitaciones conocidas

- La seguridad es básica: cualquiera que conozca el código de sala puede abrir un control; las acciones de administración piden PIN. No está pensado para torneos públicos.
- Una sola instancia del servidor; no escala horizontalmente sin un almacén compartido.
- La voz depende de las voces instaladas en el dispositivo del marcador, y requiere un toque en «Activar voz» cada vez que se carga la página.
- Si un celular pierde la red, su lugar en la sala se libera en unos 20 segundos.
- Abrir cualquier vista con un código de sala nuevo crea esa sala. Las salas de prueba se borran desde Admin → «Salas guardadas».
- Con 3 o más equipos no hay fin automático de partido, y el «mejor de N» está oculto por ahora.
- El control por lado (`equipo=a|b`) sigue al **lado** de la cancha, no al equipo: si hay rotación, el equipo de ese lado puede cambiar.
