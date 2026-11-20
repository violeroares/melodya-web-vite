// Borradores locales (DraftV1): aislamiento por cuenta, conservación al cerrar sesión, contextos y borrador legado intacto.
// Ejecutar: node --test "tests/*.test.mjs"
import './_helpers/register-ts-resolve.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const D = await import('../src/lib/draft-store.ts');
const K = await import('../src/lib/user-storage-keys.ts');
const { readDraft, writeDraft, clearDraft, draftKey, contextKey, LEGACY_DRAFT_KEY, DRAFT_PREFIX } = D;

const root = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function memStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}
const NEW = { kind: 'NEW' };

test('guarda y recupera el borrador de la misma cuenta', () => {
  const st = memStorage();
  assert.equal(writeDraft(st, 'u1', NEW, { idea: 'cumbia' }, new Date('2026-11-12T10:00:00Z')), true);
  const d = readDraft(st, 'u1', NEW);
  assert.deepEqual(d.state, { idea: 'cumbia' });
  assert.equal(d.userId, 'u1');
  assert.equal(d.v, 1);
  assert.equal(d.updatedAt, '2026-11-12T10:00:00.000Z');
});

test('aislamiento: otra cuenta nunca ve el borrador (ni por clave ni por contenido)', () => {
  const st = memStorage();
  writeDraft(st, 'u1', NEW, { idea: 'privado de u1' });
  assert.equal(readDraft(st, 'u2', NEW), null, 'otra cuenta: sin borrador');
  // un registro de u1 copiado bajo la clave de u2 (corrupción o manipulación): el contenido manda
  st.setItem(draftKey('u2', NEW), st.getItem(draftKey('u1', NEW)));
  assert.equal(readDraft(st, 'u2', NEW), null, 'el userId guardado no coincide con la sesión: no se muestra');
  assert.equal(readDraft(st, 'u1', NEW).state.idea, 'privado de u1', 'el de u1 sigue intacto');
});

test('los borradores de varias cuentas conviven y reaparecen cuando vuelve la misma cuenta', () => {
  const st = memStorage();
  writeDraft(st, 'u1', NEW, { idea: 'sigue aquí' });
  writeDraft(st, 'u2', NEW, { idea: 'otro' });
  // (cerrar sesión = resetUserSessionState, que no toca estas claves: ver la prueba de user-storage-keys)
  assert.equal(readDraft(st, 'u2', NEW).state.idea, 'otro');
  assert.equal(readDraft(st, 'u1', NEW).state.idea, 'sigue aquí');
});

test('clearDraft borra solo el borrador de esa cuenta y ese contexto', () => {
  const st = memStorage();
  writeDraft(st, 'u1', NEW, { a: 1 });
  writeDraft(st, 'u2', NEW, { a: 2 });
  writeDraft(st, 'u1', { kind: 'VERSION', songId: 's1' }, { a: 3 });
  clearDraft(st, 'u1', NEW);
  assert.equal(readDraft(st, 'u1', NEW), null);
  assert.equal(readDraft(st, 'u2', NEW).state.a, 2);
  assert.equal(readDraft(st, 'u1', { kind: 'VERSION', songId: 's1' }).state.a, 3);
});

test('un borrador por contexto: nueva / otra versión / remix / reintento son claves distintas', () => {
  const st = memStorage();
  const ctxs = [
    NEW,
    { kind: 'VERSION', songId: 's1' },
    { kind: 'VERSION', songId: 's2' },
    { kind: 'REMIX', songId: 's1', versionId: 'v1', mode: 'COVER' },
    { kind: 'REMIX', songId: 's1', versionId: 'v2', mode: 'COVER' },
    { kind: 'REMIX', songId: 's1', versionId: 'v1', mode: 'PROMPT_REUSE' },
    { kind: 'RETRY', retryOf: 'g1' },
  ];
  ctxs.forEach((c, n) => writeDraft(st, 'u1', c, { n }));
  assert.equal(new Set(ctxs.map((c) => draftKey('u1', c))).size, ctxs.length);
  ctxs.forEach((c, n) => assert.equal(readDraft(st, 'u1', c).state.n, n));
});

test('remix: el borrador exige versionId explícito (nunca «la vigente»)', () => {
  const st = memStorage();
  assert.equal(contextKey({ kind: 'REMIX', songId: 's1', versionId: '', mode: 'COVER' }), null);
  assert.equal(writeDraft(st, 'u1', { kind: 'REMIX', songId: 's1', versionId: '', mode: 'COVER' }, {}), false);
  assert.equal(st.m.size, 0);
  assert.match(contextKey({ kind: 'REMIX', songId: 's1', versionId: 'v9', mode: 'COVER' }), /v9/);
});

