// Lógica pura del bingo musical (sin DOM ni Spotify): generación de cartillas y evaluación.
//
// Idea clave: el orden de reproducción se fija al generar las cartillas. Como el orden es
// conocido, se pueden generar cartillas para las que el PRIMER premio de cada tipo
// (línea, esquina, bingo) lo completa una única cartilla, en una canción distinta cada uno.
// Sin fijar el orden sería imposible garantizarlo (dos cartillas que comparten la canción
// que cierra su premio empatarían siempre).

export const PRIZES = ['line', 'corner', 'bingo'];
export const PRIZE_LABEL = { line: 'Línea', corner: 'Esquina', bingo: 'Bingo' };

const CODE_LETTERS = 'BCDFGHJKLMNPQRSTVWXZ';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function cornerIndexes(rows, cols) {
  return [0, cols - 1, (rows - 1) * cols, rows * cols - 1];
}

export function rankMap(order) {
  const rank = new Map();
  order.forEach((id, i) => rank.set(id, i));
  return rank;
}

/** Llamada (1-based) en la que la cartilla completa cada premio, dado el orden de salida. */
export function cardTimes(cells, rank, rows, cols) {
  let line = Infinity;
  for (let r = 0; r < rows; r++) {
    let m = -1;
    for (let c = 0; c < cols; c++) m = Math.max(m, rank.get(cells[r * cols + c]));
    line = Math.min(line, m + 1);
  }
  let corner = 0;
  for (const i of cornerIndexes(rows, cols)) corner = Math.max(corner, rank.get(cells[i]) + 1);
  let bingo = 0;
  for (const id of cells) bingo = Math.max(bingo, rank.get(id) + 1);
  return { line, corner, bingo };
}

function holdersOf(times, key) {
  let min = Infinity;
  for (const t of times) if (t[key] < min) min = t[key];
  const idx = [];
  times.forEach((t, i) => {
    if (t[key] === min) idx.push(i);
  });
  return { min, idx };
}

/** Primeras cartillas en completar cada premio. `cards` = [{tag, cells}] */
export function firstWinners(cards, rank, rows, cols) {
  const times = cards.map((c) => cardTimes(c.cells, rank, rows, cols));
  const out = {};
  for (const p of PRIZES) {
    const { min, idx } = holdersOf(times, p);
    out[p] = { call: min, cards: idx.map((i) => cards[i]) };
  }
  return out;
}

function pick(arr, k, rng) {
  // Muestra k elementos distintos (Fisher-Yates parcial).
  const a = arr.slice();
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rng() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}

function buildCards(order, n, rows, cols, rng, maxIter) {
  const cellsPer = rows * cols;
  const rank = rankMap(order);
  const seen = new Set();
  const makeCard = () => {
    for (let t = 0; t < 500; t++) {
      const cells = pick(order, cellsPer, rng);
      const key = cells.slice().sort().join('|');
      if (!seen.has(key)) {
        seen.add(key);
        return { cells, key };
      }
    }
    throw new Error('No hay suficientes combinaciones distintas de canciones. Sube el número de canciones en juego.');
  };

  const cards = [];
  const times = [];
  for (let i = 0; i < n; i++) {
    const c = makeCard();
    cards.push(c);
    times.push(cardTimes(c.cells, rank, rows, cols));
  }
  const replace = (i) => {
    seen.delete(cards[i].key);
    cards[i] = makeCard();
    times[i] = cardTimes(cards[i].cells, rank, rows, cols);
  };

  for (let iter = 0; iter < maxIter; iter++) {
    const bad = new Set();
    const hold = {};
    for (const p of PRIZES) {
      hold[p] = holdersOf(times, p);
      // 1) Un único ganador por premio: si hay empate en el mínimo, se rehacen todas menos una.
      if (hold[p].idx.length > 1) {
        const keep = hold[p].idx[Math.floor(rng() * hold[p].idx.length)];
        for (const i of hold[p].idx) if (i !== keep) bad.add(i);
      }
    }
    if (bad.size === 0) {
      // 2) Los tres premios se completan en canciones distintas.
      for (let a = 0; a < PRIZES.length && bad.size === 0; a++) {
        for (let b = a + 1; b < PRIZES.length; b++) {
          if (hold[PRIZES[a]].min === hold[PRIZES[b]].min) {
            bad.add(hold[PRIZES[rng() < 0.5 ? a : b]].idx[0]);
            break;
          }
        }
      }
    }
    if (bad.size === 0 && n >= 3) {
      // 3) Ganadores distintos para cada premio (una cartilla no se lleva dos premios).
      for (let a = 0; a < PRIZES.length && bad.size === 0; a++) {
        for (let b = a + 1; b < PRIZES.length; b++) {
          if (hold[PRIZES[a]].idx[0] === hold[PRIZES[b]].idx[0]) {
            bad.add(hold[PRIZES[a]].idx[0]);
            break;
          }
        }
      }
    }
    if (bad.size === 0) return cards.map((c) => c.cells);
    for (const i of bad) replace(i);
  }
  return null;
}

function makeTags(n, rng) {
  const used = new Set();
  const tags = [];
  for (let i = 0; i < n; i++) {
    let code;
    do {
      code = '';
      for (let k = 0; k < 4; k++) code += CODE_LETTERS[Math.floor(rng() * CODE_LETTERS.length)];
    } while (used.has(code));
    used.add(code);
    tags.push({ n: i + 1, code });
  }
  return tags;
}

