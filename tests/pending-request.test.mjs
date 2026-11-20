// Solicitudes pendientes: clientRequestId estable por intención, cuerpo exacto persistido, sin vencimiento por tiempo,
// bloqueo de envíos con otro cuerpo, un solo envío en vuelo y aislamiento por cuenta.
// Ejecutar: node --test "tests/*.test.mjs"
import './_helpers/register-ts-resolve.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const P = await import('../src/lib/pending-request.ts');
const { createPendingStore, classifyError, fingerprint, canonicalBody, intentKey, pendingKey } = P;

const root = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function memStorage() {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
const err = (status, code = 'ERROR') => Object.assign(new Error(code), { status, code });
const BODY = { inputs: [{ field: 'IDEA', text: 'cumbia' }, { field: 'GENRE', value: ['Pop'] }], options: {} };
const OTHER = { inputs: [{ field: 'IDEA', text: 'rock' }], options: {} };
let seq = 0;
const mk = (storage = memStorage()) => ({ storage, store: createPendingStore({ storage, newId: () => `id-${++seq}` }) });

test('timeout: el reintento reutiliza la MISMA clave y el MISMO cuerpo exacto', async () => {
  const { store } = mk();
  const sent = [];
  const fail = async (b) => { sent.push(b); throw err(0, 'TIMEOUT'); };
  const r1 = await store.submit({ userId: 'u1', intent: 'new', body: BODY, send: fail });
  assert.equal(r1.kind, 'UNCERTAIN');
  const r2 = await store.submit({ userId: 'u1', intent: 'new', body: BODY, send: async (b) => { sent.push(b); return { id: 'g1' }; } });
  assert.equal(r2.kind, 'ACCEPTED');
  assert.equal(sent.length, 2);
  assert.equal(sent[0].clientRequestId, sent[1].clientRequestId, 'misma clave');
  assert.deepEqual(sent[0], sent[1], 'mismo cuerpo exacto');
  assert.equal(JSON.stringify(sent[1]), r1.record.body, 'idéntico al texto que se guardó antes de enviar');
});

test('write-ahead: la solicitud queda guardada ANTES de salir y sobrevive a una recarga', async () => {
  const storage = memStorage();
  const { store } = mk(storage);
  let during = null;
  const send = async () => { during = storage.getItem(pendingKey('u1', 'new')); throw err(503); };
  await store.submit({ userId: 'u1', intent: 'new', body: BODY, send });
  assert.ok(during, 'ya estaba escrita mientras el pedido estaba en vuelo');
  const { store: reloaded } = mk(storage); // «recarga»: otro almacén sobre el mismo storage
  const rec = reloaded.load('u1', 'new');
  assert.equal(rec.clientRequestId, JSON.parse(during).clientRequestId);
  assert.equal(rec.body, JSON.parse(during).body);
  assert.match(rec.bodyHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(rec.attempts, 1);
});

test('tras recargar, resolver reenvía exactamente lo guardado (misma clave, mismo cuerpo)', async () => {
  const storage = memStorage();
  const first = mk(storage).store;
  await first.submit({ userId: 'u1', intent: 'new', body: BODY, send: async () => { throw err(0, 'NETWORK'); } });
  const saved = first.load('u1', 'new');
  const reloaded = mk(storage).store;
  let got = null;
  const res = await reloaded.resolve({ userId: 'u1', intent: 'new', send: async (b) => { got = b; return { id: 'g9' }; } });
  assert.equal(res.kind, 'ACCEPTED');
  assert.equal(JSON.stringify(got), saved.body);
  assert.equal(reloaded.load('u1', 'new'), null, 'aceptada: ya no queda pendiente');
});

test('con un resultado sin resolver NO se envía otro cuerpo ni otra clave (BLOCKED)', async () => {
  const { store } = mk();
  await store.submit({ userId: 'u1', intent: 'new', body: BODY, send: async () => { throw err(504); } });
  const before = store.load('u1', 'new');
  let calls = 0;
  const res = await store.submit({ userId: 'u1', intent: 'new', body: OTHER, send: async () => { calls += 1; return { id: 'x' }; } });
  assert.equal(res.kind, 'BLOCKED');
  assert.equal(calls, 0, 'no salió ningún pedido');
  assert.equal(res.record.clientRequestId, before.clientRequestId);
  assert.equal(store.load('u1', 'new').clientRequestId, before.clientRequestId, 'la clave anterior sigue intacta');
});

test('NO hay vencimiento por tiempo: una pendiente de 10 días se conserva y se reutiliza', async () => {
  const storage = memStorage();
  const old = createPendingStore({ storage, newId: () => 'viejo', now: () => new Date('2026-11-01T00:00:00Z') });
  await old.submit({ userId: 'u1', intent: 'new', body: BODY, send: async () => { throw err(0, 'TIMEOUT'); } });
  const later = createPendingStore({ storage, newId: () => 'nuevo', now: () => new Date('2026-11-12T00:00:00Z') });
  const rec = later.load('u1', 'new');
  assert.equal(rec.clientRequestId, 'viejo');
  assert.equal(rec.createdAt, '2026-11-01T00:00:00.000Z');
  const res = await later.submit({ userId: 'u1', intent: 'new', body: BODY, send: async () => ({ id: 'g' }) });
  assert.equal(res.kind, 'ACCEPTED');
  assert.equal(res.record.clientRequestId, 'viejo', 'misma clave aunque pasaron más de 24 h');
});

test('rechazo definitivo (4xx): se descarta y la siguiente intención usa una clave NUEVA', async () => {
  const { store } = mk();
  const ids = [];
  const r1 = await store.submit({ userId: 'u1', intent: 'new', body: BODY, send: async (b) => { ids.push(b.clientRequestId); throw err(422, 'VALIDATION_ERROR'); } });
  assert.equal(r1.kind, 'REJECTED');
  assert.equal(store.load('u1', 'new'), null);
  await store.submit({ userId: 'u1', intent: 'new', body: OTHER, send: async (b) => { ids.push(b.clientRequestId); return { id: 'g' }; } });
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1], 'otra clave');
});

