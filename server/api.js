// Rutas /api/*: sesión (login = comprobar el token de Spotify contra /me) y las partidas
// guardadas de ese usuario (varias, cada una con su propio ID).
import { upsertUser, getUser, listGames, getGame, createGame, updateGame, deleteGame } from './db.js';
import { makeCookie, clearCookie, readSpotifyId } from './session.js';

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function send(res, status, body, extraHeaders) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(JSON.stringify(body));
}

/** Resumen para listar sin mandar el JSON entero de cada partida. */
function summarize(row) {
  let s = {};
  try {
    s = JSON.parse(row.state);
  } catch {}
  const g = s.game;
  return {
    id: row.id,
    playlistName: s.playlist?.name ?? null,
    demo: !!s.playlist?.demo,
    cards: g?.cards?.length ?? 0,
    pos: g?.pos ?? 0,
    total: g?.order?.length ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const GAME_ID = /^\/api\/games\/([^/]+)$/;

/** true si la ruta era de la API (gestionada aquí, bien o mal); false si no. */
export async function handleApi(req, res, url) {
  if (!url.pathname.startsWith('/api/')) return false;

  try {
    if (url.pathname === '/api/session' && req.method === 'POST') {
      const { access_token } = await readJson(req);
      if (!access_token) {
        send(res, 400, { error: 'Falta access_token' });
        return true;
      }
      const r = await fetch('https://api.spotify.com/v1/me', { headers: { Authorization: 'Bearer ' + access_token } });
      if (!r.ok) {
        send(res, 401, { error: 'Token de Spotify no válido' });
        return true;
      }
      const me = await r.json();
      upsertUser(me.id, me.display_name);
      send(res, 200, { ok: true, displayName: me.display_name || me.id }, { 'Set-Cookie': makeCookie(me.id) });
      return true;
    }

    if (url.pathname === '/api/session' && req.method === 'GET') {
      const id = readSpotifyId(req);
      const user = id && getUser(id);
      send(res, 200, user ? { loggedIn: true, displayName: user.display_name } : { loggedIn: false });
      return true;
    }

    if (url.pathname === '/api/logout' && req.method === 'POST') {
      send(res, 200, { ok: true }, { 'Set-Cookie': clearCookie() });
      return true;
    }

    // A partir de aquí, todo necesita sesión.
    const spotifyId = readSpotifyId(req);
    if (!spotifyId) {
      send(res, 401, { error: 'No hay sesión' });
      return true;
    }

    if (url.pathname === '/api/games' && req.method === 'GET') {
      send(res, 200, { games: listGames(spotifyId).map(summarize) });
      return true;
    }

    if (url.pathname === '/api/games' && req.method === 'POST') {
      const body = await readJson(req);
      const id = createGame(spotifyId, JSON.stringify(body));
      send(res, 200, { id });
      return true;
    }

    const gameMatch = url.pathname.match(GAME_ID);
    if (gameMatch && req.method === 'GET') {
      const row = getGame(gameMatch[1], spotifyId);
      if (!row) {
        send(res, 404, { error: 'No encontrada' });
        return true;
      }
      send(res, 200, { state: JSON.parse(row.state), updatedAt: row.updated_at });
      return true;
    }

    if (gameMatch && req.method === 'PUT') {
      const body = await readJson(req);
      const ok = updateGame(gameMatch[1], spotifyId, JSON.stringify(body));
      send(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'No encontrada' });
      return true;
    }

    if (gameMatch && req.method === 'DELETE') {
      const ok = deleteGame(gameMatch[1], spotifyId);
      send(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'No encontrada' });
      return true;
    }

    send(res, 404, { error: 'No encontrado' });
    return true;
  } catch (e) {
    console.error('[api]', e);
    send(res, 500, { error: 'Error interno' });
    return true;
  }
}
