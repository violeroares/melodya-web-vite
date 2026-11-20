// Laboratorio local de req.ip / req.ips con las versiones de express y express-rate-limit del backend (solo lectura de su node_modules).
// Sin red externa. Se omite si no existe ../melodya.backend. Detalle y matriz completa: node scripts/ip-audit/run-matrix.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BACKEND_DIR, createProbeApp, listen, get, captureErrors } from '../scripts/ip-audit/lib.mjs';

const present = fs.existsSync(`${BACKEND_DIR}/node_modules/express`);
const t = (name, fn) => test(name, { skip: !present && 'melodya.backend no está junto a este proyecto' }, fn);

async function ipFor(trustProxy, headers, localAddress) {
  const srv = await listen(createProbeApp({ trustProxy }));
  try {
    return (await get({ port: srv.port, headers, localAddress })).json;
  } finally {
    await srv.close();
  }
}
async function statuses(srv, plans) {
  const out = [];
  for (const [headers, n] of plans) {
    const row = [];
    for (let i = 0; i < n; i++) row.push((await get({ port: srv.port, path: '/api/ping', headers })).status);
    out.push(row);
  }
  return out;
}

t('trust proxy = 1 (producción): req.ip es la ÚLTIMA entrada de X-Forwarded-For (la que anexa Cloudflare)', async () => {
  assert.equal((await ipFor(1, { 'x-forwarded-for': '203.0.113.7' })).ip, '203.0.113.7');
  const spoofed = await ipFor(1, { 'x-forwarded-for': '1.2.3.4, 203.0.113.7' });
  assert.equal(spoofed.ip, '203.0.113.7', 'lo que el cliente antepone se ignora');
  assert.deepEqual(spoofed.ips, ['203.0.113.7']);
  assert.equal((await ipFor(1, { 'x-forwarded-for': ['5.5.5.5', '203.0.113.7'] })).ip, '203.0.113.7', 'cabeceras repetidas = misma regla');
});

t('CF-Connecting-IP NO interviene: Express la ignora', async () => {
  assert.equal((await ipFor(1, { 'cf-connecting-ip': '203.0.113.7' })).ip, '127.0.0.1', 'sin XFF cae a la IP del peer');
  assert.equal((await ipFor(1, { 'x-forwarded-for': '203.0.113.7', 'cf-connecting-ip': '198.51.100.9' })).ip, '203.0.113.7');
});

t('la IP del peer inmediato (gateway Docker) no cambia el resultado con 1 salto', async () => {
  const a = await ipFor(1, { 'x-forwarded-for': '203.0.113.7' }, '127.0.0.1');
  const b = await ipFor(1, { 'x-forwarded-for': '203.0.113.7' }, '127.0.0.9');
  assert.equal(a.ip, b.ip);
  assert.notEqual(a.peer, b.peer);
});

t('RIESGO: con trust proxy = 1 y el puerto accesible directamente, X-Forwarded-For es 100 % falsificable', async () => {
  assert.equal((await ipFor(1, { 'x-forwarded-for': '9.9.9.9' })).ip, '9.9.9.9');
  assert.equal((await ipFor(1, { 'x-forwarded-for': '9.9.9.9, 8.8.8.8' })).ip, '8.8.8.8', 'el atacante elige la IP que quiera');
});

t('RIESGO: un salto de proxy EXTRA hace que todos los clientes compartan la IP del proxy', async () => {
  assert.equal((await ipFor(1, { 'x-forwarded-for': '203.0.113.7, 172.18.0.5' })).ip, '172.18.0.5');
  assert.equal((await ipFor(1, { 'x-forwarded-for': '198.51.100.9, 172.18.0.5' })).ip, '172.18.0.5');
});

t('trust proxy = false ignora X-Forwarded-For (todos comparten la IP del peer) y trust proxy = true es evadible', async () => {
  assert.equal((await ipFor(false, { 'x-forwarded-for': '203.0.113.7' })).ip, '127.0.0.1');
  assert.equal((await ipFor(true, { 'x-forwarded-for': '1.2.3.4, 203.0.113.7' })).ip, '1.2.3.4', 'true confía en la PRIMERA entrada: la que controla el cliente');
});

