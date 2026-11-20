// La web es solo el frontend: consume el backend oficial con una URL EXPLÍCITA y no trae ningún servidor de negocio propio.
// Ejecutar: node --test "tests/*.test.mjs"  (Node 24: strip-types nativo, sin dependencias nuevas).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// El cliente lee la URL al cargarse: se define antes de importarlo (el resto de las pruebas usan resolveApiBase directamente).
process.env.VITE_API_BASE_URL = 'http://127.0.0.1:4000/api';
const { resolveApiBase, API_BASE, API_CONFIG_ERROR } = await import('../src/lib/api/client.ts');

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('el cliente toma la URL explícita del entorno', () => {
  assert.equal(API_BASE, 'http://127.0.0.1:4000/api');
  assert.equal(API_CONFIG_ERROR, null);
});

test('una URL http(s) válida se usa tal cual, sin la barra final', () => {
  assert.deepEqual(resolveApiBase('http://localhost:4000/api'), { base: 'http://localhost:4000/api', error: null });
  assert.deepEqual(resolveApiBase('  https://api.melodya.test/api/  '), { base: 'https://api.melodya.test/api', error: null });
});

test('sin URL no hay valor por defecto ni rutas del mismo origen: error explícito', () => {
  for (const missing of [undefined, null, '', '   ']) {
    const r = resolveApiBase(missing);
    assert.equal(r.base, '');
    assert.match(r.error, /Falta VITE_API_BASE_URL/);
  }
});

test('una URL inválida o con otro protocolo se rechaza con un mensaje que dice cómo corregirla', () => {
  assert.match(resolveApiBase('/api').error, /no es una URL válida/);
  assert.match(resolveApiBase('localhost:4000/api').error, /http o https|no es una URL válida/);
  assert.match(resolveApiBase('ftp://x.test/api').error, /http o https/);
  assert.equal(resolveApiBase('/api').base, '');
});

test('el cliente no tiene valor por defecto ni fallback hacia rutas internas', () => {
  const client = fs.readFileSync(path.join(root, 'src/lib/api/client.ts'), 'utf8');
  assert.ok(!/\?\?\s*'\/api'/.test(client), "client.ts no puede usar '/api' como valor por defecto");
  assert.ok(/resolveApiBase\(rawEnv\)/.test(client) && /VITE_API_BASE_URL/.test(client), 'la URL sale únicamente de VITE_API_BASE_URL');
  assert.ok(!/NEXT_PUBLIC|process\.env\.NODE_ENV/.test(client), 'sin variables de Next.js');
  assert.ok(/API_NOT_CONFIGURED/.test(client), 'sin configuración, las solicitudes se rechazan con un error explícito');
  assert.equal(fs.existsSync(path.join(root, 'src/lib/api/config.ts')), false, 'la resolución vive en client.ts');
  const hooks = fs.readFileSync(path.join(root, 'src/hooks/index.ts'), 'utf8');
  assert.ok(!/XTransformPort|3003/.test(hooks), 'el realtime no cae a ningún servicio alternativo');
});

test('no existe un servidor de negocio interno: ni src/server, ni rutas /api de Next, ni Prisma', () => {
  assert.equal(fs.existsSync(path.join(root, 'src/server')), false, 'src/server');
  assert.equal(fs.existsSync(path.join(root, 'src/app/api')), false, 'src/app/api');
  assert.equal(fs.existsSync(path.join(root, 'src/lib/db.ts')), false, 'src/lib/db.ts');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const name of ['prisma', '@prisma/client', 'z-ai-web-dev-sdk']) assert.equal(name in deps, false, name);
  for (const script of ['db:push', 'db:generate']) assert.equal(script in pkg.scripts, false, script);
});

test('ningún código de la web consume campos que el backend ya no devuelve (BPM, tonalidad, energía de la canción)', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
  const offenders = walk(path.join(root, 'src')).filter((f) => /\b(bpm|musicalKey)\b|currentVersion\??\.energy|song\.energy|detail\.energy/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders.map((f) => path.relative(root, f)), []);
});
