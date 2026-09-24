import * as sp from './spotify.js';
import { CONFIG } from './config.js';
import { PRIZES, PRIZE_LABEL, generateGame, rankMap, evaluate, summarize, findCard, checkClaim, cornerIndexes } from './bingo.js';
import {
  syncServerSession,
  serverLogout,
  listServerGames,
  createServerGame,
  loadServerGame,
  saveServerGame,
} from './backend.js';

// ---------- Estado y persistencia ----------
//
// Fuente de la verdad mientras no hay sesión de Spotify: el localStorage de este navegador
// (como siempre; modo demo se queda así para siempre, sin servidor de por medio).
//
// Con sesión, cada partida generada se crea como un registro propio en el servidor
// (`state.currentGameId`) y cada `save()` la actualiza ahí también. Desde otro dispositivo, con
// la misma cuenta de Spotify, se ve el listado de partidas (`ui.games`, pestaña Cartillas) y se
// elige cuál continuar — no se adivina sola cuál, puede haber varias abiertas a la vez.

const STATE_KEY = 'bingo.state.v1';
const defaults = () => ({ playlist: null, config: { n: 20, rows: 3, cols: 5, pool: 60 }, game: null, updatedAt: 0, currentGameId: null });

function loadState() {
  try {
    return { ...defaults(), ...JSON.parse(localStorage.getItem(STATE_KEY)) };
  } catch {
    return defaults();
  }
}
/** Lo único que se manda al servidor: nunca el `currentGameId` (es solo bookkeeping local). */
function gameBlob() {
  return { playlist: state.playlist, config: state.config, game: state.game, updatedAt: state.updatedAt };
}
function save() {
  state.updatedAt = Date.now();
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    toast('No se pudo guardar en este navegador (¿almacenamiento lleno?).', 'error');
  }
  if (ui.serverSession && state.currentGameId) saveServerGame(state.currentGameId, gameBlob()); // en segundo plano
}

const state = loadState();
const ui = {
  tab: 'setup',
  devices: [],
  // '' = dispositivo activo, '__web__' = este navegador, o un device_id.
  // Por defecto, en ordenador suena en el propio navegador (el reproductor web no existe en móviles).
  deviceChoice: localStorage.getItem('bingo.device') ?? (/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ? '' : '__web__'),
  webDeviceId: null,
  playing: false,
  prize: 'line',
  lastCheck: null, // { query, prize }
  sort: 'n',
  showGuarantee: false, // la garantía empieza borrosa para no destripar la partida
  wake: null,
  serverSession: false, // hay cookie de sesión válida contra nuestra API
  accountName: null,
  games: [], // resumen de las partidas guardadas en el servidor para esta cuenta
};

// ---------- Utilidades ----------

const $ = (s, root = document) => root.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tagNum = (n) => '#' + String(n).padStart(2, '0');
const tagFull = (c) => `${tagNum(c.n)} <span class="code">${esc(c.code)}</span>`;

function toast(msg, kind = 'info', ms = 5000) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = esc(msg).replace(/\n/g, '<br>');
  el.addEventListener('click', () => el.remove());
  box.appendChild(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => el.remove(), ms);
}

function setMsg(id, text, kind = 'error') {
  const el = $(id);
  el.hidden = !text;
  el.textContent = text || '';
  el.className = 'msg ' + kind;
}

const game = () => state.game;
let rankCache = { order: null, rank: null }; // fuera de `state` para no serializarlo
const rankOf = () => {
  if (!state.game) return null;
  if (rankCache.order !== state.game.order) rankCache = { order: state.game.order, rank: rankMap(state.game.order) };
  return rankCache.rank;
};

// ---------- Pestañas ----------

function showTab(name) {
  ui.tab = name;
  for (const s of document.querySelectorAll('.tab')) s.hidden = s.id !== 'tab-' + name;
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('active', b.dataset.tab === name);
  if (name === 'game') requestWake();
  window.scrollTo(0, 0);
}

async function requestWake() {
  try {
    if ('wakeLock' in navigator && !ui.wake) {
      ui.wake = await navigator.wakeLock.request('screen');
      ui.wake.addEventListener('release', () => (ui.wake = null));
    }
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && ui.tab === 'game') requestWake();
});

// ---------- Render: cabecera / ajustes ----------