t('trust proxy restringido a la dirección del peer legítimo neutraliza el XFF falso de accesos directos', async () => {
  const viaTunnel = await ipFor('127.0.0.9', { 'x-forwarded-for': '1.2.3.4, 203.0.113.7' }, '127.0.0.9');
  assert.equal(viaTunnel.ip, '203.0.113.7');
  const direct = await ipFor('127.0.0.9', { 'x-forwarded-for': '9.9.9.9' }, '127.0.0.1');
  assert.equal(direct.ip, '127.0.0.1', 'el XFF de un peer NO confiable se descarta');
});

t('limiter: el contador es por req.ip — dos apps tras la misma IP lo comparten; otro cliente no', async () => {
  const srv = await listen(createProbeApp({ trustProxy: 1, limiter: { max: 3 } }));
  try {
    const [web, bo, other] = await statuses(srv, [[{ 'x-forwarded-for': '203.0.113.7' }, 3], [{ 'x-forwarded-for': '203.0.113.7' }, 2], [{ 'x-forwarded-for': '198.51.100.9' }, 2]]);
    assert.deepEqual(web, [200, 200, 200]);
    assert.deepEqual(bo, [429, 429], 'el Backoffice se bloquea por lo que consumió la Web (misma IP)');
    assert.deepEqual(other, [200, 200]);
  } finally { await srv.close(); }
});

t('RIESGO: rotando XFF falso se evade el límite y se puede agotar el cupo de una víctima', async () => {
  const srv = await listen(createProbeApp({ trustProxy: 1, limiter: { max: 3 } }));
  try {
    const rot = [];
    for (let i = 0; i < 8; i++) rot.push((await get({ port: srv.port, path: '/api/ping', headers: { 'x-forwarded-for': `9.9.9.${i}` } })).status);
    assert.ok(rot.every((s) => s === 200), 'nunca se bloquea');
    await statuses(srv, [[{ 'x-forwarded-for': '203.0.113.7' }, 4]]);
    const [[victim]] = await statuses(srv, [[{ 'x-forwarded-for': '203.0.113.7' }, 1]]);
    assert.equal(victim, 429, 'la víctima legítima queda bloqueada');
  } finally { await srv.close(); }
});

t('cabeceras de 429: RateLimit-* (draft-6, reset en SEGUNDOS) y Retry-After solo al bloquear', async () => {
  const srv = await listen(createProbeApp({ trustProxy: 1, limiter: { max: 1, windowMs: 60_000 } }));
  try {
    const h = { 'x-forwarded-for': '1.1.1.1' };
    const ok = await get({ port: srv.port, path: '/api/ping', headers: h });
    const blocked = await get({ port: srv.port, path: '/api/ping', headers: h });
    assert.equal(ok.headers['ratelimit-policy'], '1;w=60');
    assert.equal(ok.headers['ratelimit-remaining'], '0');
    assert.equal(ok.headers['retry-after'], undefined);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers['ratelimit-reset']) <= 60, 'es un delta, no un epoch');
    assert.equal(blocked.headers['retry-after'], blocked.headers['ratelimit-reset']);
  } finally { await srv.close(); }
});

t('una IP no válida (XFF «unknown») se usa igualmente como clave compartida y genera un aviso', async () => {
  const { result, errors } = await captureErrors(async () => {
    const srv = await listen(createProbeApp({ trustProxy: 1, limiter: { max: 2 } }));
    const out = (await statuses(srv, [[{ 'x-forwarded-for': 'unknown' }, 3]]))[0];
    await srv.close();
    return out;
  });
  assert.deepEqual(result, [200, 200, 429], 'todos los clientes con XFF basura comparten un solo contador');
  assert.ok(errors.some((e) => /ERR_ERL_INVALID_IP_ADDRESS|invalid 'request\.ip'/.test(e)));
});
