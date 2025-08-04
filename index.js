// STINT0 - servidor sencillo para servir RAWs con API key
require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();

// --- Configuración desde .env ---
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const RAW_URL = process.env.RAW_URL;
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
const cache = new Map(); // urlKey -> { data, contentType, etag, expiresAt }

function auth(req, res) {
  const key = req.header('x-api-key');
  if (!API_KEY || key !== API_KEY) {
    res.status(401).send('No autorizado');
    return false;
  }
  return true;
}

function withCacheBuster(url) { // 👈 genera URL única para saltar el CDN de GitHub
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}cb=${Date.now()}`;
}

async function fetchRaw(url, { forceFresh = false } = {}) {
  const now = Date.now();
  const entry = cache.get(url);

  // Usa caché local si válido y no es "fresh"
  if (!forceFresh && entry && entry.expiresAt > now) {
    return { data: entry.data, contentType: entry.contentType, fromCache: true };
  }

  // Si tenemos ETag y no es "fresh", intenta revalidar
  const headers = {
    'User-Agent': 'STINT0/1.0',
    'Accept': 'text/plain, */*'
  };
  if (!forceFresh && entry?.etag) {
    headers['If-None-Match'] = entry.etag;           // 👈 revalidación condicional
    headers['Cache-Control'] = 'no-cache';           // 👈 pide revalidar (algunos CDNs la ignoran)
    headers['Pragma'] = 'no-cache';
  }

  // Si es "fresh", añade cache-buster para esquivar el TTL de 5 min del CDN
  const upstreamURL = forceFresh ? withCacheBuster(url) : url; // 👈

  const resp = await axios.get(upstreamURL, {
    responseType: 'text',
    timeout: 10_000,
    headers,
    // Acepta 304 Not Modified
    validateStatus: s => (s >= 200 && s < 300) || s === 304
  });

  if (resp.status === 304 && entry) {
    // No cambió: renueva la caducidad local
    entry.expiresAt = now + TTL_MS;
    return { data: entry.data, contentType: entry.contentType, fromCache: true, revalidated: true };
  }

  const contentType = resp.headers['content-type'] || 'text/plain; charset=utf-8';
  const etag = resp.headers.etag;
  cache.set(url, { data: resp.data, contentType, etag, expiresAt: now + TTL_MS });
  return { data: resp.data, contentType, fromCache: false };
}

// --- Rutas ---
app.get('/ping', (_req, res) => res.send('pong'));

// /roblox: admite ?fresh=1 para forzar actualización inmediata
app.get('/roblox', async (req, res, next) => {
  try {
    if (!auth(req, res)) return;
    if (!RAW_URL) return res.status(500).send('RAW_URL no configurada');

    const forceFresh = req.query.fresh === '1' || req.query.nocache === '1'; // 👈
    const { data, contentType, fromCache } = await fetchRaw(RAW_URL, { forceFresh });

    res.set('Content-Type', contentType);
    res.set('X-Cache', fromCache ? 'HIT' : 'MISS');

    // Si pediste "fresh", no cachees en clientes/proxies
    if (forceFresh) {
      res.set('Cache-Control', 'no-store'); // 👈
    } else {
      res.set('Cache-Control', `public, max-age=${Math.floor(TTL_MS / 1000)}`);
    }

    res.send(data);
  } catch (err) { next(err); }
});

// /obtener-script/Nombre.lua -> ${BASE_REPO_URL}/Nombre.lua (también admite ?fresh=1)
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
    const forceFresh = req.query.fresh === '1' || req.query.nocache === '1'; // 👈
    const { data, contentType, fromCache } = await fetchRaw(url, { forceFresh });

    res.set('Content-Type', contentType);
    res.set('X-Cache', fromCache ? 'HIT' : 'MISS');
    if (forceFresh) {
      res.set('Cache-Control', 'no-store'); // 👈
    } else {
      res.set('Cache-Control', `public, max-age=${Math.floor(TTL_MS / 1000)}`);
    }
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
