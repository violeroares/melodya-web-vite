/**
 * LABORATORIO LOCAL Y AISLADO: cómo interpreta Express (`req.ip`, `req.ips`) y express-rate-limit las cadenas X-Forwarded-For.
 *
 * NO toca el backend: carga `express` y `express-rate-limit` en SOLO LECTURA desde el node_modules de melodya.backend (las mismas
 * versiones que corren en el NAS: express 4.x, express-rate-limit 7.5.x) y levanta servidores efímeros en 127.0.0.1.
 * No hace ninguna solicitud de red externa.
 *
 * El «pie» del backend (app.js) se replica así:   app.set('trust proxy', N)  +  rateLimit({ standardHeaders: true, legacyHeaders: false })
 * sin keyGenerator propio (clave = req.ip), igual que middleware/rateLimit.js.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND_DIR = process.env.BACKEND_DIR || path.resolve(here, '../../../melodya.backend');
const requireFromBackend = createRequire(path.join(BACKEND_DIR, 'package.json'));

export function loadBackendLibs() {
  const express = requireFromBackend('express');
  const rateLimit = requireFromBackend('express-rate-limit');
  const readVersion = (name) => JSON.parse(readFileSync(path.join(BACKEND_DIR, 'node_modules', name, 'package.json'), 'utf8')).version;
  const versions = { express: readVersion('express'), 'express-rate-limit': readVersion('express-rate-limit'), 'proxy-addr': readVersion('proxy-addr') };
  return { express, rateLimit: rateLimit.rateLimit ?? rateLimit, versions };
}

/** App de sondeo: devuelve lo que Express cree que es la IP del cliente. */
export function createProbeApp({ trustProxy, limiter }) {
  const { express, rateLimit } = loadBackendLibs();
  const app = express();
  app.set('trust proxy', trustProxy); // como app.js:14
  if (limiter) {
    // Mismas opciones que generalLimiter (middleware/rateLimit.js:20-29), con un máximo pequeño para poder agotarlo.
    app.use(
      '/api',
      rateLimit({
        windowMs: limiter.windowMs ?? 60_000,
        max: limiter.max,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: { code: 'RATE_LIMITED', message: 'Demasiadas solicitudes, probá más tarde' } },
      }),
    );
  }
  const body = (req) => ({
    ip: req.ip,
    ips: req.ips,
    peer: req.socket.remoteAddress,
    xff: req.headers['x-forwarded-for'] ?? null,
    cfConnectingIp: req.headers['cf-connecting-ip'] ?? null,
  });
  app.get('/probe', (req, res) => res.json(body(req)));
  app.get('/api/ping', (req, res) => res.json(body(req)));
  return app;
}

export async function listen(app) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

/** GET crudo. `headers` admite arrays (cabecera repetida). `localAddress` fija la IP de ORIGEN (simula otro «peer»: 127.0.0.x). */
export function get({ port, path: p = '/probe', headers = {}, localAddress }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers, localAddress, agent: false }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(d); } catch { /* no JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** Ejecuta `fn` capturando lo que express-rate-limit escribe por console.error (sus «validaciones» ERR_ERL_*). */
export async function captureErrors(fn) {
  const orig = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.map(String).join(' '));
  try {
    const result = await fn();
    return { result, errors: lines };
  } finally {
    console.error = orig;
  }
}
