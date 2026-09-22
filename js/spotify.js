// Spotify: login PKCE (sin backend), API web y Web Playback SDK.
import { CONFIG } from './config.js';

const SCOPES = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-read-playback-state',
  'user-modify-playback-state',
  'streaming',
  'user-read-email',
  'user-read-private',
].join(' ');

const K = { client: 'bingo.clientId', auth: 'bingo.auth', verifier: 'bingo.pkce' };

const store = {
  get(k) {
    try {
      return JSON.parse(localStorage.getItem(k));
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
  del(k) {
    try {
      localStorage.removeItem(k);
    } catch {}
  },
};

export class SpotifyError extends Error {
  constructor(message, status, reason) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

export const getClientId = () => CONFIG.CLIENT_ID || store.get(K.client) || '';
export const setClientId = (id) => store.set(K.client, id.trim());

/** URI que hay que registrar en el panel de Spotify (debe coincidir exactamente). */
export function redirectUri() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

export const isConnected = () => !!store.get(K.auth)?.refresh_token;

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function login() {
  const clientId = getClientId();
  if (!clientId) throw new Error('Falta el Client ID de Spotify.');
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  store.set(K.verifier, verifier);
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  });
  location.href = 'https://accounts.spotify.com/authorize?' + params;
}

export function logout() {
  store.del(K.auth);
  store.del(K.verifier);
  disconnectPlayer();
}

async function tokenRequest(body) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: getClientId(), ...body }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new SpotifyError(json.error_description || json.error || 'Error de autenticación', res.status);
  const prev = store.get(K.auth) || {};
  store.set(K.auth, {
    access_token: json.access_token,
    refresh_token: json.refresh_token || prev.refresh_token,
    expires_at: Date.now() + json.expires_in * 1000,
  });
}

/** Si volvemos de Spotify con ?code=, canjea el código. Devuelve un mensaje de error o null. */
export async function handleRedirect() {
  const p = new URLSearchParams(location.search);
  if (!p.has('code') && !p.has('error')) return null;
  const code = p.get('code');
  const error = p.get('error');
  history.replaceState(null, '', redirectUri());
  if (error) return 'Spotify ha rechazado el acceso: ' + error;
  const verifier = store.get(K.verifier);
  store.del(K.verifier);
  if (!verifier) return 'La sesión de login ha caducado. Vuelve a conectar.';
  try {
    await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: verifier });
    return null;
  } catch (e) {
    return e.message;
  }
}

let refreshing = null;
export async function getToken(force = false) {
  const a = store.get(K.auth);
  if (!a) throw new SpotifyError('No conectado', 401);
  if (!force && a.expires_at - Date.now() > 60000) return a.access_token;
  refreshing ||= tokenRequest({ grant_type: 'refresh_token', refresh_token: a.refresh_token }).finally(() => (refreshing = null));
  try {
    await refreshing;
  } catch (e) {
    if (e.status === 400 || e.status === 401) logout();
    throw e;
  }
  return store.get(K.auth).access_token;
}

export async function api(path, { method = 'GET', body, retry = true } = {}) {
  const url = path.startsWith('http') ? path : 'https://api.spotify.com/v1' + path;
  const res = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + (await getToken()), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && retry) {
    await getToken(true);
    return api(path, { method, body, retry: false });
  }
  if (res.status === 429 && retry) {
    await new Promise((r) => setTimeout(r, (Number(res.headers.get('Retry-After')) || 1) * 1000 + 200));
    return api(path, { method, body, retry: false });
  }
  if (res.status === 204 || res.status === 202) return null;
  const text = await res.text();
  const json = text ? safeJson(text) : null;
  if (!res.ok) {
    throw new SpotifyError(json?.error?.message || `Error ${res.status}`, res.status, json?.error?.reason);
  }
  return json;
}

function safeJson(t) {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

// ---------- Listas ----------

/** Carga las canciones reproducibles de una lista (solo listas propias o colaborativas desde feb-2026). */
export async function loadPlaylist(id) {
  const meta = await api(`/playlists/${id}?fields=id,name`);
  const tracks = [];
  const seen = new Set();
  let skipped = 0;
  let next = `/playlists/${id}/items?limit=50&additional_types=track&market=from_token`;
  while (next) {
    const page = await api(next);
    for (const it of page.items || []) {
      const t = it?.item ?? it?.track; // `item` desde la migración de 2026; `track` como respaldo
      if (!t || t.type !== 'track' || t.is_local || !t.id || t.is_playable === false || seen.has(t.id)) {
        skipped++;
        continue;
      }
      seen.add(t.id);
      tracks.push({ id: t.id, uri: t.uri, name: t.name, artist: (t.artists || []).map((a) => a.name).join(', ') });
    }
    next = page.next;
  }
  return { id: meta.id, name: meta.name, tracks, skipped };
}

// ---------- Reproducción ----------

export async function devices() {
  const r = await api('/me/player/devices');
  return r?.devices || [];
}

const dev = (id) => (id ? '?device_id=' + encodeURIComponent(id) : '');

export const playUri = (uri, deviceId) => api('/me/player/play' + dev(deviceId), { method: 'PUT', body: { uris: [uri] } });
export const pause = (deviceId) => api('/me/player/pause' + dev(deviceId), { method: 'PUT' });
export const resume = (deviceId) => api('/me/player/play' + dev(deviceId), { method: 'PUT' });
export const transfer = (deviceId, play = false) => api('/me/player', { method: 'PUT', body: { device_ids: [deviceId], play } });

// ---------- Web Playback SDK (solo navegadores de escritorio) ----------

let player = null;
let sdkLoading = null;

function loadSdk() {
  if (window.Spotify) return Promise.resolve();
  sdkLoading ||= new Promise((resolve, reject) => {
    window.onSpotifyWebPlaybackSDKReady = resolve;
    const s = document.createElement('script');
    s.src = 'https://sdk.scdn.co/spotify-player.js';
    s.onerror = () => reject(new Error('No se pudo cargar el reproductor de Spotify.'));
    document.head.appendChild(s);
  });
  return sdkLoading;
}

/** Crea el reproductor en este navegador. Resuelve con el device_id. */
export async function connectWebPlayer(onEvent = () => {}) {
  await loadSdk();
  if (player) player.disconnect();
  player = new window.Spotify.Player({
    name: 'Bingo Musical (este navegador)',
    getOAuthToken: (cb) => getToken().then(cb),
    volume: 0.8,
  });
  return new Promise((resolve, reject) => {
    player.addListener('ready', ({ device_id }) => resolve(device_id));
    player.addListener('not_ready', () => onEvent({ type: 'not_ready' }));
    player.addListener('initialization_error', ({ message }) => reject(new Error(message)));
    player.addListener('authentication_error', ({ message }) => reject(new Error(message)));
    player.addListener('account_error', () => reject(new Error('El reproductor web requiere Spotify Premium.')));
    player.addListener('player_state_changed', (s) => onEvent({ type: 'state', paused: s?.paused }));
    player.connect().then((ok) => ok || reject(new Error('No se pudo iniciar el reproductor web.')));
  });
}

/** Debe llamarse desde un gesto del usuario para que el navegador permita el audio. */
export const activateWebPlayer = () => player?.activateElement?.();
export const hasWebPlayer = () => !!player;

export function disconnectPlayer() {
  player?.disconnect();
  player = null;
}