function renderStatus() {
  const pill = $('#status-pill');
  if (state.playlist?.demo) {
    pill.textContent = 'Modo demo';
    pill.className = 'pill warn';
  } else if (sp.isConnected()) {
    pill.textContent = 'Spotify conectado';
    pill.className = 'pill ok';
  } else {
    pill.textContent = 'Sin conectar';
    pill.className = 'pill';
  }
  $('#btn-connect').textContent = sp.isConnected() ? 'Reconectar' : 'Conectar';
  $('#btn-disconnect').hidden = !sp.isConnected();
  const info = $('#account-info');
  info.hidden = !ui.accountName;
  if (ui.accountName) info.textContent = `Partida sincronizada como ${ui.accountName}: se recupera igual en cualquier dispositivo donde inicies sesión.`;
}

function renderPlaylists() {
  const cur = state.playlist;
  $('#playlist-current').innerHTML = cur
    ? `<b>${esc(cur.name)}</b> · ${cur.tracks.length} canciones${cur.skipped ? ` <span class="muted">(${cur.skipped} omitidas: locales, podcasts o no disponibles)</span>` : ''}`
    : 'Ninguna lista cargada.';
  $('#btn-reload').hidden = !sp.isConnected();
}

function renderDevices() {
  const sel = $('#device-select');
  const opts = [
    ['', 'Dispositivo activo de Spotify'],
    ['__web__', 'Este navegador (solo ordenador)'],
    ...ui.devices.map((d) => [d.id, `${d.name} (${d.type})`]),
  ];
  sel.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
  sel.value = opts.some(([v]) => v === ui.deviceChoice) ? ui.deviceChoice : '';
}

async function refreshDevices() {
  if (!sp.isConnected()) return;
  try {
    ui.devices = (await sp.devices()).filter((d) => d.id && !/Bingo Musical/.test(d.name));
    setMsg('#device-msg', '');
  } catch (e) {
    setMsg('#device-msg', e.message);
  }
  renderDevices();
}

async function chooseDevice(value) {
  ui.deviceChoice = value;
  localStorage.setItem('bingo.device', value);
  setMsg('#device-msg', '');
  if (value === '__web__') await startWebPlayer();
}

async function startWebPlayer() {
  if (!sp.isConnected()) return;
  setMsg('#device-msg', 'Iniciando reproductor en este navegador…', 'info');
  try {
    const timeout = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('El reproductor web no está disponible aquí. En móvil usa la app de Spotify y elige el dispositivo en la lista.')), 10000)
    );
    ui.webDeviceId = await Promise.race([sp.connectWebPlayer(), timeout]);
    setMsg('#device-msg', 'Reproductor del navegador listo.', 'ok');
  } catch (e) {
    ui.webDeviceId = null;
    setMsg('#device-msg', e.message);
  }
}

function currentDeviceId() {
  if (ui.deviceChoice === '__web__') return ui.webDeviceId;
  return ui.deviceChoice || undefined;
}

// ---------- Render: cartillas ----------

function cardGridHtml(card, g, opts = {}) {
  const { marks = null, missing = null, print = false } = opts;
  const corners = new Set(cornerIndexes(g.rows, g.cols));
  const cells = card.cells
    .map((id, i) => {
      const t = g.tracks[id];
      const cls = ['cell', marks ? (marks[i] ? 'on' : 'off') : '', corners.has(i) ? 'corner' : '', missing?.includes(id) ? 'miss' : ''].join(' ');
      return `<div class="${cls}"><b>${esc(t.name)}</b><small>${esc(t.artist)}</small></div>`;
    })
    .join('');
  return `<div class="grid${print ? ' print' : ''}" style="--cols:${g.cols}">${cells}</div>`;
}

function renderGamesList() {
  const box = $('#games-list');
  if (!ui.serverSession) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  if (!ui.games.length) {
    box.innerHTML = `<div class="card"><h3>Tus partidas</h3><p class="muted small-text">Ninguna guardada todavía con ${esc(ui.accountName || 'esta cuenta')}; genera cartillas abajo.</p></div>`;
    return;
  }
  box.innerHTML = `<div class="card list">
    <h3>Tus partidas <span class="muted small-text">(${esc(ui.accountName || '')})</span></h3>
    ${ui.games
      .map((gm) => {
        const label = gm.demo ? 'Demo' : gm.playlistName || 'Sin lista';
        const active = gm.id === state.currentGameId;
        return `<button class="row-card${active ? ' active' : ''}" data-action="open-server-game" data-id="${esc(gm.id)}">
          <span class="tag">${esc(label)}${active ? ' <span class="muted small-text">(esta)</span>' : ''}</span>
          <span class="stat">${gm.pos}/${gm.total} canciones</span>
          <span class="muted small-text">${new Date(gm.updatedAt).toLocaleString()}</span>
        </button>`;
      })
      .join('')}
  </div>`;
}