test('sin cuenta identificada no se lee ni se escribe', () => {
  const st = memStorage();
  assert.equal(writeDraft(st, null, NEW, {}), false);
  assert.equal(writeDraft(st, '', NEW, {}), false);
  assert.equal(readDraft(st, null, NEW), null);
  assert.equal(st.m.size, 0);
});

test('formato desconocido, corrupto o ajeno: se ignora y NO se modifica lo guardado', () => {
  const key = draftKey('u1', NEW);
  const future = JSON.stringify({ v: 2, userId: 'u1', context: NEW, updatedAt: 'x', state: { nuevo: true } });
  const st = memStorage({ [key]: future });
  assert.equal(readDraft(st, 'u1', NEW), null);
  assert.equal(st.getItem(key), future, 'un cliente más nuevo pudo escribirlo: no se pisa al leer');
  assert.equal(readDraft(memStorage({ [key]: '{no es json' }), 'u1', NEW), null);
  assert.equal(readDraft(memStorage({ [key]: '123' }), 'u1', NEW), null);
});

test('almacenamiento no disponible: no lanza', () => {
  const broken = { getItem() { throw new Error('bloqueado'); }, setItem() { throw new Error('lleno'); }, removeItem() { throw new Error('bloqueado'); } };
  assert.equal(readDraft(broken, 'u1', NEW), null);
  assert.equal(writeDraft(broken, 'u1', NEW, {}), false);
  assert.doesNotThrow(() => clearDraft(broken, 'u1', NEW));
  assert.equal(readDraft(null, 'u1', NEW), null);
  assert.equal(writeDraft(null, 'u1', NEW, {}), false);
});

test('borrador legado: nunca se muestra a ninguna cuenta y nunca se borra ni se modifica', () => {
  const legacy = JSON.stringify({ song: { composition: { idea: 'viejo, sin dueño' } }, savedAt: '2026-01-01T00:00:00Z' });
  const st = memStorage({ [LEGACY_DRAFT_KEY]: legacy });
  assert.equal(readDraft(st, 'u1', NEW), null, 'ninguna cuenta lo recibe');
  assert.equal(readDraft(st, 'u2', NEW), null);
  writeDraft(st, 'u1', NEW, { idea: 'nuevo' });
  clearDraft(st, 'u1', NEW);
  writeDraft(st, 'u2', NEW, { idea: 'otro' });
  assert.equal(st.getItem(LEGACY_DRAFT_KEY), legacy, 'sigue intacto, byte a byte');
  assert.equal(draftKey('u1', NEW), `${DRAFT_PREFIX}.u1.new`, 'el formato nuevo usa otro espacio de claves');
  assert.notEqual(draftKey('u1', NEW), LEGACY_DRAFT_KEY);
});

test('cerrar sesión no borra borradores ni pendientes: user-storage-keys no los incluye', () => {
  for (const key of K.USER_STORAGE_KEYS) {
    assert.ok(!String(key).startsWith('melodya.draft.'), key);
    assert.ok(!String(key).startsWith('melodya.pending.'), key);
    assert.notEqual(key, LEGACY_DRAFT_KEY, 'el legado no se borra al cerrar sesión');
    assert.notEqual(key, 'melodya.creator.draft');
  }
  assert.ok(K.USER_STORAGE_KEYS.includes('melodya.player.session'), 'sigue limpiando los datos del reproductor');
  const reset = read('src/lib/session-reset.ts');
  assert.match(reset, /USER_STORAGE_KEYS/);
  assert.ok(!/removeItem\(['"]melodya\.(draft|pending|creator)/.test(reset), 'el reset no borra borradores por nombre');
});

test('el creador usa el almacén aislado y nunca la clave legada', () => {
  const src = read('src/features/creator/CreatorWizard.tsx');
  assert.ok(!/DRAFT_KEY|localStorage/.test(src), 'sin acceso directo a localStorage ni a la clave legada');
  assert.match(src, /readDraft\(browserStorage\(\), userId, NEW_DRAFT\)/);
  assert.match(src, /const hydrated = userId !== null && draftOwner === userId;/, 'no se lee ni escribe hasta saber de qué cuenta es');
});
