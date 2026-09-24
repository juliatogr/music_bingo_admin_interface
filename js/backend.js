// Habla con nuestra propia API (/api/*), no con Spotify. Cada usuario (identificado por su
// cuenta de Spotify) puede tener varias partidas guardadas; se listan y se cargan por ID.
// La sesión de la app es una cookie httpOnly; aquí solo se maneja con `credentials: 'include'`.

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Registra (o renueva) la sesión del servidor a partir de un access_token de Spotify ya válido. */
export async function syncServerSession(accessToken) {
  try {
    const res = await fetch('/api/session', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: accessToken }),
    });
    if (!res.ok) return null;
    return await safeJson(res); // { ok, displayName }
  } catch {
    return null;
  }
}

export async function serverLogout() {
  try {
    await fetch('/api/logout', { method: 'POST', credentials: 'include' });
  } catch {}
}

/** Resumen de todas las partidas guardadas del usuario de la sesión actual. */
export async function listServerGames() {
  try {
    const res = await fetch('/api/games', { credentials: 'include' });
    if (!res.ok) return [];
    const data = await safeJson(res);
    return data?.games ?? [];
  } catch {
    return [];
  }
}

/** Crea una partida nueva en el servidor; devuelve su ID, o null si falla. */
export async function createServerGame(blob) {
  try {
    const res = await fetch('/api/games', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(blob),
    });
    if (!res.ok) return null;
    const data = await safeJson(res);
    return data?.id ?? null;
  } catch {
    return null;
  }
}

/** Carga una partida concreta por ID: { state, updatedAt } o null si no existe o no es tuya. */
export async function loadServerGame(id) {
  try {
    const res = await fetch(`/api/games/${encodeURIComponent(id)}`, { credentials: 'include' });
    if (!res.ok) return null;
    return await safeJson(res);
  } catch {
    return null;
  }
}

export async function saveServerGame(id, blob) {
  try {
    await fetch(`/api/games/${encodeURIComponent(id)}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(blob),
    });
  } catch {
    // Sin conexión o servidor caído: el localStorage ya guardó la partida, no se pierde nada.
  }
}

export async function deleteServerGame(id) {
  try {
    await fetch(`/api/games/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include' });
  } catch {}
}