async function refreshGamesList() {
  ui.games = await listServerGames();
  renderGamesList();
}

function renderCardsTab() {
  renderGamesList();
  const g = game();
  const cfg = state.config;
  $('#cfg-n').value = cfg.n;
  $('#cfg-pool').value = cfg.pool;
  $('#cfg-rows').value = cfg.rows;
  $('#cfg-cols').value = cfg.cols;
  const total = state.playlist?.tracks.length;
  $('#gen-hint').textContent = total
    ? `La lista tiene ${total} canciones. Se sorteará el orden de salida y se generarán cartillas de ${cfg.rows}×${cfg.cols} = ${cfg.rows * cfg.cols} canciones, de forma que la primera línea, la primera esquina y el primer bingo los complete una sola cartilla cada uno, y en canciones distintas.`
    : 'Primero elige una lista en Ajustes.';

  $('#cards-toolbar').hidden = !g;
  if (!g) {
    $('#guarantee').innerHTML = '';
    $('#cards-list').innerHTML = '';
    return;
  }

  const shown = ui.showGuarantee;
  const eye = shown
    ? '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
    : '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  $('#guarantee').innerHTML = `<div class="card note">
    <div class="dlg-head">
      <h3>Garantía de premios únicos <span class="muted small-text">(solo para el anfitrión)</span></h3>
      <button class="icon" data-action="toggle-guarantee" aria-pressed="${shown}" aria-label="${shown ? 'Ocultar' : 'Mostrar'} la garantía" title="${shown ? 'Ocultar' : 'Mostrar'}">${eye}</button>
    </div>
    <div class="${shown ? '' : 'blurred'}" ${shown ? '' : 'aria-hidden="true"'}>
      <ul class="plain">
        ${PRIZES.map((p) => `<li><b>${PRIZE_LABEL[p]}</b>: la completa solo la cartilla ${tagNum(g.stats[p].n)} en la canción nº ${g.stats[p].call}</li>`).join('')}
      </ul>
      <p class="muted small-text">${g.cards.length} cartillas · ${g.order.length} canciones en juego · el orden de salida está fijado; las canciones se reproducen siempre en ese orden.</p>
    </div>
  </div>`;

  const rank = rankOf();
  const rows = g.cards.map((card) => ({ card, ev: evaluate(card, rank, g.pos, g.rows, g.cols) }));
  if (ui.sort !== 'n') rows.sort((a, b) => a.ev[ui.sort].need - b.ev[ui.sort].need || a.card.n - b.card.n);
  $('#sort').value = ui.sort;
  const stat = (ev, p, label) => {
    const s = ev[p];
    const cls = s.need === 0 ? 'ok' : s.need === 1 ? 'warn' : '';
    return `<span class="stat ${cls}">${label} ${s.marked}/${s.size}</span>`;
  };
  $('#cards-list').innerHTML = `<div class="card list">${rows
    .map(
      ({ card, ev }) => `<button class="row-card" data-action="open-card" data-n="${card.n}">
        <span class="tag">${tagFull(card)}</span>
        ${stat(ev, 'line', 'Línea')}${stat(ev, 'corner', 'Esq.')}${stat(ev, 'bingo', 'Bingo')}
      </button>`
    )
    .join('')}</div>`;
}

function openCard(n) {
  const g = game();
  const card = g.cards.find((c) => c.n === n);
  const ev = evaluate(card, rankOf(), g.pos, g.rows, g.cols);
  const dlg = $('#card-dialog');
  dlg.innerHTML = `<div class="dlg-head"><h3>Cartilla ${tagFull(card)}</h3><button class="small" data-action="close-dialog">Cerrar</button></div>
    ${cardGridHtml(card, g, { marks: ev.marks })}
    <p class="muted">Línea ${ev.line.marked}/${ev.line.size} · Esquina ${ev.corner.marked}/4 · Bingo ${ev.bingo.marked}/${ev.bingo.size}</p>`;
  dlg.showModal();
}

function printCards() {
  const g = game();
  if (!g) return;
  $('#print-area').innerHTML = g.cards
    .map(
      (c) => `<article class="print-card">
        <header><b>🎵 Bingo Musical</b><span>Cartilla ${tagNum(c.n)} · <span class="code">${esc(c.code)}</span></span></header>
        ${cardGridHtml(c, g, { print: true })}
        <footer>Línea = una fila completa · Esquina = las 4 esquinas · Bingo = toda la cartilla</footer>
      </article>`
    )
    .join('');
  window.print();
}

// ---------- Render: juego ----------

function renderGame() {
  const view = $('#game-view');
  const g = game();
  if (!g) {
    view.innerHTML = `<div class="card"><p>No hay partida. Genera las cartillas en la pestaña <b>Cartillas</b>.</p><button data-action="go-cards">Ir a Cartillas</button></div>`;
    return;
  }
  const total = g.order.length;
  const cur = g.pos > 0 ? g.tracks[g.order[g.pos - 1]] : null;
  const finished = g.pos >= total;
  const rank = rankOf();
  const sum = summarize(g.cards, rank, g.pos, g.rows, g.cols, g.awarded);

  const tile = (p) => {
    const s = sum[p];
    if (g.awarded[p]) {
      return `<div class="tile done"><h3>${PRIZE_LABEL[p]}</h3><div class="big">✔</div><div>Concedido a ${tagNum(g.awarded[p])}</div></div>`;
    }
    return `<div class="tile ${s.ready.length ? 'ready' : s.one.length ? 'warn' : ''}">
      <h3>${PRIZE_LABEL[p]}</h3>
      <div class="big">${s.one.length}</div>
      <div>${s.one.length === 1 ? 'persona a' : 'personas a'} 1 canción</div>
      ${s.one.length ? `<div class="tags">${s.one.map(tagNum).join(' ')}</div>` : ''}
      <div class="muted small-text">A 2: ${s.two.length}</div>
      ${s.ready.length ? `<div class="claim">🎉 Ya lo tienen: ${s.ready.map(tagNum).join(' ')}</div>` : ''}
    </div>`;
  };

  const played = g.order
    .slice(0, g.pos)
    .map((id, i) => ({ i: i + 1, t: g.tracks[id] }))
    .reverse();

  view.innerHTML = `
    <div class="card now">
      <div class="muted">Canción ${g.pos} de ${total}${g.demo ? ' · demo (sin sonido)' : ''}</div>
      ${
        cur
          ? `<div class="song">${esc(cur.name)}</div><div class="artist">${esc(cur.artist)}</div>`
          : `<div class="song muted">Pulsa «Siguiente canción» para empezar</div>`
      }
      <p id="play-msg" class="msg" hidden></p>
      <button class="primary block huge" data-action="next" ${finished ? 'disabled' : ''}>${finished ? 'Se acabaron las canciones' : g.pos === 0 ? '▶ Empezar' : '⏭ Siguiente canción'}</button>
      <div class="row controls">
        <button data-action="toggle-pause" ${cur ? '' : 'disabled'}>${ui.playing ? '⏸ Pausa' : '▶ Reanudar'}</button>
        <button data-action="repeat" ${cur ? '' : 'disabled'}>🔁 Repetir</button>
        <button data-action="undo" ${g.pos ? '' : 'disabled'}>↩ Deshacer última</button>
      </div>
    </div>
    <div class="tiles">${PRIZES.map(tile).join('')}</div>
    <div class="card">
      <h3>Ya han salido (${g.pos})</h3>
      ${played.length ? `<ol class="played" reversed>${played.map((p) => `<li value="${p.i}"><b>${esc(p.t.name)}</b> <span class="muted">${esc(p.t.artist)}</span></li>`).join('')}</ol>` : '<p class="muted">Todavía no ha salido ninguna.</p>'}
    </div>`;
}

// ---------- Juego: acciones ----------

async function playTrack(track) {
  if (game().demo) return;
  const device = currentDeviceId();
  if (ui.deviceChoice === '__web__') {
    if (!ui.webDeviceId) await startWebPlayer();
    if (!ui.webDeviceId) throw new Error($('#device-msg').textContent || 'El reproductor del navegador no está listo. Revisa Ajustes.');
    sp.activateWebPlayer();
  }
  try {
    await sp.playUri(track.uri, device);
  } catch (e) {
    if (e.status === 404 || e.reason === 'NO_ACTIVE_DEVICE') {
      // Sin dispositivo activo: probar con cualquiera de los que Spotify ve conectados.
      const list = device ? [] : await sp.devices().catch(() => []);
      const d = list.find((x) => x.is_active) || list.find((x) => !x.is_restricted);
      if (d) {
        await sp.playUri(track.uri, d.id);
        ui.deviceChoice = d.id;
        localStorage.setItem('bingo.device', d.id);
        ui.devices = list.filter((x) => x.id);
        renderDevices();
        return;
      }
      throw new Error(
        'Spotify no ve ningún dispositivo. Abre la app de Spotify (móvil u ordenador) y dale a reproducir un momento, o elige «Este navegador» en Ajustes (solo ordenador).'
      );
    }
    if (e.status === 403) throw new Error('Spotify no permite reproducir (¿cuenta Premium?): ' + e.message);
    throw e;
  }
}

// Un único aviso por canción, con una línea por premio que haya cambiado.
function announceChanges(before, after) {
  const lines = [];
  let ready = false;
  for (const p of PRIZES) {
    if (!after[p].open) continue;
    const newReady = after[p].ready.filter((n) => !before[p].ready.includes(n));
    const newOne = after[p].one.filter((n) => !before[p].one.includes(n));
    if (newReady.length) {
      ready = true;
      lines.push(`🎉 ${PRIZE_LABEL[p]} completa: ${newReady.map(tagNum).join(' ')}`);
    }
    if (newOne.length) {
      const n = after[p].one.length;
      lines.push(`⚠️ ${PRIZE_LABEL[p]}: ${n} ${n === 1 ? 'persona a' : 'personas a'} 1 canción (nuevas: ${newOne.map(tagNum).join(' ')})`);
    }
  }
  if (!lines.length) return;
  toast(lines.join('\n'), ready ? 'ok' : 'warn', ready ? 8000 : 5000);
  if (ready) navigator.vibrate?.([120, 60, 120]);
}

async function nextSong() {
  const g = game();
  if (!g || g.pos >= g.order.length || ui.busy) return;
  ui.busy = true;
  try {
    const track = g.tracks[g.order[g.pos]];
    await playTrack(track);
    const before = summarize(g.cards, rankOf(), g.pos, g.rows, g.cols, g.awarded);
    g.pos++;
    ui.playing = !g.demo;
    save();
    renderGame();
    renderCardsTab();
    announceChanges(before, summarize(g.cards, rankOf(), g.pos, g.rows, g.cols, g.awarded));
  } catch (e) {
    renderGame();
    setMsg('#play-msg', e.message);
  } finally {
    ui.busy = false;
  }
}

async function repeatSong() {
  const g = game();
  if (!g || !g.pos) return;
  try {
    await playTrack(g.tracks[g.order[g.pos - 1]]);
    ui.playing = !g.demo;
    renderGame();
  } catch (e) {
    setMsg('#play-msg', e.message);
  }
}

async function togglePause() {
  const g = game();
  if (!g || g.demo) return;
  try {
    if (ui.playing) await sp.pause(currentDeviceId());
    else await sp.resume(currentDeviceId());
    ui.playing = !ui.playing;
    renderGame();
  } catch (e) {
    setMsg('#play-msg', e.message);
  }
}

function undoSong() {
  const g = game();
  if (!g || !g.pos) return;
  g.pos--;
  save();
  renderGame();
  renderCardsTab();
  toast('Última canción retirada de las que han salido.');
}

// ---------- Generación / reinicio ----------

function readConfig() {
  const int = (id) => parseInt($(id).value, 10);
  const cfg = { n: int('#cfg-n'), pool: int('#cfg-pool'), rows: int('#cfg-rows'), cols: int('#cfg-cols') };
  if (!(cfg.n >= 1 && cfg.n <= 500)) throw new Error('Cartillas: entre 1 y 500.');
  if (!(cfg.rows >= 2 && cfg.rows <= 5)) throw new Error('Filas: entre 2 y 5.');
  if (!(cfg.cols >= 3 && cfg.cols <= 7)) throw new Error('Columnas: entre 3 y 7.');
  if (!(cfg.pool > cfg.rows * cfg.cols)) throw new Error(`Las canciones en juego deben ser más de ${cfg.rows * cfg.cols}.`);
  return cfg;
}

async function generate() {
  setMsg('#gen-msg', '');
  if (!state.playlist) return setMsg('#gen-msg', 'Primero elige una lista de reproducción en Ajustes.');
  let cfg;
  try {
    cfg = readConfig();
  } catch (e) {
    return setMsg('#gen-msg', e.message);
  }
  if (game() && !confirm('Esto crea una partida nueva; la actual queda guardada tal cual y se puede retomar desde «Tus partidas». ¿Continuar?')) return;
  try {
    const g = generateGame({ tracks: state.playlist.tracks, n: cfg.n, rows: cfg.rows, cols: cfg.cols, pool: cfg.pool });
    state.config = cfg;
    state.game = { ...g, pos: 0, awarded: {}, demo: !!state.playlist.demo, createdAt: Date.now() };
    state.currentGameId = null; // partida nueva: id nuevo si hay sesión, o ninguno en local/demo
    ui.playing = false;
    ui.lastCheck = null;
    ui.showGuarantee = false;
    save();
    if (ui.serverSession && !state.playlist.demo) {
      const id = await createServerGame(gameBlob());
      if (id) {
        state.currentGameId = id;
        save(); // ahora sí queda enlazada con el servidor
        await refreshGamesList();
      }
    }
    renderAll();
    toast(`Generadas ${g.cards.length} cartillas.`, 'ok');
  } catch (e) {
    setMsg('#gen-msg', e.message);
  }
}

function resetGame() {
  const g = game();
  if (!g) return;
  if (!confirm('Se borrarán las canciones ya reproducidas y los premios concedidos, manteniendo las mismas cartillas. ¿Continuar?')) return;
  g.pos = 0;
  g.awarded = {};
  ui.playing = false;
  ui.lastCheck = null;
  save();
  renderAll();
  toast('Partida reiniciada con las mismas cartillas.');
}

// ---------- Comprobar ----------

function renderCheck() {
  const g = game();
  const out = $('#check-result');
  const awards = $('#awards');
  if (!g) {
    out.innerHTML = '<div class="card"><p class="muted">No hay partida en curso.</p></div>';
    awards.innerHTML = '';
    return;
  }
  awards.innerHTML = `<div class="card"><h3>Premios concedidos</h3><ul class="plain">${PRIZES.map((p) =>
    g.awarded[p]
      ? `<li>✔ <b>${PRIZE_LABEL[p]}</b>: cartilla ${tagNum(g.awarded[p])} <button class="small" data-action="revoke" data-prize="${p}">Anular</button></li>`
      : `<li class="muted">${PRIZE_LABEL[p]}: pendiente</li>`
  ).join('')}</ul></div>`;

  if (!ui.lastCheck) {
    out.innerHTML = '';
    return;
  }
  const { query, prize } = ui.lastCheck;
  const card = findCard(g.cards, query);
  if (!card) {
    out.innerHTML = `<div class="card verdict bad"><h3>✘ No existe esa cartilla</h3><p>No hay ninguna cartilla con «${esc(query)}».</p></div>`;
    return;
  }
  const r = checkClaim({ card, cards: g.cards, prize, rank: rankOf(), pos: g.pos, rows: g.rows, cols: g.cols, awarded: g.awarded });
  let body;
  if (!r.valid) {
    const need = r.ev[prize].need;
    body = `<h3>✘ ${PRIZE_LABEL[prize]} NO válida</h3>
      <p>A la cartilla ${tagFull(card)} le faltan <b>${need}</b> ${need === 1 ? 'canción' : 'canciones'} por salir:</p>
      <ul class="plain">${r.missing.map((id) => `<li>${esc(g.tracks[id].name)} <span class="muted">${esc(g.tracks[id].artist)}</span></li>`).join('')}</ul>`;
  } else {
    const lines = [`<p>Completada en la canción nº <b>${r.call}</b> (van ${g.pos}).</p>`];
    if (r.awardedTo) {
      lines.push(`<p class="warn-text">⚠ Este premio ya se concedió a la cartilla ${tagNum(r.awardedTo)}${r.awardedTo === card.n ? ' (esta misma)' : ''}.</p>`);
    } else if (r.earlier.length) {
      lines.push(`<p class="warn-text">⚠ Ojo: la cartilla ${r.earlier.map((c) => tagNum(c.n)).join(', ')} lo completó antes (canción nº ${r.firstCall}) sin cantarlo.</p>`);
    } else {
      lines.push('<p>Es la primera cartilla en completarlo.</p>');
    }
    if (!r.awardedTo) {
      lines.push(`<button class="primary block" data-action="award" data-n="${card.n}" data-prize="${prize}">Conceder ${PRIZE_LABEL[prize]} a ${tagNum(card.n)}</button>`);
    }
    body = `<h3>✔ ${PRIZE_LABEL[prize]} válida</h3>` + lines.join('');
  }
  out.innerHTML = `<div class="card verdict ${r.valid ? 'good' : 'bad'}">${body}
    <div class="check-grid">${cardGridHtml(card, g, { marks: r.ev.marks, missing: r.valid ? null : r.missing })}</div></div>`;
}

function check(e) {
  e.preventDefault();
  const q = $('#check-tag').value.trim();
  if (!q) return;
  ui.lastCheck = { query: q, prize: ui.prize };
  renderCheck();
}

// ---------- Listas de Spotify ----------

async function loadFixedPlaylist() {
  toast('Cargando canciones…');
  try {
    state.playlist = await sp.loadPlaylist(CONFIG.PLAYLIST_ID);
    const cells = state.config.rows * state.config.cols;
    state.config.pool = Math.max(cells + 1, Math.min(state.config.pool, state.playlist.tracks.length));
    save();
    renderAll();
    toast(`«${state.playlist.name}»: ${state.playlist.tracks.length} canciones.`, 'ok');
    if (state.playlist.tracks.length <= state.config.rows * state.config.cols) {
      toast('La lista tiene muy pocas canciones para estas cartillas.', 'warn');
    }
  } catch (e) {
    const hint = e.status === 403 || e.status === 404 ? ' (la lista debe ser de la cuenta conectada o colaborativa)' : '';
    toast(e.message + hint, 'error', 8000);
  }
}

function loadDemo() {
  const artists = ['Los Ejemplos', 'Ana Prueba', 'Banda Demo', 'DJ Test', 'Coro Aleatorio', 'Trío Muestra'];
  const tracks = Array.from({ length: 90 }, (_, i) => ({
    id: 'demo' + (i + 1),
    uri: 'demo:' + (i + 1),
    name: `Canción de prueba ${i + 1}`,
    artist: artists[i % artists.length],
  }));
  state.playlist = { id: 'demo', name: 'Lista de demostración', tracks, demo: true, skipped: 0 };
  state.config.pool = 60;
  save();
  renderAll();
  toast('Lista de demostración cargada (no suena nada).', 'ok');
  showTab('cards');
}

// ---------- Eventos ----------

const actions = {
  'copy-redirect': async () => {
    try {
      await navigator.clipboard.writeText(sp.redirectUri());
      toast('URI copiada.', 'ok');
    } catch {
      toast('Cópiala a mano: ' + sp.redirectUri());
    }
  },
  connect: async () => {
    const id = $('#client-id').value.trim();
    if (!id) return setMsg('#auth-msg', 'Pega primero el Client ID de tu app de Spotify.');
    sp.setClientId(id);
    try {
      await sp.login();
    } catch (e) {
      setMsg('#auth-msg', e.message);
    }
  },
  disconnect: () => {
    sp.logout();
    serverLogout(); // en segundo plano; no bloquea la desconexión local
    ui.devices = [];
    ui.webDeviceId = null;
    ui.serverSession = false;
    ui.accountName = null;
    ui.games = [];
    renderAll();
  },
  'reload-playlist': async () => {
    if (game() && !confirm('Si cambia la lista, las cartillas actuales dejarán de corresponder a ella. ¿Recargar de todos modos?')) return;
    await loadFixedPlaylist();
  },
  demo: loadDemo,
  'refresh-devices': refreshDevices,
  generate,
  'reset-game': resetGame,
  'toggle-guarantee': () => {
    ui.showGuarantee = !ui.showGuarantee;
    renderCardsTab();
  },
  'open-server-game': async (el) => {
    const id = el.dataset.id;
    if (id === state.currentGameId) return;
    const remote = await loadServerGame(id);
    if (!remote) return toast('No se pudo cargar esa partida.', 'error');
    state.playlist = remote.state.playlist;
    state.config = remote.state.config;
    state.game = remote.state.game;
    state.updatedAt = remote.updatedAt;
    state.currentGameId = id;
    ui.playing = false;
    ui.lastCheck = null;
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(state));
    } catch {}
    renderAll();
    showTab('game');
    toast('Partida cargada.', 'ok');
  },
  print: printCards,
  'open-card': (el) => openCard(Number(el.dataset.n)),
  'close-dialog': () => $('#card-dialog').close(),
  'go-cards': () => showTab('cards'),
  next: nextSong,
  repeat: repeatSong,
  'toggle-pause': togglePause,
  undo: undoSong,
  award: (el) => {
    game().awarded[el.dataset.prize] = Number(el.dataset.n);
    save();
    renderAll();
    toast(`${PRIZE_LABEL[el.dataset.prize]} concedida a ${tagNum(el.dataset.n)}.`, 'ok');
  },
  revoke: (el) => {
    delete game().awarded[el.dataset.prize];
    save();
    renderAll();
  },
};

document.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) return showTab(tab.dataset.tab);
  const chip = e.target.closest('[data-prize]:not([data-action])');
  if (chip) {
    ui.prize = chip.dataset.prize;
    for (const c of document.querySelectorAll('#prize-chips .chip')) {
      c.classList.toggle('active', c === chip);
      c.setAttribute('aria-checked', c === chip);
    }
    if (ui.lastCheck) {
      ui.lastCheck.prize = ui.prize;
      renderCheck();
    }
    return;
  }
  const el = e.target.closest('[data-action]');
  if (el && actions[el.dataset.action]) actions[el.dataset.action](el);
  if (e.target === $('#card-dialog')) $('#card-dialog').close();
});

$('#check-form').addEventListener('submit', check);
$('#sort').addEventListener('change', (e) => {
  ui.sort = e.target.value;
  renderCardsTab();
});
$('#device-select').addEventListener('change', (e) => chooseDevice(e.target.value));
$('#client-id').addEventListener('change', (e) => sp.setClientId(e.target.value));

function renderAll() {
  renderStatus();
  renderPlaylists();
  renderDevices();
  renderCardsTab();
  renderGame();
  renderCheck();
}

// ---------- Arranque ----------

async function init() {
  $('#client-id').value = sp.getClientId();
  if (CONFIG.CLIENT_ID) $('#client-id').closest('label').hidden = true;
  $('#redirect-uri').textContent = sp.redirectUri();
  const err = await sp.handleRedirect();
  renderAll();
  showTab(state.game ? 'game' : state.playlist ? 'cards' : 'setup');
  if (err) {
    showTab('setup');
    setMsg('#auth-msg', err);
  }
  if (sp.isConnected()) {
    await syncAccountAndGame();
    // Cuenta y lista fijas: la primera vez que se conecta se carga la lista sola.
    if (!state.playlist || (state.playlist.id !== CONFIG.PLAYLIST_ID && !state.playlist.demo && !state.game)) {
      await loadFixedPlaylist();
    }
    refreshDevices();
    if (ui.deviceChoice === '__web__') startWebPlayer();
  }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

/** Registra la sesión del servidor con el token de Spotify ya validado y trae el listado de
 * partidas guardadas. Si este navegador ya venía siguiendo una (`currentGameId`) y sigue
 * existiendo, se refresca por si hay una versión más reciente (jugada desde otro dispositivo);
 * si es un dispositivo nuevo sin ninguna local, no se elige ninguna sola — puede haber varias,
 * que el usuario escoja en «Tus partidas» (pestaña Cartillas). */
async function syncAccountAndGame() {
  try {
    const token = await sp.getToken();
    const info = await syncServerSession(token);
    if (!info?.ok) return;
    ui.serverSession = true;
    ui.accountName = info.displayName;
    await refreshGamesList();
    if (state.currentGameId && ui.games.some((g) => g.id === state.currentGameId)) {
      const remote = await loadServerGame(state.currentGameId);
      if (remote && (remote.updatedAt || 0) > (state.updatedAt || 0)) {
        state.playlist = remote.state.playlist;
        state.config = remote.state.config;
        state.game = remote.state.game;
        state.updatedAt = remote.updatedAt;
        try {
          localStorage.setItem(STATE_KEY, JSON.stringify(state));
        } catch {}
      }
    } else if (state.currentGameId) {
      // El id que teníamos ya no existe en el servidor (se borró, o es de otra cuenta).
      state.currentGameId = null;
    }
    renderAll();
    showTab(state.game ? 'game' : state.playlist ? 'cards' : 'setup');
  } catch {
    // Sin conexión con nuestro servidor: seguimos con lo que hubiera en este navegador.
  }
}

init();
