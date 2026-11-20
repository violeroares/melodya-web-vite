// Bloqueo de una recuperación de Remix: qué se limpia en este dispositivo y qué NO (comportamiento sobre un almacenamiento real inyectado).
// Ejecutar: node --test "tests/*.test.mjs"
import './_helpers/register-ts-resolve.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const D = await import('../src/lib/draft-store.ts');
const S = await import('../src/lib/recovery-store.ts');
const P = await import('../src/lib/pending-request.ts');
const B = await import('../src/features/creator/recovery-block.ts');
const { readDraft, writeDraft, LEGACY_DRAFT_KEY } = D;

const root = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function memStorage() {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
const NEW = { kind: 'NEW' };
const BODY = { request: { inputs: [{ field: 'IDEA', text: 'x' }], options: {} }, destination: { kind: 'SAME' } };
const uncertain = async () => { throw Object.assign(new Error('sin respuesta'), { status: 0 }); };

/** Un dispositivo con: un borrador de «canción nueva», otros contextos, otra cuenta, el heredado y varios pedidos pendientes. */
async function device() {
  const st = memStorage();
  writeDraft(st, 'juan', NEW, { composition: 'lo que armó Juan' });
  writeDraft(st, 'juan', { kind: 'VERSION', songId: 's1' }, { composition: 'otra versión' });
  writeDraft(st, 'juan', { kind: 'REMIX', songId: 's9', versionId: 'v1', mode: 'COVER' }, { composition: 'otro remix' });
  writeDraft(st, 'juan', { kind: 'RETRY', retryOf: 'otra' }, { composition: 'otro reintento' });
  writeDraft(st, 'ana', NEW, { composition: 'lo que armó Ana' });
  st.setItem(LEGACY_DRAFT_KEY, '{"legado":true}');
  const store = P.createPendingStore({ storage: st, newId: () => 'id-' + Math.random().toString(36).slice(2) });
  for (const intent of ['retry.g1', 'retry.otra', 'new', 'version.s1']) await store.submit({ userId: 'juan', intent, body: BODY, send: uncertain });
  await store.submit({ userId: 'ana', intent: 'retry.g1', body: BODY, send: uncertain });
  return { st, store };
}
const session = (over = {}) => ({ generationId: 'g1', needsApply: false, ...over });
const args = (d, over = {}) => ({ storage: d.st, userId: 'juan', draft: NEW, pending: d.store, session: session(), ...over });

test('bloqueo ANTES de cargar la recuperación: el borrador anterior (independiente) se conserva y nada se limpia', async () => {
  const d = await device();
  const rec = S.startSession(d.st, 'juan', 'g1'); // recuperación iniciada: la composición todavía no se aplicó
  assert.equal(rec.active.needsApply, true);
  const out = B.discardBlockedRecovery(args(d, { session: rec.active }));
  assert.equal(out.discardedDraft, false);
  assert.equal(readDraft(d.st, 'juan', NEW).state.composition, 'lo que armó Juan', 'el borrador anterior sigue');
  assert.ok(d.store.load('juan', 'retry.g1'), 'su pedido pendiente tampoco se toca');
  // el creador cierra la sesión y marca la generación como atendida (no la borra)
  const ended = S.endSession(d.st, 'juan', 'DISMISSED');
  assert.equal(ended.active, null);
  assert.equal(ended.handled.g1.state, 'DISMISSED');
});

test('bloqueo con la recuperación YA cargada: se descarta SOLO ese borrador y su pedido pendiente; todo lo demás sigue', async () => {
  const d = await device();
  S.startSession(d.st, 'juan', 'g1');
  const applied = S.updateSession(d.st, 'juan', { needsApply: false }); // la composición se cargó y el usuario la edita
  const out = B.discardBlockedRecovery(args(d, { session: applied.active }));
  assert.equal(out.discardedDraft, true);

  assert.equal(readDraft(d.st, 'juan', NEW), null, 'el borrador de la recuperación se descartó');
  assert.equal(d.store.load('juan', 'retry.g1'), null, 'y su pedido de reintento pendiente');
  assert.equal(d.st.getItem(P.pendingKey('juan', 'retry.g1')), null, 'también del almacenamiento');
  // nada más se toca
  assert.equal(readDraft(d.st, 'juan', { kind: 'VERSION', songId: 's1' }).state.composition, 'otra versión');
  assert.equal(readDraft(d.st, 'juan', { kind: 'REMIX', songId: 's9', versionId: 'v1', mode: 'COVER' }).state.composition, 'otro remix');
  assert.equal(readDraft(d.st, 'juan', { kind: 'RETRY', retryOf: 'otra' }).state.composition, 'otro reintento');
  assert.equal(readDraft(d.st, 'ana', NEW).state.composition, 'lo que armó Ana', 'otra cuenta');
  assert.equal(d.st.getItem(LEGACY_DRAFT_KEY), '{"legado":true}', 'el borrador heredado');
  for (const intent of ['retry.otra', 'new', 'version.s1']) assert.ok(d.store.load('juan', intent), `pedido pendiente «${intent}» intacto`);
  assert.ok(d.store.load('ana', 'retry.g1'), 'el pedido de otra cuenta con el mismo id');
});

test('sin recuperación activa no se limpia nada', async () => {
  const d = await device();
  const before = JSON.stringify([...d.st.m.entries()]);
  assert.deepEqual(B.discardBlockedRecovery(args(d, { session: null })), { discardedDraft: false });
  assert.equal(JSON.stringify([...d.st.m.entries()]), before);
  assert.deepEqual(B.discardBlockedRecovery(args(d, { userId: null })), { discardedDraft: false }, 'sin cuenta identificada tampoco');
  assert.equal(JSON.stringify([...d.st.m.entries()]), before);
});

test('el creador usa esa lógica y conserva el resto del comportamiento (pantalla de bloqueo, sin tocar el servidor)', () => {
  const w = read('src/features/creator/CreatorWizard.tsx');
  const fn = w.slice(w.indexOf('const blockRecovery = () => {'), w.indexOf('/** ¿El Remix de la recuperación dejó de estar autorizado?'));
  assert.match(fn, /discardBlockedRecovery\(\{ storage: browserStorage\(\), userId, draft: NEW_DRAFT, pending: pendingStore, session: rec\.session \}\)/);
  assert.match(fn, /rec\.end\('DISMISSED'\)/);
  assert.match(fn, /setPending\(null\)/, 'también el aviso de pedido pendiente en pantalla');
  assert.ok(!/generationApi\.|songsApi\.|\.remove|\.delete/.test(fn), 'no borra nada del servidor');
  assert.ok(!/clearDraft/.test(fn), 'el borrado del borrador lo decide el helper probado');
});

test('diálogo de reemplazo: explica qué se reemplaza (el borrador actual de este dispositivo) y qué no se toca', () => {
  const w = read('src/features/creator/CreatorWizard.tsx');
  assert.match(w, /Se va a reemplazar la composición que tenés ahora en el editor \(tu borrador de este dispositivo\) por la de tu última canción, que no se pudo crear\./);
  assert.match(w, /Lo que armaste se descarta\./);
  assert.match(w, /Esa canción sigue en tu actividad, y si ya no se puede recuperar, no se toca nada\./);
  assert.ok(!w.includes('vas a perder lo que armaste ahora'), 'texto anterior retirado');
});