test('aceptada: se limpia y cada intención nueva usa su propia clave', async () => {
  const { store } = mk();
  const ids = [];
  const send = async (b) => { ids.push(b.clientRequestId); return { id: 'g' }; };
  await store.submit({ userId: 'u1', intent: 'new', body: BODY, send });
  await store.submit({ userId: 'u1', intent: 'new', body: BODY, send });
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
});

test('doble clic: envíos simultáneos producen UN solo pedido', async () => {
  const { store } = mk();
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const send = async () => { calls += 1; await gate; return { id: 'g1' }; };
  const a = store.submit({ userId: 'u1', intent: 'new', body: BODY, send });
  const b = store.submit({ userId: 'u1', intent: 'new', body: BODY, send });
  const c = store.resolve({ userId: 'u1', intent: 'new', send });
  release();
  const [ra, rb, rc] = await Promise.all([a, b, c]);
  assert.equal(calls, 1, 'un solo pedido hacia el servidor');
  assert.deepEqual([ra.kind, rb.kind, rc.kind].sort(), ['ACCEPTED', 'IN_FLIGHT', 'IN_FLIGHT']);
});

test('aislamiento por cuenta e intención', async () => {
  const { store } = mk();
  await store.submit({ userId: 'u1', intent: 'new', body: BODY, send: async () => { throw err(0, 'NETWORK'); } });
  assert.equal(store.load('u2', 'new'), null, 'otra cuenta no ve la pendiente');
  assert.equal(store.load('u1', 'version.s1'), null, 'otra intención tampoco');
  const r = await store.submit({ userId: 'u2', intent: 'new', body: OTHER, send: async () => ({ id: 'g' }) });
  assert.equal(r.kind, 'ACCEPTED', 'la pendiente de u1 no bloquea a u2');
  assert.ok(store.load('u1', 'new'), 'y sigue guardada para u1');
  const storage = memStorage(); // un registro de u1 colocado bajo la clave de u2 se ignora
  storage.setItem(pendingKey('u2', 'new'), JSON.stringify({ v: 1, userId: 'u1', intent: 'new', clientRequestId: 'a', body: '{}', bodyHash: 'h' }));
  assert.equal(mk(storage).store.load('u2', 'new'), null);
});

