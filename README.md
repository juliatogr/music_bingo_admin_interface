# Bingo Musical (PWA)

Bingo con las canciones de una lista de Spotify. HTML + JS modular sin dependencias, más una API
mínima en Node (sin librerías externas, `node:sqlite` incluido) para que la partida se guarde por
cuenta de Spotify y se recupere igual en cualquier dispositivo donde inicies sesión.

## Cómo se juega

1. **Ajustes**: conecta con Spotify (la lista está fijada en `js/config.js` y se carga sola) y elige el dispositivo donde sonará.
2. **Cartillas**: elige nº de cartillas y canciones en juego → *Generar*. Se guardan en el navegador. Se pueden imprimir (cada una lleva número y código de 4 letras).
3. **Juego**: *Siguiente canción* reproduce la siguiente y la marca como salida. Los recuadros muestran cuántas personas están **a 1 canción** de línea / esquina / bingo (y a 2), y avisan cuando alguien lo completa.
4. **Comprobar**: elige el premio cantado, escribe el nº o el código de la cartilla y confirma si es válido. Puedes conceder el premio (deja de contarse).
5. **Reiniciar**: *Reiniciar partida (mismas cartillas)* o generar unas nuevas desde *Cartillas*.

Reglas: **línea** = una fila completa · **esquina** = las 4 esquinas · **bingo** = toda la cartilla.

### Premios únicos
El orden de salida se sortea al generar las cartillas y se respeta siempre. Con ese orden conocido se generan las cartillas de forma que la primera línea, la primera esquina y el primer bingo los completa **una sola cartilla cada uno**, en **canciones distintas** y con **ganadores distintos**. (Sin fijar el orden sería imposible garantizarlo.) La pestaña Cartillas muestra la garantía (solo para el anfitrión).

## Configurar Spotify

Necesitas **Premium** y crear una app en <https://developer.spotify.com/dashboard>:

- *Redirect URI*: la que muestra la app en Ajustes (debe coincidir exactamente).
  - En local: `http://127.0.0.1:5173/` (Spotify no admite `localhost`).
  - Desplegada: la URL https, p. ej. `https://usuario.github.io/bingo/`.
- APIs: marca *Web API* y *Web Playback SDK*.
- Pon el **Client ID** en `CLIENT_ID` de `js/config.js` (o pégalo en Ajustes la primera vez). No hace falta el secret: usa PKCE.

Limitaciones de Spotify (modo desarrollo, 2026): solo se leen listas **propias o colaborativas**; hasta 5 usuarios autorizados (añádelos en *User Management*). El reproductor «Este navegador» solo funciona en ordenador; en móvil abre la app de Spotify y elige ese dispositivo.

## Sesión entre dispositivos

Al conectar con Spotify, la app registra una sesión propia (cookie firmada, nada de tokens de
Spotify) contra `/api/session`, y a partir de ahí la partida se guarda también en el servidor
(`/api/game`), además de en `localStorage` como hasta ahora. Al iniciar sesión con la misma
cuenta de Spotify en otro dispositivo, se recupera la partida guardada — pero **el login con
Spotify hay que hacerlo en cada dispositivo**, eso no tiene vuelta atrás: la propia app necesita
un token vivo ahí para poder controlar la reproducción desde ese navegador.

En modo demo (sin Spotify) todo sigue siendo 100% local, como antes.

## Ejecutar

```bash
npm start
```
Abre <http://127.0.0.1:5173/> (`PORT` y `HOST` se pueden cambiar con variables de entorno; sin
dependencias que instalar). El mismo proceso sirve también `/api/*`; la partida guardada queda en
`./data/bingo.db` (SQLite, se crea sola, no se sube al repo).

Con Docker, primero crea `.env` a partir de `.env.example` con un `SESSION_SECRET` real:
```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"  # pégalo en .env
docker compose up -d
```
Son dos contenedores en `web_gateway`, con IP fija cada uno (no por nombre — motivo en el
comentario junto a `ipv4_address` del compose: el DNS interno de Docker falla de forma
intermitente en este host):
- `web-project-julia` (nginx, IP `.250`) sirve los archivos estáticos por el 5173, con `/api/`
  reenviado al otro contenedor. Es a este al que apunta el Caddy.
- `web-project-julia-api` (Node, IP `.251`) solo atiende `/api/*`; guarda el SQLite en un volumen
  aparte (`web-project-julia_data`), que sobrevive a que se recree el contenedor.

Ninguno publica puertos en el host; los cambios en los archivos estáticos se ven al recargar sin
reconstruir nada (montados de solo lectura).

Para usarla en el móvil como PWA, publica la carpeta en cualquier hosting estático con HTTPS (GitHub Pages, Netlify…) y añade esa URL como Redirect URI.

`Probar sin Spotify` carga una lista de demostración (no suena nada) para ensayar todo el flujo.

## Pruebas

Abre `http://127.0.0.1:5173/tests/bingo.test.html`: comprueba la unicidad de premios en cientos de partidas y la evaluación/comprobación de cartillas.

## Estructura

- `js/bingo.js` – generación de cartillas y reglas (sin DOM).
- `js/spotify.js` – login PKCE, API y reproductor web.
- `js/backend.js` – llamadas a nuestra propia API (`/api/*`), no a Spotify.
- `js/app.js` – interfaz y estado; junta `localStorage` con el servidor.
- `sw.js`, `manifest.webmanifest` – PWA / offline.
- `server.js` – sirve los archivos estáticos y monta `/api/*` (`server/`). `serve.ps1` es la
  alternativa sin Node, solo para estáticos (sin `/api/*`, así que sin sesión entre dispositivos).
- `server/` – la API: `db.js` (SQLite), `session.js` (cookie firmada), `api.js` (rutas).
