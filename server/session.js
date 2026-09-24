// Sesión de la app = una cookie firmada con el ID de Spotify del usuario, nada más.
// No guarda tokens de Spotify: cada dispositivo sigue autenticándose con Spotify por su cuenta
// (es la propia app la que necesita un token vivo ahí para controlar la reproducción); esta
// cookie solo sirve para saber de quién son las cartillas al leer/guardar en /api/game.
import { createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'bingo_sid';
const MAX_AGE = 60 * 60 * 24 * 180; // 180 días

const SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  console.warn('[session] Falta SESSION_SECRET: usando un secreto de desarrollo. No uses esto en producción.');
}
const secret = SECRET || 'dev-insecure-secret-cambia-esto';

function sign(value) {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

export function makeCookie(spotifyId) {
  const value = encodeURIComponent(spotifyId) + '.' + sign(spotifyId);
  return `${COOKIE_NAME}=${value}; Path=/api; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}`;
}

export function clearCookie() {
  return `${COOKIE_NAME}=; Path=/api; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  return out;
}

/** Devuelve el spotify_id si la cookie es válida, o null. */
export function readSpotifyId(req) {
  const raw = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot < 0) return null;
  const value = decodeURIComponent(raw.slice(0, dot));
  const sig = raw.slice(dot + 1);
  const expected = sign(value);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return value;
}
