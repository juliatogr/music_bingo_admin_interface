// Usuarios (identificados por su ID de Spotify) y sus partidas. Cada usuario puede tener
// varias partidas guardadas; cada una vive bajo su propio ID, no una por usuario.
// SQLite en un único archivo; en Docker vive en un volumen aparte (ver docker-compose.yml,
// servicio "api"), para que sobreviva a que se recree el contenedor.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const dbPath = resolve(process.env.DB_PATH || './data/bingo.db');
mkdirSync(dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    spotify_id   TEXT PRIMARY KEY,
    display_name TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );
`);

// Migración: la primera versión tenía una única partida por usuario (`games.spotify_id` como
// clave primaria, sin `id`). Si queda una tabla así de una instalación anterior, se sustituye
// por la de varias partidas por usuario; no había nada que mereciera la pena conservar de esa
// versión (fue la primera prueba de esta función).
const gamesCols = db.prepare("SELECT name FROM pragma_table_info('games')").all();
if (gamesCols.length && !gamesCols.some((c) => c.name === 'id')) {
  console.warn('[db] Esquema antiguo de "games" detectado; se sustituye por el de varias partidas por usuario.');
  db.exec('DROP TABLE games;');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    id         TEXT PRIMARY KEY,
    spotify_id TEXT NOT NULL REFERENCES users(spotify_id),
    state      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_games_spotify_id ON games(spotify_id);
`);

const upsertUserStmt = db.prepare(`
  INSERT INTO users (spotify_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(spotify_id) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at
`);
export function upsertUser(spotifyId, displayName) {
  const now = Date.now();
  upsertUserStmt.run(spotifyId, displayName || spotifyId, now, now);
}

const getUserStmt = db.prepare('SELECT spotify_id, display_name FROM users WHERE spotify_id = ?');
export function getUser(spotifyId) {
  return getUserStmt.get(spotifyId) || null;
}

const listGamesStmt = db.prepare('SELECT id, state, created_at, updated_at FROM games WHERE spotify_id = ? ORDER BY updated_at DESC');
export function listGames(spotifyId) {
  return listGamesStmt.all(spotifyId);
}

const getGameStmt = db.prepare('SELECT id, state, created_at, updated_at FROM games WHERE id = ? AND spotify_id = ?');
export function getGame(id, spotifyId) {
  return getGameStmt.get(id, spotifyId) || null;
}

const insertGameStmt = db.prepare('INSERT INTO games (id, spotify_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
export function createGame(spotifyId, stateJson) {
  const id = randomUUID();
  const now = Date.now();
  insertGameStmt.run(id, spotifyId, stateJson, now, now);
  return id;
}

const updateGameStmt = db.prepare('UPDATE games SET state = ?, updated_at = ? WHERE id = ? AND spotify_id = ?');
/** true si existía y era de ese usuario; false si no (no toca nada ajeno). */
export function updateGame(id, spotifyId, stateJson) {
  return updateGameStmt.run(stateJson, Date.now(), id, spotifyId).changes > 0;
}

const deleteGameStmt = db.prepare('DELETE FROM games WHERE id = ? AND spotify_id = ?');
export function deleteGame(id, spotifyId) {
  return deleteGameStmt.run(id, spotifyId).changes > 0;
}
