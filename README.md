# Bingo Musical (PWA)

Bingo con las canciones de una lista de Spotify. Sin backend ni dependencias: HTML + JS modular.

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

## Ejecutar

```bash
npm start
```
Abre <http://127.0.0.1:5173/> (`PORT` y `HOST` se pueden cambiar con variables de entorno; sin dependencias que instalar). O, con Docker:

```bash
docker compose up -d
```
(nginx sirve la carpeta en el puerto 5173 **solo dentro de la red Docker `web_gateway`**, en el contenedor `web-project-julia`, que es a lo que apunta el Caddy. No publica puertos en el host; los cambios se ven al recargar. En local usa `node server.js`.)

Para usarla en el móvil como PWA, publica la carpeta en cualquier hosting estático con HTTPS (GitHub Pages, Netlify…) y añade esa URL como Redirect URI.

`Probar sin Spotify` carga una lista de demostración (no suena nada) para ensayar todo el flujo.

## Pruebas

Abre `http://127.0.0.1:5173/tests/bingo.test.html`: comprueba la unicidad de premios en cientos de partidas y la evaluación/comprobación de cartillas.

## Estructura

- `js/bingo.js` – generación de cartillas y reglas (sin DOM).
- `js/spotify.js` – login PKCE, API y reproductor web.
- `js/app.js` – interfaz y estado (`localStorage`).
- `sw.js`, `manifest.webmanifest` – PWA / offline.
- `server.js` – servidor estático en Node (`npm start`). `serve.ps1` es la alternativa sin Node.
