// Servidor estático mínimo, sin dependencias. Uso: `npm start` (o `node server.js`).
// Spotify exige http://127.0.0.1:<puerto>/ (no "localhost") como URI de redirección en local.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT) || 5173;
const host = process.env.HOST || '127.0.0.1'; // HOST=0.0.0.0 para abrirlo a la red local

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Ficheros que no forman parte de la app.
const hidden = /^(\.|node_modules|package(-lock)?\.json$|server\.js$|serve\.ps1$|Dockerfile|docker-compose\.yml$|nginx\.conf$|README\.md$)/;

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    let rel = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '');
    if (rel === '' || rel.endsWith(sep)) rel += 'index.html';
    const path = join(root, rel);
    if (!path.startsWith(root) || hidden.test(rel) || rel.split(sep).some((p) => p.startsWith('.'))) {
      res.writeHead(404).end('404');
      return;
    }
    if (!(await stat(path)).isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'Content-Type': mime[extname(path).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(await readFile(path));
  } catch {
    res.writeHead(404).end('404');
  }
}).listen(port, host, () => console.log(`Bingo Musical en http://${host}:${port}/  (Ctrl+C para parar)`));
