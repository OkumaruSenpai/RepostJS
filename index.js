// STINT0 - servidor sencillo para servir RAWs con API key
require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();

// --- Configuración desde .env ---
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const RAW_URL = process.env.RAW_URL; // raw fijo (Roblox)
const BASE_REPO_URL = (process.env.BASE_REPO_URL || '').replace(/\/$/, '');
const TTL_MS = Number(process.env.CACHE_TTL_MS || 60_000);
const ALLOWED_EXT = new Set(
  (process.env.ALLOWED_EXT || '.lua,.txt,.json')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);

// --- Utilidades ---
const VALID_NAME_RE = /^[a-zA-Z0-9._-]{1,128}$/;

// Autenticación por header x-api-key (aplica a /roblox y /obtener-script)
function auth(req, res) {
  const key = req.header('x-api-key');
  if (!API_KEY || key !== API_KEY) {
    res.status(401).send('No autorizado');
    return false;
  }
  return true;
}

// Caché simple en memoria: url -> { data, contentType, expiresAt }
const cache = new Map();

async function fetchRaw(url) {
  const now = Date.now();
  const entry = cache.get(url);
  if (entry && entry.expiresAt > now) {
    return { data: entry.data, contentType: entry.contentType, fromCache: true };
  }

  const resp = await axios.get(url, {
    responseType: 'text',
    timeout: 10_000,
    headers: { 'User-Agent': 'STINT0/1.0', 'Accept': 'text/plain, */*' },
    validateStatus: s => s >= 200 && s < 400
  });

  const contentType = resp.headers['content-type'] || 'text/plain; charset=utf-8';
  cache.set(url, { data: resp.data, contentType, expiresAt: now + TTL_MS });
  return { data: resp.data, contentType, fromCache: false };
}

// --- Rutas ---
app.get('/ping', (_req, res) => res.send('pong'));

// Raw fijo (Roblox): usa RAW_URL del .env
app.get('/roblox', async (req, res, next) => {
  try {
    if (!auth(req, res)) return;
    if (!RAW_URL) return res.status(500).send('RAW_URL no configurada');

    const { data, contentType, fromCache } = await fetchRaw(RAW_URL);
    res.set('Content-Type', contentType);
    res.set('Cache-Control', `public, max-age=${Math.floor(TTL_MS / 1000)}`);
    res.set('X-Cache', fromCache ? 'HIT' : 'MISS');
    res.send(data);
  } catch (err) { next(err); }
});

// /obtener-script/Nombre.lua -> ${BASE_REPO_URL}/Nombre.lua
app.get('/obtener-script/:archivo', async (req, res, next) => {
  try {
    if (!auth(req, res)) return;

    const archivo = req.params.archivo;
    if (!VALID_NAME_RE.test(archivo)) {
      return res.status(400).send('Nombre de archivo inválido.');
    }
    const permitido = [...ALLOWED_EXT].some(ext => archivo.endsWith(ext));
    if (!permitido) {
      return res.status(400).send('Extensión no permitida.');
    }
    if (!BASE_REPO_URL) {
      return res.status(500).send('BASE_REPO_URL no configurada');
    }

    const url = `${BASE_REPO_URL}/${archivo}`;
    const { data, contentType, fromCache } = await fetchRaw(url);
    res.set('Content-Type', contentType);
    res.set('Cache-Control', `public, max-age=${Math.floor(TTL_MS / 1000)}`);
    res.set('X-Cache', fromCache ? 'HIT' : 'MISS');
    res.send(data);
  } catch (err) { next(err); }
});

// Manejo de errores
app.use((err, _req, res, _next) => {
  console.error('Error:', err?.message || err);
  res.status(502).send('Error al obtener el archivo.');
});

app.listen(PORT, () => {
  console.log('STINT0 escuchando en el puerto', PORT);
});
