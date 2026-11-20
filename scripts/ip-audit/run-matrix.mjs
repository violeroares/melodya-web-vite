/**
 * Imprime la matriz de resultados del laboratorio (sin aserciones; las aserciones están en tests/ip-audit.test.mjs).
 *   node scripts/ip-audit/run-matrix.mjs
 */
import { createProbeApp, listen, get, captureErrors, loadBackendLibs } from './lib.mjs';

const { versions } = loadBackendLibs();
console.log('Versiones (leídas del backend, solo lectura):', JSON.stringify(versions), '\n');

const CASES = [
  ['A  Cloudflare normal', { 'x-forwarded-for': '203.0.113.7', 'cf-connecting-ip': '203.0.113.7' }],
  ['B  cliente envía XFF falso y pasa por Cloudflare (CF anexa la IP real)', { 'x-forwarded-for': '1.2.3.4, 203.0.113.7', 'cf-connecting-ip': '203.0.113.7' }],
  ['C  acceso directo a :4000 SIN XFF (LAN)', {}],
  ['D  acceso directo a :4000 con XFF falso', { 'x-forwarded-for': '9.9.9.9' }],
  ['E  acceso directo con cadena falsa de 2 IP', { 'x-forwarded-for': '9.9.9.9, 8.8.8.8' }],
  ['F  UN SALTO EXTRA (proxy intermedio anexa su IP)', { 'x-forwarded-for': '203.0.113.7, 172.18.0.5', 'cf-connecting-ip': '203.0.113.7' }],
  ['G  IPv6 real', { 'x-forwarded-for': '2001:db8::1' }],
  ['H  XFF con puerto', { 'x-forwarded-for': '203.0.113.7:51234' }],
  ['I  XFF basura («unknown»)', { 'x-forwarded-for': 'unknown' }],
  ['J  XFF vacío', { 'x-forwarded-for': '' }],
  ['K  solo CF-Connecting-IP (sin XFF)', { 'cf-connecting-ip': '203.0.113.7' }],
  ['L  CF-Connecting-IP distinta de XFF', { 'x-forwarded-for': '203.0.113.7', 'cf-connecting-ip': '198.51.100.9' }],
  ['M  dos cabeceras XFF repetidas', { 'x-forwarded-for': ['5.5.5.5', '203.0.113.7'] }],
  ['N  XFF con espacios y mayúsculas IPv6', { 'x-forwarded-for': '  2001:DB8::A  ' }],
  ['O  XFF muy largo (40 entradas falsas + real)', { 'x-forwarded-for': `${Array.from({ length: 40 }, (_, i) => `10.0.0.${i}`).join(', ')}, 203.0.113.7` }],
];
const TRUSTS = [[false, 'false'], [1, '1 (producción)'], [2, '2'], [true, 'true'], ['loopback', "'loopback'"], ['10.0.0.0/8', "'10.0.0.0/8' (peer no confiable)"]];

for (const [trust, label] of TRUSTS) {
  const srv = await listen(createProbeApp({ trustProxy: trust }));
  console.log(`\n=== trust proxy = ${label} ===`);
  for (const [name, headers] of CASES) {
    const { json } = await get({ port: srv.port, headers });
    console.log(`${name.padEnd(76)} ip=${String(json.ip).padEnd(18)} ips=${JSON.stringify(json.ips)}`);
  }
  await srv.close();
}

console.log('\n=== peer distinto (origen 127.0.0.9, simula la IP del gateway Docker) con trust proxy = 1, caso A ===');
{
  const srv = await listen(createProbeApp({ trustProxy: 1 }));
  for (const localAddress of ['127.0.0.1', '127.0.0.9']) {
    const { json } = await get({ port: srv.port, headers: CASES[0][1], localAddress });
    console.log(`peer=${json.peer.padEnd(20)} ip=${json.ip}`);
  }
  await srv.close();
}