/**
 * Genera una partida completa.
 * tracks: [{id, uri, name, artist}]; devuelve { order, cards:[{n, code, cells}], tracks, rows, cols, stats }
 */
export function generateGame({ tracks, n, rows = 3, cols = 5, pool, rng = Math.random, maxAttempts = 40, maxIter = 3000 }) {
  const cellsPer = rows * cols;
  if (!Number.isInteger(n) || n < 1) throw new Error('El número de cartillas debe ser al menos 1.');
  const poolSize = Math.min(pool || tracks.length, tracks.length);
  if (poolSize <= cellsPer) {
    throw new Error(`Necesitas más de ${cellsPer} canciones en juego (la lista tiene ${tracks.length}).`);
  }
  const byId = new Map(tracks.map((t) => [t.id, t]));
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const order = shuffle(tracks.map((t) => t.id), rng).slice(0, poolSize);
    const cellSets = buildCards(order, n, rows, cols, rng, maxIter);
    if (!cellSets) continue;
    const tags = makeTags(n, rng);
    // Ojo: no reordenar `cells` aquí; la posición en la cuadrícula decide qué fila/esquinas cuentan
    // y las garantías de unicidad se han comprobado con este orden exacto.
    const cards = cellSets.map((cells, i) => ({ n: tags[i].n, code: tags[i].code, cells }));
    const rank = rankMap(order);
    const fw = firstWinners(cards, rank, rows, cols);
    const gameTracks = {};
    for (const id of order) gameTracks[id] = byId.get(id);
    return {
      order,
      cards,
      tracks: gameTracks,
      rows,
      cols,
      stats: Object.fromEntries(PRIZES.map((p) => [p, { call: fw[p].call, n: fw[p].cards[0].n }])),
    };
  }
  throw new Error('No se han podido generar cartillas sin empates. Prueba con más canciones en juego o menos cartillas.');
}

/** Estado de una cartilla tras `pos` canciones reproducidas. */
export function evaluate(card, rank, pos, rows, cols) {
  const marks = card.cells.map((id) => rank.get(id) < pos);
  let bestRow = 0;
  for (let r = 0; r < rows; r++) {
    let m = 0;
    for (let c = 0; c < cols; c++) if (marks[r * cols + c]) m++;
    bestRow = Math.max(bestRow, m);
  }
  const corners = cornerIndexes(rows, cols).filter((i) => marks[i]).length;
  const total = marks.filter(Boolean).length;
  const res = {
    marks,
    line: { marked: bestRow, size: cols, need: cols - bestRow },
    corner: { marked: corners, size: 4, need: 4 - corners },
    bingo: { marked: total, size: rows * cols, need: rows * cols - total },
  };
  res.hit = { line: res.line.need === 0, corner: res.corner.need === 0, bingo: res.bingo.need === 0 };
  return res;
}

/**
 * Resumen para el anfitrión: por premio aún no concedido, qué cartillas tienen
 * el premio completo (ready), les falta 1 (one) o les faltan 2 (two).
 */
export function summarize(cards, rank, pos, rows, cols, awarded = {}) {
  const out = {};
  for (const p of PRIZES) out[p] = { open: !awarded[p], ready: [], one: [], two: [] };
  for (const card of cards) {
    const ev = evaluate(card, rank, pos, rows, cols);
    for (const p of PRIZES) {
      if (awarded[p]) continue;
      const need = ev[p].need;
      if (need === 0) out[p].ready.push(card.n);
      else if (need === 1) out[p].one.push(card.n);
      else if (need === 2) out[p].two.push(card.n);
    }
  }
  return out;
}

/** Busca por número (solo dígitos) o por código de 4 letras. */
export function findCard(cards, query) {
  const q = String(query || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!q) return null;
  if (/^\d+$/.test(q)) return cards.find((c) => c.n === Number(q)) || null;
  return cards.find((c) => c.code === q) || null;
}

/**
 * Comprueba un premio cantado. Devuelve el veredicto para mostrar al anfitrión.
 */
export function checkClaim({ card, cards, prize, rank, pos, rows, cols, awarded = {} }) {
  const ev = evaluate(card, rank, pos, rows, cols);
  const times = cardTimes(card.cells, rank, rows, cols);
  const fw = firstWinners(cards, rank, rows, cols)[prize];
  const done = ev.hit[prize];
  const call = times[prize];
  // Canciones que faltan para ese premio (la mejor fila para línea, las esquinas, o toda la cartilla).
  let scope;
  if (prize === 'bingo') scope = card.cells.map((_, i) => i);
  else if (prize === 'corner') scope = cornerIndexes(rows, cols);
  else {
    let best = 0;
    let bestMarked = -1;
    for (let r = 0; r < rows; r++) {
      let m = 0;
      for (let c = 0; c < cols; c++) if (ev.marks[r * cols + c]) m++;
      if (m > bestMarked) {
        bestMarked = m;
        best = r;
      }
    }
    scope = Array.from({ length: cols }, (_, c) => best * cols + c);
  }
  const missing = scope.filter((i) => !ev.marks[i]).map((i) => card.cells[i]);
  return {
    ev,
    valid: done,
    call, // canción en la que esta cartilla completa el premio
    firstCall: fw.call,
    earlier: done && call > fw.call ? fw.cards : [], // cartillas que lo completaron antes sin cantarlo
    awardedTo: awarded[prize] || null,
    missing,
  };
}