test('clasificación de resultados: solo los rechazos claros son definitivos', () => {
  for (const e of [err(0, 'NETWORK'), err(0, 'TIMEOUT'), err(500), err(502), err(503, 'DB_UNAVAILABLE'), err(504), err(408), err(409, 'CONFLICT'), err(429), new Error('desconocido'), null, undefined]) {
    assert.equal(classifyError(e), 'UNCERTAIN', String(e?.status ?? e));
  }
  for (const e of [err(400), err(401), err(402, 'INSUFFICIENT_CREDITS'), err(403, 'LIMIT_EXCEEDED'), err(404), err(422, 'VALIDATION_ERROR'), err(503, 'GENERATION_PAUSED')]) {
    assert.equal(classifyError(e), 'REJECTED', `${e.status} ${e.code}`);
  }
});

test('descarte manual: solo cuando se pide, y solo esa intención', async () => {
  const { store } = mk();
  await store.submit({ userId: 'u1', intent: 'new', body: BODY, send: async () => { throw err(0, 'TIMEOUT'); } });
  await store.submit({ userId: 'u1', intent: 'version.s1', body: BODY, send: async () => { throw err(0, 'TIMEOUT'); } });
  store.discard('u1', 'new');
  assert.equal(store.load('u1', 'new'), null);
  assert.ok(store.load('u1', 'version.s1'));
});

test('sin almacenamiento: la clave sigue estable dentro de la sesión (respaldo en memoria)', async () => {
  const broken = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
  const store = createPendingStore({ storage: broken, newId: () => 'mem-1' });
  const ids = [];
  await store.submit({ userId: 'u1', intent: 'new', body: BODY, send: async (b) => { ids.push(b.clientRequestId); throw err(0, 'TIMEOUT'); } });
  await store.submit({ userId: 'u1', intent: 'new', body: BODY, send: async (b) => { ids.push(b.clientRequestId); return { id: 'g' }; } });
  assert.deepEqual(ids, ['mem-1', 'mem-1']);
});

test('huella: no depende del orden de inputs ni de la clave; cambia con el contenido', async () => {
  const a = { inputs: [{ field: 'IDEA', text: 'x' }, { field: 'GENRE', value: ['Pop'] }], options: { instrumental: false }, clientRequestId: 'uno' };
  const b = { options: { instrumental: false }, inputs: [{ field: 'GENRE', value: ['Pop'] }, { field: 'IDEA', text: 'x' }], clientRequestId: 'dos' };
  assert.equal(canonicalBody(a), canonicalBody(b));
  assert.equal(await fingerprint(a), await fingerprint(b));
  assert.notEqual(await fingerprint(a), await fingerprint({ ...a, inputs: [{ field: 'IDEA', text: 'y' }] }));
  assert.notEqual(await fingerprint(a), await fingerprint({ ...a, songId: 'cancion' }));
  assert.match(await fingerprint(a), /^sha256:[0-9a-f]{64}$/);
});

test('intentKey: canción nueva, otra versión y remix (con modalidad) son intenciones distintas', () => {
  assert.equal(intentKey({}), 'new');
  assert.equal(intentKey({ versionOfId: 's1' }), 'version.s1');
  assert.notEqual(intentKey({ remixSongId: 's1', remixMode: 'COVER' }), intentKey({ remixSongId: 's1', remixMode: 'PROMPT_REUSE' }));
  assert.equal(intentKey({ versionOfId: 's1', remixSongId: 's2' }), 'version.s1', 'versión y remix son excluyentes: gana la versión, como en el creador');
});

test('el creador ya no genera una clave nueva en cada clic', () => {
  const src = read('src/features/creator/CreatorWizard.tsx');
  assert.ok(!/crypto\.randomUUID\(\)/.test(src), 'sin randomUUID en el envío');
  assert.match(src, /pendingStore\.submit\(\{/);
  assert.match(src, /sendingRef\.current/, 'protección contra doble clic antes del re-render');
  assert.match(src, /pendingStore\.resolve\(/);
  assert.match(src, /pending !== null \|\| resolving/, 'con un pedido sin confirmar, crear otro está bloqueado');
});
