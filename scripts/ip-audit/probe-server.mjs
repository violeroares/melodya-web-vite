/**
 * SONDEO DE IP EFECTIVA — para ejecutar en el NAS SOLO CON AUTORIZACIÓN, en un contenedor EFÍMERO y AISLADO del backend real.
 * Replica `app.set('trust proxy', N)` de app.js:14 y reporta qué ve Express (req.ip / req.ips) y qué cabeceras de proxy llegan.
 *
 * PRIVACIDAD Y SEGURIDAD (por diseño):
 *  • Solo registra: hora, el peer, las entradas de X-Forwarded-For, CF-Connecting-IP, req.ip y req.ips — TODAS enmascaradas
 *    (IPv4 pública → /24 «a.b.c.0», IPv6 pública → /48; las direcciones privadas de infraestructura —Docker/LAN— se ven completas). Nunca registra Authorization, Cookie, User-Agent, query string, cuerpo ni ninguna otra cabecera.
 *  • Solo responde en una ruta secreta aleatoria (/probe/<token>); cualquier otra ruta recibe 404 SIN registrar nada.
 *  • No usa credenciales, no habla con la base de datos ni con el backend, no escribe archivos.
 *  • Se apaga solo al llegar a MAX_REQUESTS (40) o tras TTL_MINUTES (15).
 *
 * Variables: PORT (4999) · TRUST_PROXY (1, igual que producción) · MAX_REQUESTS · TTL_MINUTES
 * Requiere `express@4` (el mismo major que el backend). Ver docs/IP-VERIFICATION.md.
 */
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

const require = createRequire(import.meta.url);
const express = require('express');

const PORT = Number(process.env.PORT || 4999);
const MAX_REQUESTS = Number(process.env.MAX_REQUESTS || 40);
const TTL_MINUTES = Number(process.env.TTL_MINUTES || 15);
const rawTrust = process.env.TRUST_PROXY ?? '1';
const TRUST = /^\d+$/.test(rawTrust) ? Number(rawTrust) : rawTrust === 'true' ? true : rawTrust === 'false' ? false : rawTrust;

/** Direcciones PRIVADAS (infraestructura: gateway Docker, LAN, loopback): se muestran completas — hacen falta para fijar TRUST_PROXY. */
const isPrivateV4 = (a, b) => a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);

/** IPv4 pública → a.b.c.0 · IPv6 pública → primeros 3 grupos + «::/48» · otra cosa → «<no-ip>». Nunca devuelve una IP pública completa. */
export function maskIp(value) {
  if (typeof value !== 'string') return '<none>';
  let v = value.trim().replace(/^::ffff:/i, '');
  const priv = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(v);
  if (priv && isPrivateV4(Number(priv[1]), Number(priv[2]))) return v;
  if (v === '::1') return v;
  const m4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(v);
  if (m4) return `${m4[1]}.${m4[2]}.${m4[3]}.0`;
  if (/^[0-9a-f:]+$/i.test(v) && v.includes(':')) return `${v.split(':').filter(Boolean).slice(0, 3).join(':')}::/48`;
  return '<no-ip>';
}

export function summarize(req) {
  const xffRaw = req.headers['x-forwarded-for'];
  const xff = typeof xffRaw === 'string' ? xffRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];
  return {
    t: new Date().toISOString(),
    trustProxy: TRUST,
    peer: maskIp(req.socket.remoteAddress),
    xffCount: xff.length,
    xff: xff.slice(-5).map(maskIp), // solo las últimas 5 entradas
    cfConnectingIp: maskIp(req.headers['cf-connecting-ip']),
    cfRayPresent: Boolean(req.headers['cf-ray']), // indica que pasó por Cloudflare; no se registra el valor
    reqIp: maskIp(req.ip),
    reqIps: req.ips.map(maskIp),
    sameAsPeer: maskIp(req.ip) === maskIp(req.socket.remoteAddress),
  };
}

export function createProbe({ token = randomBytes(12).toString('hex'), onExit = () => process.exit(0) } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', TRUST); // igual que app.js:14
  let served = 0;
  app.get(`/probe/${token}`, (req, res) => {
    const s = summarize(req);
    console.log(JSON.stringify(s)); // única línea de log: todo enmascarado
    res.set('Cache-Control', 'no-store').json(s);
    if (++served >= MAX_REQUESTS) setTimeout(onExit, 200);
  });
  app.use((_req, res) => res.status(404).end()); // sin log
  return { app, token };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const { app, token } = createProbe();
  const server = app.listen(PORT, () => {
    console.log(`probe escuchando en :${PORT}  trust proxy=${JSON.stringify(TRUST)}  ruta: /probe/${token}  (se apaga en ${TTL_MINUTES} min o ${MAX_REQUESTS} solicitudes)`);
  });
  setTimeout(() => { console.log('TTL alcanzado: apagando'); server.close(() => process.exit(0)); }, TTL_MINUTES * 60_000).unref?.();
}