console.log('\n=== Limiter (max=3 / 60 s, clave = req.ip) ===');
async function burst(srv, plans) {
  const out = [];
  for (const [label, headers, n] of plans) {
    const row = [];
    for (let i = 0; i < n; i++) row.push((await get({ port: srv.port, path: '/api/ping', headers })).status);
    out.push(`${label.padEnd(58)} ${row.join(' ')}`);
  }
  return out;
}
{
  const srv = await listen(createProbeApp({ trustProxy: 1, limiter: { max: 3 } }));
  console.log('-- Cloudflare normal: 2 apps del MISMO usuario/red comparten contador; otro cliente no --');
  for (const l of await burst(srv, [
    ['Web Vite (IP 203.0.113.7) ×3', { 'x-forwarded-for': '203.0.113.7' }, 3],
    ['Backoffice (misma IP 203.0.113.7) ×2', { 'x-forwarded-for': '203.0.113.7' }, 2],
    ['Otro cliente (IP 198.51.100.9) ×2', { 'x-forwarded-for': '198.51.100.9' }, 2],
  ])) console.log(l);
  await srv.close();

  const srv2 = await listen(createProbeApp({ trustProxy: 1, limiter: { max: 3 } }));
  console.log('-- Puerto 4000 accesible directamente: XFF falsificable --');
  for (const l of await burst(srv2, [
    ['Atacante rota XFF falso ×8 (evade el límite)', null, 0],
  ])) console.log(l);
  const rot = [];
  for (let i = 0; i < 8; i++) rot.push((await get({ port: srv2.port, path: '/api/ping', headers: { 'x-forwarded-for': `9.9.9.${i}` } })).status);
  console.log('   resultado rotando IP falsa:'.padEnd(58), rot.join(' '));
  const victim = [];
  for (let i = 0; i < 4; i++) victim.push((await get({ port: srv2.port, path: '/api/ping', headers: { 'x-forwarded-for': '203.0.113.7' } })).status);
  console.log('   atacante agota el cupo de la víctima 203.0.113.7:'.padEnd(58), victim.join(' '));
  const real = (await get({ port: srv2.port, path: '/api/ping', headers: { 'x-forwarded-for': '203.0.113.7' } })).status;
  console.log('   la víctima real después:'.padEnd(58), real);
  await srv2.close();

  const srv3 = await listen(createProbeApp({ trustProxy: 1, limiter: { max: 3 } }));
  console.log('-- Salto extra de proxy: TODOS comparten la IP del proxy --');
  for (const l of await burst(srv3, [
    ['Cliente A (203.0.113.7, proxy 172.18.0.5) ×3', { 'x-forwarded-for': '203.0.113.7, 172.18.0.5' }, 3],
    ['Cliente B (198.51.100.9, mismo proxy) ×2', { 'x-forwarded-for': '198.51.100.9, 172.18.0.5' }, 2],
  ])) console.log(l);
  await srv3.close();

  const h = (await (async () => { const s = await listen(createProbeApp({ trustProxy: 1, limiter: { max: 2 } })); const r = []; for (let i = 0; i < 3; i++) r.push(await get({ port: s.port, path: '/api/ping', headers: { 'x-forwarded-for': '1.1.1.1' } })); await s.close(); return r; })());
  console.log('\n-- Cabeceras (max=2): petición 1 y petición 3 (429) --');
  const pick = (r) => Object.fromEntries(Object.entries(r.headers).filter(([k]) => /^(ratelimit|retry-after|x-ratelimit)/.test(k)));
  console.log(' 1ª:', JSON.stringify(pick(h[0])));
  console.log(' 3ª:', h[2].status, JSON.stringify(pick(h[2])));
}

console.log('\n=== Avisos de express-rate-limit por configuración (console.error) ===');
for (const [trust, label] of [[false, 'false + XFF presente'], [true, 'true'], [1, '1']]) {
  const { errors } = await captureErrors(async () => {
    const srv = await listen(createProbeApp({ trustProxy: trust, limiter: { max: 5 } }));
    await get({ port: srv.port, path: '/api/ping', headers: { 'x-forwarded-for': '203.0.113.7' } });
    await srv.close();
  });
  console.log(`trust proxy = ${label}: ${errors.length ? errors.map((e) => e.split('\n')[0].slice(0, 150)).join(' | ') : '(sin avisos)'}`);
}

console.log('\n=== trust proxy RESTRINGIDO a la dirección del peer legítimo (simula «solo confiar en el gateway de cloudflared») ===');
{
  // peer legítimo = 127.0.0.9 (cloudflared/gateway); atacante directo = 127.0.0.1
  for (const [trust, label] of [['127.0.0.9', "'127.0.0.9' (una sola dirección)"], [['127.0.0.9', '127.0.0.8'], '[lista de 2 direcciones]']]) {
    const srv = await listen(createProbeApp({ trustProxy: trust }));
    console.log(`-- trust proxy = ${label} --`);
    const rows = [
      ['Vía cloudflared (peer 127.0.0.9), XFF 203.0.113.7', '127.0.0.9', { 'x-forwarded-for': '203.0.113.7' }],
      ['Vía cloudflared, cliente envía XFF falso + real', '127.0.0.9', { 'x-forwarded-for': '1.2.3.4, 203.0.113.7' }],
      ['Atacante directo (peer 127.0.0.1) con XFF falso 9.9.9.9', '127.0.0.1', { 'x-forwarded-for': '9.9.9.9' }],
      ['Atacante directo sin XFF', '127.0.0.1', {}],
    ];
    for (const [name, localAddress, headers] of rows) {
      const { json } = await get({ port: srv.port, headers, localAddress });
      console.log(`${name.padEnd(62)} peer=${json.peer.padEnd(10)} ip=${json.ip}`);
    }
    await srv.close();
  }
}

console.log('\n=== IP «no válida» como clave (XFF basura) con trust proxy = 1 ===');
{
  const { errors, result } = await captureErrors(async () => {
    const srv = await listen(createProbeApp({ trustProxy: 1, limiter: { max: 2 } }));
    const out = [];
    for (const xff of ['unknown', 'unknown', 'unknown', '203.0.113.7:51234']) out.push((await get({ port: srv.port, path: '/api/ping', headers: { 'x-forwarded-for': xff } })).status);
    await srv.close();
    return out;
  });
  console.log('estados con XFF «unknown»×3 y «ip:puerto»×1 (max=2):', result.join(' '));
  console.log('avisos:', errors.length ? errors.map((e) => e.split('\n')[0].slice(0, 140)).join(' | ') : '(ninguno)');
}
