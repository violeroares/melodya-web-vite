// Orquestación REAL del flujo de letras (createLyricsController + runPolling), con POST/GET simulados y un
// sessionStorage en memoria. Es el mismo controlador que usa LyricsStudio. Ejecutar: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PENDING_STORAGE_KEY,
  describePending,
  fingerprintPayload,
  loadAttempt,
  POLL_MAX_ATTEMPTS,
  createLyricsController,
  editorSignature,
  newIdempotencyKey,
  runPolling,
} from '../src/lib/assistant-lyrics/flow.ts';

/* ───────────────────────── utilidades ───────────────────────── */

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    raw: m,
  };
}

const LETRA = { title: 'Café', lyrics: '[verse]\nhola', tags: ['tango'] };
const ok200 = (extra = {}) => ({ status: 200, data: { ...LETRA, resolvedProvider: { code: 'x', model: 'm1' }, operation: { id: 'op1', status: 'COMPLETED', replayed: false }, ...extra } });
const accepted202 = (id = 'op1', uncertain = false) => ({
  status: 202,
  data: { operation: { id, status: 'PROCESSING', replayed: false, ...(uncertain ? { uncertain: true, message: 'pendiente' } : {}) } },
});
const apiError = (status, code, details, message = code) => Object.assign(new Error(message), { status, code, details });
const TIMEOUT = () => apiError(0, 'TIMEOUT');
const NETWORK = () => apiError(0, 'NETWORK');
const snapshotOf = (status, extra = {}) => ({ status, jobs: [{ task: 'LYRICS', status, ...extra }] });
const completedSnap = () => snapshotOf('COMPLETED', { result: { title: 'Recuperada', lyrics: '[verse]\nrecuperada', tags: [] } });

const BODY = { idea: 'un tango sobre el café', genre: 'tango', language: 'español' };
const OTHER_BODY = { ...BODY, genre: 'milonga' };

/** `posts` y `gets` registran cada llamada. Un paso del guion puede ser un valor, un Error o una función. */
function harness({ posts: postScript = [], gets: getScript = [], storage = memoryStorage() } = {}) {
  const posts = [];
  const gets = [];
  let n = 0;
  const next = (script, label) => {
    const step = script.length > 1 ? script.shift() : script[0];
    if (step === undefined) throw new Error(`${label} inesperado`);
    return typeof step === 'function' ? step() : step;
  };
  const state = { editor: undefined }; // contenido del editor ahora; undefined = sin cambios desde la linea base
  const real = createLyricsController({
    post: async (body, key) => {
      posts.push({ body, key });
      const step = next(postScript, 'POST');
      if (step instanceof Error) throw step;
      return step;
    },
    getOperation: async (id) => {
      gets.push(id);
      const step = next(getScript, 'GET');
      if (step instanceof Error) throw step;
      return step;
    },
    getStorage: () => storage,
    makeKey: () => newIdempotencyKey(() => `uuid-${(n += 1)}`),
  });
  const controller = {
    ...real,
    submit: (body, userId, baseline) => real.submit(body, userId, baseline, () => state.editor ?? baseline),
    retry: (userId, baseline) => real.retry(userId, baseline, () => state.editor ?? baseline),
  };
  return { controller, posts, gets, storage, postScript, getScript, state };
}

const stored = (storage) => (storage.raw.has(PENDING_STORAGE_KEY) ? JSON.parse(storage.raw.get(PENDING_STORAGE_KEY)) : null);
const noSleep = async () => {};

/* ───────────────────────── 1–3 · respuestas ───────────────────────── */

test('1 · 200 con letra válida ⇒ completed, y se olvida la solicitud (storage limpio)', async () => {
  const h = harness({ posts: [ok200()] });
  const out = await h.controller.submit(BODY, 'u1', '');
  assert.deepEqual(out, { kind: 'completed', title: 'Café', lyrics: '[verse]\nhola', tags: ['tango'], model: 'm1', editorChanged: false });
  assert.equal(stored(h.storage), null);
  assert.equal(h.controller.getSnapshot().pending, null);
  assert.equal(h.posts.length, 1);
});

test('2 · 200 vacío o inválido NO es éxito: no hay letra para el editor y la solicitud se conserva', async () => {
  for (const data of [{ lyrics: '' }, { lyrics: '  \n' }, { title: 'x' }, {}, null]) {
    const h = harness({ posts: [{ status: 200, data }] });
    const out = await h.controller.submit(BODY, 'u1', '');
    assert.notEqual(out.kind, 'completed', JSON.stringify(data));
    assert.equal(out.kind, 'pending');
    assert.ok(stored(h.storage)?.key, 'la clave sigue guardada');
    assert.equal(h.controller.getSnapshot().recovered, null);
  }
});

test('3 · 202 ⇒ pendiente (nunca letra), conserva operation.id, la incertidumbre y la persiste', async () => {
  const h = harness({ posts: [accepted202('op9', true)] });
  const out = await h.controller.submit(BODY, 'u1', '');
  assert.deepEqual(out, { kind: 'pending', operationId: 'op9', uncertain: true, cause: 'accepted' });
  assert.equal(stored(h.storage).operationId, 'op9');
  const view = h.controller.getSnapshot().pending;
  assert.equal(view.operationId, 'op9');
  assert.equal(view.uncertain, true);
  assert.equal(view.polling, true);
  const plain = harness({ posts: [accepted202('op8', false)] });
  assert.equal((await plain.controller.submit(BODY, 'u1', '')).uncertain, false);
});

/* ───────────────────────── 4–6 · timeout, red, 5xx y misma clave ───────────────────────── */

for (const [name, makeError] of [
  ['4 · timeout', TIMEOUT],
  ['5 · corte de red', NETWORK],
  ['6 · 5xx', () => apiError(503, 'SERVICE_UNAVAILABLE')],
  ['6b · 500 INTERNAL reenviado', () => apiError(500, 'INTERNAL')],
  ['6c · 401 reenviado por el proveedor (code INTERNAL)', () => apiError(401, 'INTERNAL')],
]) {
  test(`${name} ⇒ conserva la clave y el reintento explícito usa EXACTAMENTE la misma Idempotency-Key`, async () => {
    const h = harness({ posts: [makeError(), ok200()] });
    const first = await h.controller.submit(BODY, 'u1', '');
    assert.deepEqual(first, { kind: 'pending', operationId: null, uncertain: false, cause: 'unknown' });
    assert.equal(h.posts.length, 1, 'nada se reintenta solo');
    const keyAfterError = stored(h.storage).key;
    assert.equal(keyAfterError, h.posts[0].key);
    assert.equal(h.controller.getSnapshot().pending.canRetry, true);

    const retried = await h.controller.retry('u1', '');
    assert.equal(retried.kind, 'completed');
    assert.equal(h.posts.length, 2);
    assert.equal(h.posts[1].key, h.posts[0].key, 'misma clave');
    assert.deepEqual(h.posts[1].body, h.posts[0].body, 'mismo payload');
    assert.equal(stored(h.storage), null, 'recién con la letra se olvida la solicitud');
  });
}

test('4b · volver a pulsar "generar" con los MISMOS datos también reutiliza la clave', async () => {
  const h = harness({ posts: [TIMEOUT(), ok200()] });
  await h.controller.submit(BODY, 'u1', '');
  await h.controller.submit({ ...BODY }, 'u1', '');
  assert.equal(h.posts[1].key, h.posts[0].key);
});

/* ───────────────────────── 7–8 · H1: 429 durante un reintento ───────────────────────── */

test('7/8 · H1: 429 en el reintento de una clave ya usada la CONSERVA (y el pendiente); el siguiente POST explícito usa la misma clave', async () => {
  const limited = apiError(429, 'RATE_LIMITED', undefined, 'Límite de asistente alcanzado (30/hora)');
  const h = harness({ posts: [NETWORK(), limited, ok200()] });

  assert.equal((await h.controller.submit(BODY, 'u1', '')).kind, 'pending'); // la respuesta se perdió
  const originalKey = stored(h.storage).key;

  const second = await h.controller.retry('u1', '');
  assert.deepEqual(second, { kind: 'rate-limited', kept: true });
  assert.equal(h.posts.length, 2, 'el 429 no dispara ningún POST automático');
  assert.equal(stored(h.storage)?.key, originalKey, 'la clave persistida sigue siendo la original');
  const view = h.controller.getSnapshot().pending;
  assert.ok(view, 'el pendiente sigue visible');
  assert.equal(view.cause, 'rate-limited');
  assert.equal(view.canRetry, true);

  // ni siquiera un payload distinto puede aprovechar el momento para crear otra operación
  assert.equal((await h.controller.submit(OTHER_BODY, 'u1', '')).kind, 'blocked');
  assert.equal(h.posts.length, 2);

  const third = await h.controller.retry('u1', '');
  assert.equal(third.kind, 'completed');
  assert.deepEqual(h.posts.map((p) => p.key), [originalKey, originalKey, originalKey], 'las tres solicitudes llevan la misma clave');
});

test('7b · el 429 de un PRIMER envío (que jamás llegó al servicio) sí descarta la clave: no queda nada que recuperar', async () => {
  const h = harness({ posts: [apiError(429, 'RATE_LIMITED'), ok200()] });
  assert.deepEqual(await h.controller.submit(BODY, 'u1', ''), { kind: 'rate-limited', kept: false });
  assert.equal(stored(h.storage), null);
  assert.equal(h.controller.getSnapshot().pending, null);
  await h.controller.submit(BODY, 'u1', '');
  assert.notEqual(h.posts[1].key, h.posts[0].key, 'acción sin operación previa: clave nueva');
});

test('7c · 402 y 422 de validación: se descartan solo si el intento nunca pudo llegar al servicio; con un intento previo se conserva', async () => {
  const fresh = harness({ posts: [apiError(402, 'INSUFFICIENT_CREDITS', undefined, 'Fichas insuficientes')] });
  const out = await fresh.controller.submit(BODY, 'u1', '');
  assert.equal(out.kind, 'rejected');
  assert.equal(out.kept, false);
  assert.equal(out.message, 'Fichas insuficientes');
  assert.equal(stored(fresh.storage), null);

  const reused = harness({ posts: [TIMEOUT(), apiError(422, 'VALIDATION_ERROR')] });
  await reused.controller.submit(BODY, 'u1', '');
  const key = stored(reused.storage).key;
  const out2 = await reused.controller.retry('u1', '');
  assert.deepEqual({ kind: out2.kind, kept: out2.kept }, { kind: 'rejected', kept: true });
  assert.equal(stored(reused.storage).key, key);
});

test('7d · 409 por código real: ASSISTANT_OPERATION_FAILED/NOT_ACTIVE son terminales; un 409 genérico NO lo es', async () => {
  for (const code of ['ASSISTANT_OPERATION_FAILED', 'ASSISTANT_OPERATION_NOT_ACTIVE']) {
    const h = harness({ posts: [TIMEOUT(), apiError(409, 'CONFLICT', { code, operationId: 'op3' }), ok200()] });
    await h.controller.submit(BODY, 'u1', '');
    const out = await h.controller.retry('u1', '');
    assert.equal(out.kind, 'failed', code);
    assert.equal(stored(h.storage), null, 'terminal confirmado: se limpia');
    await h.controller.submit(BODY, 'u1', '');
    assert.notEqual(h.posts[2].key, h.posts[0].key, 'recién tras el terminal se usa una clave nueva');
  }
  const generic = harness({ posts: [TIMEOUT(), apiError(409, 'CONFLICT')] });
  await generic.controller.submit(BODY, 'u1', '');
  const key = stored(generic.storage).key;
  assert.equal((await generic.controller.retry('u1', '')).kind, 'pending');
  assert.equal(stored(generic.storage).key, key, 'un 409 sin detalle real no borra nada');
});

/* ───────────────────────── 9 · recuperación por GET ───────────────────────── */

test('9 · operación conocida: se recupera por GET /generations/{id} sin enviar otro POST (aunque se vuelva a pulsar "generar")', async () => {
  const h = harness({ posts: [accepted202('op1')], gets: [snapshotOf('PROCESSING'), completedSnap()] });
  await h.controller.submit(BODY, 'u1', 'base');

  assert.deepEqual(await h.controller.submit(BODY, 'u1', 'base'), { kind: 'resume', operationId: 'op1' });
  assert.equal(h.posts.length, 1, 'cero POST adicionales');

  assert.deepEqual(await h.controller.checkOnce(() => 'base'), { kind: 'pending', uncertain: false });
  const done = await h.controller.checkOnce(() => 'base');
  assert.deepEqual(done, { kind: 'completed', title: 'Recuperada', lyrics: '[verse]\nrecuperada', editorChanged: false });
  assert.deepEqual(h.gets, ['op1', 'op1']);
  assert.equal(h.posts.length, 1);
  assert.ok(stored(h.storage), 'hasta aplicar la letra la solicitud sigue guardada');
  h.controller.finishRecovered();
  assert.equal(stored(h.storage), null);
});

test('9b · estados finales del GET: FAILED/CANCELED limpian; PROCESSING con uncertainSince se marca incierta; COMPLETED sin letra NO es éxito', async () => {
  for (const [status, reason] of [['FAILED', 'failed'], ['CANCELED', 'canceled']]) {
    const h = harness({ posts: [accepted202('op1')], gets: [snapshotOf(status)] });
    await h.controller.submit(BODY, 'u1', '');
    assert.deepEqual(await h.controller.checkOnce(() => ''), { kind: 'failed', reason });
    assert.equal(stored(h.storage), null);
  }
  const unc = harness({ posts: [accepted202('op1')], gets: [snapshotOf('PROCESSING', { uncertainSince: '2026-10-12T10:00:00Z' })] });
  await unc.controller.submit(BODY, 'u1', '');
  assert.deepEqual(await unc.controller.checkOnce(() => ''), { kind: 'pending', uncertain: true });
  assert.equal(unc.controller.getSnapshot().pending.uncertain, true);

  const empty = harness({ posts: [accepted202('op1')], gets: [snapshotOf('COMPLETED', { result: { lyrics: ' ' } })] });
  await empty.controller.submit(BODY, 'u1', '');
  assert.equal((await empty.controller.checkOnce(() => '')).kind, 'invalid');
  assert.ok(stored(empty.storage), 'una respuesta inválida no borra la recuperación');
});

/* ───────────────────────── 10–11 · polling ───────────────────────── */

test('10 · el límite de polling (40) solo detiene la consulta: clave, operationId y registro quedan; se puede reanudar sin POST', async () => {
  const h = harness({ posts: [accepted202('op1')], gets: [snapshotOf('PROCESSING')] });
  await h.controller.submit(BODY, 'u1', '');
  const keyBefore = stored(h.storage).key;

  const end = await runPolling({ controller: h.controller, getEditorSignature: () => '', sleep: noSleep, isCancelled: () => false, onOutcome: () => {} });
  assert.equal(end, 'exhausted');
  assert.equal(h.gets.length, POLL_MAX_ATTEMPTS);
  assert.deepEqual(stored(h.storage), { v: 1, userId: 'u1', key: keyBefore, fingerprint: stored(h.storage).fingerprint, operationId: 'op1' });
  const view = h.controller.getSnapshot().pending;
  assert.equal(view.operationId, 'op1');
  assert.equal(view.polling, false);

  const epoch = h.controller.getSnapshot().pollEpoch;
  h.controller.resumePolling();
  assert.equal(h.controller.getSnapshot().pending.polling, true);
  assert.equal(h.controller.getSnapshot().pollEpoch, epoch + 1);
  assert.equal(h.posts.length, 1, 'reanudar consulta no envía POST');
});

test('10b · la espera crece (2 s, 3 s, 5 s…) y no hay consultas sin espera entre medio', async () => {
  const waits = [];
  const h = harness({ posts: [accepted202('op1')], gets: [snapshotOf('PROCESSING'), snapshotOf('PROCESSING'), snapshotOf('PROCESSING'), completedSnap()] });
  await h.controller.submit(BODY, 'u1', '');
  const outcomes = [];
  await runPolling({ controller: h.controller, getEditorSignature: () => '', sleep: async (ms) => { waits.push(ms); }, isCancelled: () => false, onOutcome: (o) => outcomes.push(o.kind) });
  assert.deepEqual(waits, [3000, 5000, 8000]);
  assert.equal(outcomes.at(-1), 'completed');
});

test('11 · un error de GET (5xx, red, 403, 404) NO borra la clave ni el operationId', async () => {
  for (const [error, stop] of [[apiError(500, 'INTERNAL'), false], [NETWORK(), false], [apiError(403, 'FORBIDDEN'), true], [apiError(404, 'NOT_FOUND'), true]]) {
    const h = harness({ posts: [accepted202('op1')], gets: [error] });
    await h.controller.submit(BODY, 'u1', '');
    const before = stored(h.storage);
    const out = await h.controller.checkOnce(() => '');
    assert.equal(out.kind, 'error');
    assert.equal(out.stop, stop);
    assert.deepEqual(stored(h.storage), before, 'el registro quedó intacto');
    const view = h.controller.getSnapshot().pending;
    assert.equal(view.operationId, 'op1');
    assert.equal(view.lastCheckFailed, true);
    assert.equal(view.polling, !stop);
  }
});

test('11b · un resultado final se entrega aunque el ciclo se cancele mientras esperaba la respuesta', async () => {
  const h = harness({ posts: [accepted202('op1')], gets: [completedSnap()] });
  await h.controller.submit(BODY, 'u1', '');
  const delivered = [];
  let cancelled = false;
  const gate = h.getScript;
  gate[0] = () => { cancelled = true; return completedSnap(); }; // se cancela durante el GET
  const end = await runPolling({ controller: h.controller, getEditorSignature: () => '', sleep: noSleep, isCancelled: () => cancelled, onOutcome: (o) => delivered.push(o.kind) });
  assert.equal(end, 'done');
  assert.deepEqual(delivered, ['completed']);
});

/* ───────────────────────── 12–13 · H2: otro payload / otro usuario ───────────────────────── */

test('12 · H2: con una solicitud sin resolver, un payload distinto NO la reemplaza ni envía nada; tras el terminal usa clave nueva', async () => {
  const h = harness({ posts: [accepted202('op1'), ok200()], gets: [snapshotOf('FAILED')] });
  await h.controller.submit(BODY, 'u1', '');
  const before = stored(h.storage);

  assert.deepEqual(await h.controller.submit(OTHER_BODY, 'u1', ''), { kind: 'blocked', operationId: 'op1' });
  assert.equal(h.posts.length, 1, 'ningún POST con otro payload');
  assert.deepEqual(stored(h.storage), before, 'la clave y el operationId originales siguen intactos');

  // mientras el pendiente no sea terminal, sigue bloqueado
  assert.equal((await h.controller.submit(OTHER_BODY, 'u1', '')).kind, 'blocked');

  // GET confirma un estado final ⇒ ahora sí se puede iniciar una acción nueva, con clave nueva
  assert.equal((await h.controller.checkOnce(() => '')).kind, 'failed');
  assert.equal((await h.controller.submit(OTHER_BODY, 'u1', '')).kind, 'completed');
  assert.notEqual(h.posts[1].key, before.key);
  assert.deepEqual(h.posts[1].body, OTHER_BODY);
});

test('12b · nunca se envía una misma clave con payloads distintos (en ninguna secuencia)', async () => {
  const h = harness({ posts: [TIMEOUT(), TIMEOUT(), accepted202('op1')], gets: [snapshotOf('FAILED')] });
  await h.controller.submit(BODY, 'u1', '');
  await h.controller.submit(OTHER_BODY, 'u1', ''); // bloqueado
  await h.controller.retry('u1', '');
  const byKey = new Map();
  for (const p of h.posts) {
    const seen = byKey.get(p.key);
    if (seen) assert.deepEqual(seen, p.body, 'clave repetida ⇒ payload idéntico');
    byKey.set(p.key, p.body);
  }
  assert.equal(h.posts.length, 2);
});

test('12c · "descartar la referencia" es explícito: borra clave y operationId y libera un payload nuevo', async () => {
  const h = harness({ posts: [accepted202('op1'), ok200()] });
  await h.controller.submit(BODY, 'u1', '');
  h.controller.discard();
  assert.equal(stored(h.storage), null);
  assert.equal(h.controller.getSnapshot().pending, null);
  assert.equal((await h.controller.submit(OTHER_BODY, 'u1', '')).kind, 'completed');
});

test('13 · un cambio de usuario no restaura ni reutiliza la solicitud de otra identidad', async () => {
  const storage = memoryStorage();
  const a = harness({ posts: [accepted202('op1')], storage });
  await a.controller.submit(BODY, 'u1', '');
  const u1Key = stored(storage).key;

  // recarga de la pestaña con OTRO usuario
  const reload = harness({ posts: [ok200()], storage });
  reload.controller.restore('u2', '');
  assert.equal(reload.controller.getSnapshot().pending, null, 'no se muestra la solicitud ajena');
  assert.equal(stored(storage), null, 'el registro ajeno se elimina');

  // mismo controlador con otro usuario: no hereda clave ni operationId ni bloquea
  const same = harness({ posts: [accepted202('op1'), ok200()] });
  await same.controller.submit(BODY, 'u1', '');
  assert.equal((await same.controller.submit(BODY, 'u2', '')).kind, 'completed');
  assert.notEqual(same.posts[1].key, same.posts[0].key);
  assert.notEqual(same.posts[1].key, u1Key);
});

test('13b · sin sesión no se envía nada; la sesión que llega después restaura la solicitud del mismo usuario (hidratación)', async () => {
  const storage = memoryStorage();
  const a = harness({ posts: [accepted202('op1')], storage });
  await a.controller.submit(BODY, 'u1', '');

  const b = harness({ storage });
  b.controller.restore(null, ''); // aún sin hidratar
  assert.equal(b.controller.getSnapshot().pending, null);
  assert.deepEqual(await b.controller.submit(BODY, null, ''), { kind: 'unauthenticated' });
  assert.equal(b.posts.length, 0);
  assert.ok(stored(storage), 'el registro no se toca mientras no hay usuario');

  b.controller.restore('u1', ''); // llega el usuario
  assert.equal(b.controller.getSnapshot().pending.operationId, 'op1');
  assert.equal(b.controller.getSnapshot().pending.cause, 'restored');
});

/* ───────────────────────── 14 · doble clic ───────────────────────── */

test('14 · doble clic / envíos concurrentes: como máximo UN POST en vuelo', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness({ posts: [async () => { await gate; return ok200(); }] });
  const first = h.controller.submit(BODY, 'u1', '');
  const second = h.controller.submit(BODY, 'u1', '');
  const third = h.controller.retry('u1', '');
  assert.deepEqual(await second, { kind: 'busy' });
  assert.deepEqual(await third, { kind: 'busy' });
  assert.equal(h.controller.getSnapshot().busy, true);
  assert.equal(h.posts.length, 1);
  release();
  assert.equal((await first).kind, 'completed');
  assert.equal(h.controller.getSnapshot().busy, false);
  assert.equal(h.posts.length, 1);
});

/* ───────────────────────── 17 · H4: editor modificado ───────────────────────── */

test('17 · H4: si el editor cambió mientras esperaba, la letra recuperada queda en espera (y la solicitud guardada) hasta aceptarla', async () => {
  const baseline = editorSignature({ title: 'Mi título', lyrics: 'mi letra' });
  const h = harness({ posts: [accepted202('op1')], gets: [completedSnap(), completedSnap()] });
  await h.controller.submit(BODY, 'u1', baseline);

  const edited = editorSignature({ title: 'Mi título', lyrics: 'mi letra editada' });
  const changed = await h.controller.checkOnce(() => edited);
  assert.equal(changed.kind, 'completed');
  assert.equal(changed.editorChanged, true);
  h.controller.holdRecovered({ title: changed.title, lyrics: changed.lyrics });
  assert.deepEqual(h.controller.getSnapshot().recovered, { title: 'Recuperada', lyrics: '[verse]\nrecuperada' });
  assert.ok(stored(h.storage), 'sigue guardada: si se recarga antes de aceptar, se vuelve a recuperar');

  h.controller.finishRecovered(); // el usuario aceptó o eligió conservar la suya
  assert.equal(h.controller.getSnapshot().recovered, null);
  assert.equal(stored(h.storage), null);
});

test('17b · si el editor NO cambió, la recuperación se puede aplicar sola; la firma es estable', async () => {
  const baseline = editorSignature({ title: 'T', lyrics: 'L' });
  const h = harness({ posts: [accepted202('op1')], gets: [completedSnap()] });
  await h.controller.submit(BODY, 'u1', baseline);
  const out = await h.controller.checkOnce(() => editorSignature({ title: 'T', lyrics: 'L' }));
  assert.equal(out.editorChanged, false);
  assert.equal(editorSignature(null), editorSignature(undefined));
  assert.notEqual(editorSignature({ title: 'a', lyrics: 'b' }), editorSignature({ title: 'ab', lyrics: '' }));
});

test('17c · tras una recarga la línea base es el editor al restaurar: un cambio posterior también se respeta', async () => {
  const storage = memoryStorage();
  await harness({ posts: [accepted202('op1')], storage }).controller.submit(BODY, 'u1', 'viejo');
  const h = harness({ gets: [completedSnap()], storage });
  h.controller.restore('u1', 'editor-al-recargar');
  const out = await h.controller.checkOnce(() => 'editor-modificado-despues');
  assert.equal(out.editorChanged, true);
});

test('17d · dos consultas que terminan a la vez entregan la letra UNA sola vez; sin línea base conocida se pide aceptación', async () => {
  const h = harness({ posts: [accepted202('op1')], gets: [completedSnap()] });
  await h.controller.submit(BODY, 'u1', 'base');
  const [a, b] = await Promise.all([h.controller.checkOnce(() => 'base'), h.controller.checkOnce(() => 'base')]);
  assert.deepEqual([a.kind, b.kind].sort(), ['completed', 'none']);

  const noBase = harness({ posts: [accepted202('op1')], gets: [completedSnap()] });
  await noBase.controller.submit(BODY, 'u1', null);
  assert.equal((await noBase.controller.checkOnce(() => '')).editorChanged, true);
});

test('19 - 200 recibido por el POST con el editor MODIFICADO mientras esperaba: no se aplica sola; queda en espera y la solicitud guardada', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness({ posts: [async () => { await gate; return ok200(); }] });
  const pending = h.controller.submit(BODY, 'u1', 'editor-inicial');
  h.state.editor = 'el usuario escribio algo nuevo'; // modificacion mientras el POST esta en vuelo
  release();
  const out = await pending;
  assert.equal(out.kind, 'completed');
  assert.equal(out.editorChanged, true);
  assert.deepEqual(h.controller.getSnapshot().recovered, { title: 'Café', lyrics: '[verse]\nhola' });
  assert.equal(h.controller.getSnapshot().pending, null);
  assert.equal(stored(h.storage).operationId, 'op1', 'la operacion sigue recuperable hasta aceptar o descartar');

  h.controller.finishRecovered();
  assert.equal(h.controller.getSnapshot().recovered, null);
  assert.equal(stored(h.storage), null);
});

test('19b - 200 con el editor SIN cambios se aplica sola (editorChanged=false) y se olvida la solicitud; sin linea base fiable exige aceptacion', async () => {
  const ok = harness({ posts: [ok200()] });
  const out = await ok.controller.submit(BODY, 'u1', 'igual');
  assert.equal(out.editorChanged, false);
  assert.equal(ok.controller.getSnapshot().recovered, null);
  assert.equal(stored(ok.storage), null);

  const noBase = harness({ posts: [ok200()] });
  const out2 = await noBase.controller.submit(BODY, 'u1', null);
  assert.equal(out2.editorChanged, true);
  assert.ok(noBase.controller.getSnapshot().recovered);
});

test('19c - reintento tras timeout: la linea base es la del reintento explicito, y un cambio DURANTE el reintento se respeta', async () => {
  const h = harness({ posts: [TIMEOUT(), ok200()] });
  await h.controller.submit(BODY, 'u1', 'A');
  h.state.editor = 'B'; // el usuario edita despues del timeout
  const out = await h.controller.retry('u1', 'B');
  assert.equal(out.editorChanged, false, 'el reintento parte del editor actual (B)');

  const h2 = harness({ posts: [TIMEOUT(), async () => { h2.state.editor = 'C'; return ok200(); }] });
  await h2.controller.submit(BODY, 'u1', 'A');
  const out2 = await h2.controller.retry('u1', 'A');
  assert.equal(out2.editorChanged, true, 'cambio durante el reintento');
});

test('19d - la misma letra no se aplica dos veces: si la solicitud se descarto o ya la entrego otro camino, el 200 queda superseded', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness({ posts: [async () => { await gate; return ok200(); }] });
  const pending = h.controller.submit(BODY, 'u1', '');
  h.controller.discard(); // mientras tanto se descarta la referencia
  release();
  assert.deepEqual(await pending, { kind: 'superseded' });
  assert.equal(h.controller.getSnapshot().recovered, null);

  // y la consulta por GET posterior a un 200 retenido no vuelve a entregar la letra
  const h2 = harness({ posts: [ok200()], gets: [completedSnap()] });
  h2.state.editor = 'cambiado';
  await h2.controller.submit(BODY, 'u1', 'base');
  assert.equal((await h2.controller.checkOnce(() => 'cambiado')).kind, 'none');
});

/* ───────────────────────── 18 · dejar de consultar ───────────────────────── */

test('18 · pausar la consulta conserva clave, operationId y registro; se reanuda sin POST', async () => {
  const h = harness({ posts: [accepted202('op1')], gets: [completedSnap()] });
  await h.controller.submit(BODY, 'u1', '');
  const before = stored(h.storage);
  h.controller.pausePolling();
  assert.equal(h.controller.getSnapshot().pending.polling, false);
  assert.equal(h.controller.getSnapshot().pending.operationId, 'op1');
  assert.deepEqual(stored(h.storage), before);

  h.controller.resumePolling();
  assert.equal(h.controller.getSnapshot().pending.polling, true);
  assert.equal((await h.controller.checkOnce(() => '')).kind, 'completed');
  assert.equal(h.posts.length, 1);
});

/* ───────────────────────── recarga y persistencia ───────────────────────── */

test('R1 · recarga con operationId: se restaura y se consulta por GET (sin POST)', async () => {
  const storage = memoryStorage();
  await harness({ posts: [accepted202('op1')], storage }).controller.submit(BODY, 'u1', '');

  const h = harness({ gets: [completedSnap()], storage });
  h.controller.restore('u1', '');
  const view = h.controller.getSnapshot().pending;
  assert.equal(view.cause, 'restored');
  assert.equal(view.operationId, 'op1');
  assert.equal(view.polling, true);
  assert.equal((await h.controller.checkOnce(() => '')).kind, 'completed');
  assert.equal(h.posts.length, 0);
});

test('R2 · recarga SIN operationId (respuesta perdida): volver a generar con los mismos datos reutiliza la clave; con otros datos queda bloqueado', async () => {
  const storage = memoryStorage();
  await harness({ posts: [NETWORK()], storage }).controller.submit(BODY, 'u1', '');
  const originalKey = stored(storage).key;

  const h = harness({ posts: [ok200()], storage });
  h.controller.restore('u1', '');
  assert.equal(h.controller.getSnapshot().pending.canRetry, false, 'no hay body que reenviar tras recargar');
  assert.equal((await h.controller.submit(OTHER_BODY, 'u1', '')).kind, 'blocked');
  assert.equal(h.posts.length, 0);

  assert.equal((await h.controller.submit(BODY, 'u1', '')).kind, 'completed');
  assert.equal(h.posts[0].key, originalKey);
});

test('R3 · sessionStorage guarda SOLO v, userId, key, fingerprint y operationId (nada de letras, prompts ni tokens)', async () => {
  const secretBody = { idea: 'MI IDEA SECRETA', existingLyrics: 'LETRA PRIVADA COMPLETA', genre: 'tango' };
  const h = harness({ posts: [accepted202('op1')] });
  await h.controller.submit(secretBody, 'u1', editorSignature({ title: 'T', lyrics: 'LETRA DEL EDITOR' }));
  const raw = h.storage.raw.get(PENDING_STORAGE_KEY);
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['fingerprint', 'key', 'operationId', 'userId', 'v']);
  for (const secret of ['SECRETA', 'PRIVADA', 'EDITOR', 'Bearer']) assert.ok(!raw.includes(secret), secret);
  assert.equal(h.storage.raw.size, 1);
});

test('R4 - key-conflict es terminal para esa clave; LYRICS_EMPTY NO se da por terminal hasta que el 409 lo confirme', async () => {
  // El backend responde 422 LYRICS_EMPTY aunque el cierre de la operacion haya fallado: el 422 solo no prueba el estado final.
  const empty = harness({ posts: [apiError(422, 'UNPROCESSABLE', { code: 'LYRICS_EMPTY' }), apiError(409, 'CONFLICT', { code: 'ASSISTANT_OPERATION_FAILED', operationId: 'op1' })] });
  assert.equal((await empty.controller.submit(BODY, 'u1', '')).kind, 'pending');
  const key = stored(empty.storage).key;
  assert.equal((await empty.controller.retry('u1', '')).kind, 'failed', 'el 409 con la misma clave confirma el estado final');
  assert.equal(empty.posts[1].key, key);
  assert.equal(stored(empty.storage), null);

  const conflict = harness({ posts: [TIMEOUT(), apiError(422, 'UNPROCESSABLE', { code: 'IDEMPOTENCY_KEY_REUSED', operationId: 'x' })] });
  await conflict.controller.submit(BODY, 'u1', '');
  assert.equal((await conflict.controller.retry('u1', '')).reason, 'key-conflict');
  assert.equal(stored(conflict.storage), null);
});

test('R5 · ningún error genera POST automáticos: tras cualquier error, solo hay los POST que la persona pidió', async () => {
  for (const error of [TIMEOUT(), NETWORK(), apiError(500, 'INTERNAL'), apiError(502, 'ERROR'), apiError(429, 'RATE_LIMITED'), apiError(409, 'CONFLICT')]) {
    const h = harness({ posts: [error] });
    await h.controller.submit(BODY, 'u1', '');
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(h.posts.length, 1);
  }
});

/* ───────────────────────── 422 definitivos previos a la operación ───────────────────────── */

const PRICING_422 = () => apiError(422, 'UNPROCESSABLE', { code: 'PRICING_NOT_CONFIGURED', providerModelId: 'm1', generationType: 'LYRICS' }, 'El modelo no tiene precio configurado para LYRICS');
const NO_PROVIDER_422 = () => apiError(422, 'UNPROCESSABLE', { code: 'NO_LYRICS_PROVIDER' }, 'No hay proveedor de letras disponible');

for (const [reason, make] of [['pricing-not-configured', PRICING_422], ['no-lyrics-provider', NO_PROVIDER_422]]) {
  test(`8 · 422 ${reason}: rechazo definitivo (no incierto), sin clave guardada ni solicitud pendiente, y se puede volver a pedir`, async () => {
    const h = harness({ posts: [make(), ok200()] });
    const out = await h.controller.submit(BODY, 'u1', '');
    assert.deepEqual({ kind: out.kind, reason: out.reason, kept: out.kept }, { kind: 'rejected', reason, kept: false });
    assert.equal(stored(h.storage), null, 'no queda una referencia de idempotencia como si la operación estuviera pendiente');
    assert.equal(h.controller.getSnapshot().pending, null, 'la interfaz no muestra «pudo haber llegado»');
    assert.equal(h.controller.getSnapshot().busy, false);

    // El usuario corrige el problema y pide de nuevo: es una solicitud nueva (clave nueva) y funciona.
    const again = await h.controller.submit(BODY, 'u1', '');
    assert.equal(again.kind, 'completed');
    assert.notEqual(h.posts[1].key, h.posts[0].key);
    // Y un pedido distinto tampoco queda bloqueado por el rechazo anterior.
    const h2 = harness({ posts: [make(), ok200()] });
    await h2.controller.submit(BODY, 'u1', '');
    assert.equal((await h2.controller.submit(OTHER_BODY, 'u1', '')).kind, 'completed');
  });

  test(`8b · 422 ${reason} tras un intento previo incierto con la misma clave: el backend resuelve una clave existente ANTES de estos errores, así que la clave se descarta`, async () => {
    const h = harness({ posts: [TIMEOUT(), make(), ok200()] });
    await h.controller.submit(BODY, 'u1', '');
    assert.ok(stored(h.storage)?.key, 'tras el timeout la clave se conserva');
    const out = await h.controller.retry('u1', '');
    assert.deepEqual({ kind: out.kind, kept: out.kept }, { kind: 'rejected', kept: false });
    assert.equal(stored(h.storage), null);
    assert.equal(h.controller.getSnapshot().pending, null);
  });
}

test('8c · el cambio es mínimo: otro 422 (código distinto o sin detalle) y los errores inciertos conservan el tratamiento de siempre', async () => {
  for (const make of [
    () => apiError(422, 'UNPROCESSABLE', { code: 'LYRICS_EMPTY' }),
    () => apiError(422, 'UNPROCESSABLE'),
    () => apiError(422, 'UNPROCESSABLE', { code: 'OTRO' }),
    () => apiError(500, 'INTERNAL'),
    TIMEOUT,
    NETWORK,
  ]) {
    const h = harness({ posts: [make()] });
    const out = await h.controller.submit(BODY, 'u1', '');
    assert.equal(out.kind, 'pending', String(make().code));
    assert.ok(stored(h.storage)?.key, 'la clave se conserva');
    assert.notEqual(h.controller.getSnapshot().pending, null);
  }
});

test('8d · una operación que SÍ sigue en curso no pierde su clave: con operationId no se reenvía el POST, y un pedido distinto queda bloqueado', async () => {
  const h = harness({ posts: [accepted202('op9'), PRICING_422()] });
  assert.equal((await h.controller.submit(BODY, 'u1', '')).kind, 'pending');
  const key = stored(h.storage).key;
  assert.equal(stored(h.storage).operationId, 'op9');

  const same = await h.controller.submit(BODY, 'u1', '');
  assert.equal(same.kind, 'resume');
  assert.equal(h.posts.length, 1, 'no se reenvió el POST');
  const other = await h.controller.submit(OTHER_BODY, 'u1', '');
  assert.equal(other.kind, 'blocked');
  assert.equal(h.posts.length, 1, 'tampoco se envió el pedido distinto');
  assert.equal(stored(h.storage).key, key, 'la clave de la operación en curso sigue guardada');
  assert.equal(stored(h.storage).operationId, 'op9');
});

test('8e · el estudio de letras ya no promete gratuidad ni anuncia un precio fijo, y muestra mensajes propios para los dos rechazos', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/features/creator/LyricsStudio.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /son gratis en Melodya/i);
  assert.doesNotMatch(src, /asistente[^.\n]*gratis/i);
  assert.match(src, /out\.reason === 'pricing-not-configured'/);
  assert.match(src, /out\.reason === 'no-lyrics-provider'/);
});

/* ───────────────────────── NO_LYRICS_PROVIDER DESPUÉS de crear la operación (details.operationId) ───────────────────────── */

const NO_PROVIDER_AFTER = (extra = {}) => apiError(422, 'UNPROCESSABLE', { code: 'NO_LYRICS_PROVIDER', operationId: 'op7', ...extra }, 'No hay proveedor de letras disponible');

test('14 · NO_LYRICS_PROVIDER con operationId: la operación EXISTE — se conserva la clave, se guarda el id y se la sigue por GET; no es un rechazo previo', async () => {
  const h = harness({ posts: [NO_PROVIDER_AFTER(), ok200()], gets: [snapshotOf('PROCESSING'), snapshotOf('FAILED')] });
  const out = await h.controller.submit(BODY, 'u1', '');
  assert.deepEqual(out, { kind: 'pending', operationId: 'op7', uncertain: false, cause: 'accepted' });
  assert.equal(stored(h.storage).operationId, 'op7');
  const key = stored(h.storage).key;
  const view = h.controller.getSnapshot().pending;
  assert.equal(view.operationId, 'op7');
  assert.equal(view.polling, true);
  assert.equal(view.canRetry, false, 'no se ofrece reenviar el POST');

  // Pulsar «generar» otra vez con lo mismo: se consulta la operación, NO se reenvía el POST.
  assert.equal((await h.controller.submit(BODY, 'u1', '')).kind, 'resume');
  assert.equal(h.posts.length, 1);
  // Con otro contenido tampoco se envía nada (evita un segundo débito mientras la primera sigue sin resolver).
  assert.equal((await h.controller.submit(OTHER_BODY, 'u1', '')).kind, 'blocked');
  assert.equal(h.posts.length, 1);
  assert.equal(stored(h.storage).key, key);
});

test('14b · operación existente FAILED (consultada por GET): estado terminal respetado, se limpia la referencia y recién entonces una acción nueva usa clave nueva', async () => {
  const h = harness({ posts: [NO_PROVIDER_AFTER(), ok200()], gets: [snapshotOf('FAILED')] });
  await h.controller.submit(BODY, 'u1', '');
  const key = stored(h.storage).key;
  const outcomes = [];
  await runPolling({ controller: h.controller, getEditorSignature: () => '', sleep: noSleep, isCancelled: () => false, onOutcome: (o) => outcomes.push(o.kind) });
  assert.deepEqual(h.gets, ['op7'], 'se consultó la operación indicada, con el flujo autenticado existente');
  assert.deepEqual(outcomes, ['failed']);
  assert.equal(stored(h.storage), null);
  assert.equal(h.controller.getSnapshot().pending, null);

  const next = await h.controller.submit(OTHER_BODY, 'u1', '');
  assert.equal(next.kind, 'completed');
  assert.equal(h.posts.length, 2);
  assert.notEqual(h.posts[1].key, key);
});

test('14c · operación existente en PROCESSING: se sigue consultando (sin reenviar el POST) y la clave y el id quedan guardados', async () => {
  const h = harness({ posts: [NO_PROVIDER_AFTER()], gets: [snapshotOf('PROCESSING')] });
  await h.controller.submit(BODY, 'u1', '');
  const key = stored(h.storage).key;
  const end = await runPolling({ controller: h.controller, getEditorSignature: () => '', sleep: noSleep, isCancelled: () => false, onOutcome: () => {} });
  assert.equal(end, 'exhausted');
  assert.equal(h.gets.length, POLL_MAX_ATTEMPTS);
  assert.equal(h.posts.length, 1, 'ningún POST nuevo');
  assert.equal(stored(h.storage).key, key);
  assert.equal(stored(h.storage).operationId, 'op7');
});

test('14d · cierre incierto (closeUncertain): la referencia se conserva, se marca como pendiente de confirmación y no se afirma que el débito se revirtió', async () => {
  const h = harness({ posts: [NO_PROVIDER_AFTER({ closeUncertain: true })], gets: [snapshotOf('PROCESSING', { uncertainSince: '2026-10-15T00:00:00Z' })] });
  const out = await h.controller.submit(BODY, 'u1', '');
  assert.deepEqual(out, { kind: 'pending', operationId: 'op7', uncertain: true, cause: 'accepted' });
  assert.equal(h.controller.getSnapshot().pending.uncertain, true);
  assert.equal(stored(h.storage).operationId, 'op7');
  assert.equal((await h.controller.submit(BODY, 'u1', '')).kind, 'resume');
  assert.equal(h.posts.length, 1, 'no se reenvió el POST');
  assert.equal((await h.controller.submit(OTHER_BODY, 'u1', '')).kind, 'blocked');
});

test('14e · un operationId que no es un texto (o vacío) no cuenta: se trata como rechazo previo a la creación', async () => {
  for (const operationId of [undefined, '', 123, null, {}]) {
    const h = harness({ posts: [apiError(422, 'UNPROCESSABLE', { code: 'NO_LYRICS_PROVIDER', operationId })] });
    const out = await h.controller.submit(BODY, 'u1', '');
    assert.equal(out.kind, 'rejected', String(operationId));
    assert.equal(stored(h.storage), null);
  }
});

test('14f · una operación previa en curso (clave guardada) que recibe NO_LYRICS_PROVIDER SIN operationId se descarta solo si no tiene id; con id conocido no se llega a reenviar el POST', async () => {
  const h = harness({ posts: [accepted202('op9'), NO_PROVIDER_422()] });
  await h.controller.submit(BODY, 'u1', '');
  await h.controller.submit(BODY, 'u1', '');
  assert.equal(h.posts.length, 1);
  assert.equal(stored(h.storage).operationId, 'op9');
});

/* ───────────────────────── closeUncertain: persistencia de la señal ───────────────────────── */

const CLOSE_UNCERTAIN = () => NO_PROVIDER_AFTER({ closeUncertain: true });

test('15a · closeUncertain tras el error: se refleja en la vista y se persiste junto a la clave y el operationId (solo cuando es true)', async () => {
  const h = harness({ posts: [CLOSE_UNCERTAIN()] });
  await h.controller.submit(BODY, 'u1', '');
  const view = h.controller.getSnapshot().pending;
  assert.deepEqual({ op: view.operationId, uncertain: view.uncertain, closeUncertain: view.closeUncertain, polling: view.polling }, { op: 'op7', uncertain: true, closeUncertain: true, polling: true });
  assert.deepEqual(Object.keys(stored(h.storage)).sort(), ['closeUncertain', 'fingerprint', 'key', 'operationId', 'userId', 'v']);
  assert.equal(stored(h.storage).closeUncertain, true);

  // Sin la señal no se escribe ningún campo extra.
  const plain = harness({ posts: [NO_PROVIDER_AFTER()] });
  await plain.controller.submit(BODY, 'u1', '');
  assert.equal('closeUncertain' in stored(plain.storage), false);
  assert.equal(plain.controller.getSnapshot().pending.closeUncertain, false);
});

test('15b · una consulta posterior que devuelve PROCESSING (sin uncertainSince) NO borra la señal ni la presenta como procesamiento normal', async () => {
  const h = harness({ posts: [CLOSE_UNCERTAIN()], gets: [snapshotOf('PROCESSING')] });
  await h.controller.submit(BODY, 'u1', '');
  const key = stored(h.storage).key;
  for (let i = 0; i < 3; i += 1) assert.equal((await h.controller.checkOnce(() => '')).kind, 'pending');
  const view = h.controller.getSnapshot().pending;
  assert.deepEqual({ uncertain: view.uncertain, closeUncertain: view.closeUncertain }, { uncertain: true, closeUncertain: true });
  assert.equal(stored(h.storage).closeUncertain, true);
  assert.equal(stored(h.storage).key, key);
  // Reanudar la consulta y repetir la solicitud tampoco la pierden, ni reenvían el POST.
  assert.equal((await h.controller.submit(BODY, 'u1', '')).kind, 'resume');
  assert.equal(h.controller.getSnapshot().pending.closeUncertain, true);
  assert.equal((await h.controller.submit(OTHER_BODY, 'u1', '')).kind, 'blocked');
  assert.equal(h.posts.length, 1);
});

test('15c · recarga: la operación y la señal se recuperan del almacenamiento; se consulta por GET, no se reenvía el POST y otro contenido sigue bloqueado', async () => {
  const storage = memoryStorage();
  await harness({ posts: [CLOSE_UNCERTAIN()], storage }).controller.submit(BODY, 'u1', '');

  const h = harness({ gets: [snapshotOf('PROCESSING')], storage });
  h.controller.restore('u1', '');
  const view = h.controller.getSnapshot().pending;
  assert.deepEqual({ cause: view.cause, op: view.operationId, uncertain: view.uncertain, closeUncertain: view.closeUncertain, polling: view.polling }, { cause: 'restored', op: 'op7', uncertain: true, closeUncertain: true, polling: true });
  assert.equal((await h.controller.checkOnce(() => '')).kind, 'pending');
  assert.equal(h.controller.getSnapshot().pending.closeUncertain, true, 'la consulta tras la recarga conserva la señal');
  assert.equal((await h.controller.submit(OTHER_BODY, 'u1', '')).kind, 'blocked');
  assert.equal((await h.controller.submit(BODY, 'u1', '')).kind, 'resume');
  assert.equal(h.posts.length, 0, 'ningún POST después de recargar');
});

test('15d · estado terminal: al confirmarse FAILED se limpia la solicitud y la señal; una solicitud nueva no la hereda', async () => {
  const h = harness({ posts: [CLOSE_UNCERTAIN(), accepted202('op8')], gets: [snapshotOf('PROCESSING'), snapshotOf('FAILED'), snapshotOf('PROCESSING')] });
  await h.controller.submit(BODY, 'u1', '');
  await h.controller.checkOnce(() => '');
  assert.equal(h.controller.getSnapshot().pending.closeUncertain, true);

  const end = await h.controller.checkOnce(() => '');
  assert.deepEqual(end, { kind: 'failed', reason: 'failed' });
  assert.equal(stored(h.storage), null, 'la señal persistida desaparece con la solicitud');
  assert.equal(h.controller.getSnapshot().pending, null);

  // Solicitud nueva (otra operación): ni clave ni señal heredadas.
  const next = await h.controller.submit(OTHER_BODY, 'u1', '');
  assert.deepEqual(next, { kind: 'pending', operationId: 'op8', uncertain: false, cause: 'accepted' });
  assert.equal('closeUncertain' in stored(h.storage), false);
  assert.deepEqual({ u: h.controller.getSnapshot().pending.uncertain, c: h.controller.getSnapshot().pending.closeUncertain }, { u: false, c: false });
  assert.equal((await h.controller.checkOnce(() => '')).kind, 'pending');
  assert.equal(h.controller.getSnapshot().pending.uncertain, false, 'una operación normal en PROCESSING no queda marcada');
});

test('15e · descartar la referencia (acción explícita) también elimina la señal persistida', async () => {
  const h = harness({ posts: [CLOSE_UNCERTAIN()] });
  await h.controller.submit(BODY, 'u1', '');
  h.controller.discard();
  assert.equal(stored(h.storage), null);
  assert.equal(h.controller.getSnapshot().pending, null);
});

/* ───────────────────────── registro persistido: validación independiente de cada campo ───────────────────────── */

const VALID_RECORD = { v: 1, userId: 'u1', key: 'clave-valida-1', fingerprint: fingerprintPayload(BODY), operationId: 'op1' };
const saveRaw = (storage, rec) => storage.setItem(PENDING_STORAGE_KEY, JSON.stringify(rec));

test('16a · registro válido con closeUncertain: true → se recupera con la señal', () => {
  const storage = memoryStorage();
  saveRaw(storage, { ...VALID_RECORD, closeUncertain: true });
  assert.deepEqual(loadAttempt(storage, 'u1'), { ...VALID_RECORD, closeUncertain: true });
});

test('16b · registro válido sin closeUncertain → se recupera sin la señal (como siempre); con y sin operationId', () => {
  const storage = memoryStorage();
  saveRaw(storage, VALID_RECORD);
  assert.deepEqual(loadAttempt(storage, 'u1'), VALID_RECORD);
  const { operationId, ...noOp } = VALID_RECORD;
  saveRaw(storage, noOp);
  assert.deepEqual(loadAttempt(storage, 'u1'), noOp);
});

test('16c · closeUncertain inválido con campos esenciales válidos: se ignora SOLO ese campo y la referencia (clave, huella, operationId) se recupera', async () => {
  for (const bad of ['si', 1, 0, null, {}, [], false, 'true']) {
    const storage = memoryStorage();
    saveRaw(storage, { ...VALID_RECORD, closeUncertain: bad });
    assert.deepEqual(loadAttempt(storage, 'u1'), VALID_RECORD, `valor ${JSON.stringify(bad)}`);
    assert.notEqual(storage.getItem(PENDING_STORAGE_KEY), null, 'el registro no se elimina');

    const h = harness({ gets: [snapshotOf('PROCESSING')], storage });
    h.controller.restore('u1', '');
    const view = h.controller.getSnapshot().pending;
    assert.deepEqual({ op: view.operationId, polling: view.polling, closeUncertain: view.closeUncertain, uncertain: view.uncertain }, { op: 'op1', polling: true, closeUncertain: false, uncertain: false });
    // la operación sigue protegida: otro contenido bloqueado y repetir consulta por GET sin POST
    assert.equal((await h.controller.submit(OTHER_BODY, 'u1', '')).kind, 'blocked');
    assert.equal((await h.controller.submit(BODY, 'u1', '')).kind, 'resume');
    assert.equal(h.posts.length, 0);
  }
});

test('16d · campo ESENCIAL inválido: el registro no se reanuda ni se repara; restaurar nunca envía un POST ni inventa clave, huella u operationId', () => {
  const bads = [
    { ...VALID_RECORD, v: 2 },
    { ...VALID_RECORD, userId: '' },
    { ...VALID_RECORD, userId: 7 },
    { ...VALID_RECORD, key: 'corta' },
    { ...VALID_RECORD, key: 'x'.repeat(129) },
    { ...VALID_RECORD, key: undefined },
    { ...VALID_RECORD, fingerprint: '' },
    { ...VALID_RECORD, fingerprint: undefined },
    { ...VALID_RECORD, operationId: '' },
    { ...VALID_RECORD, operationId: 123 },
    { ...VALID_RECORD, operationId: null },
    'no-es-un-objeto',
    null,
  ];
  for (const bad of bads) {
    const storage = memoryStorage();
    storage.setItem(PENDING_STORAGE_KEY, typeof bad === 'string' && bad === 'no-es-un-objeto' ? '{roto' : JSON.stringify(bad));
    assert.equal(loadAttempt(storage, 'u1'), null, JSON.stringify(bad));
    const h = harness({ storage });
    h.controller.restore('u1', '');
    assert.equal(h.controller.getSnapshot().pending, null, 'no hay solicitud pendiente que reanudar');
    assert.equal(h.posts.length, 0, 'restaurar no envía ningún POST');
    assert.equal(h.gets.length, 0);
  }
  // Un registro de OTRO usuario tampoco se reanuda (comportamiento existente).
  const other = memoryStorage();
  saveRaw(other, { ...VALID_RECORD, userId: 'u2' });
  assert.equal(loadAttempt(other, 'u1'), null);
});

test('16e · operación pendiente recuperada tras recargar (registro con closeUncertain inválido): repetir la solicitud consulta por GET y no reenvía el POST', async () => {
  const storage = memoryStorage();
  saveRaw(storage, { ...VALID_RECORD, closeUncertain: 'raro' });
  const h = harness({ gets: [snapshotOf('PROCESSING'), snapshotOf('FAILED')], storage });
  h.controller.restore('u1', '');
  assert.equal((await h.controller.submit(BODY, 'u1', '')).kind, 'resume');
  assert.equal(h.posts.length, 0);
  assert.equal((await h.controller.checkOnce(() => '')).kind, 'pending');
  assert.equal((await h.controller.checkOnce(() => '')).kind, 'failed');
  assert.deepEqual(h.gets, ['op1', 'op1']);
  assert.equal(stored(storage), null);
});

/* ───────────────────────── mensajes del aviso pendiente (describePending) ───────────────────────── */

const view = (over = {}) => ({ operationId: 'op1', uncertain: false, closeUncertain: false, cause: 'accepted', polling: true, checking: false, lastCheckFailed: false, canRetry: false, ...over });
const CLAIMS_DONE = /(ya terminó|está lista|se devolvieron las fichas|fichas (fueron|se) reintegr|completó la letra\.)/i;

test('17a · sondeo ACTIVO: dice que sigue consultando', () => {
  const d = describePending(view());
  assert.match(d.text, /Seguimos consultando el estado/);
  assert.doesNotMatch(d.text, /se detuvo/);
});

test('17b · sondeo PAUSADO (límite de intentos o 403/404): no afirma que sigue consultando, ofrece consultar de nuevo y mantiene el bloqueo', () => {
  const d = describePending(view({ polling: false }));
  assert.doesNotMatch(d.text, /Seguimos consultando/);
  assert.match(d.text, /se detuvo/);
  assert.match(d.text, /Consultar ahora/);
  assert.match(d.text, /no enviamos una solicitud nueva/);
  assert.match(d.title, /pendiente de confirmación/);
  assert.doesNotMatch(d.text, CLAIMS_DONE);
});

test('17c · cierre incierto: pendiente de confirmación, sin afirmar fin ni reintegro, con sondeo activo o pausado', () => {
  for (const polling of [true, false]) {
    const d = describePending(view({ closeUncertain: true, uncertain: true, polling }));
    assert.match(d.title, /pendiente de confirmación/);
    assert.match(d.text, /todavía no sabemos si se descontaron o se devolvieron fichas/);
    assert.doesNotMatch(d.text, CLAIMS_DONE);
    assert.equal(/Seguimos consultando/.test(d.text), polling, `polling=${polling}`);
    assert.equal(/se detuvo/.test(d.text), !polling, `polling=${polling}`);
  }
});

test('17d · resultado incierto del proveedor: tampoco dice que sigue consultando si el sondeo se detuvo', () => {
  assert.match(describePending(view({ uncertain: true })).text, /Seguimos consultando/);
  const paused = describePending(view({ uncertain: true, polling: false }));
  assert.doesNotMatch(paused.text, /Seguimos consultando/);
  assert.match(paused.text, /se detuvo/);
});

test('17e · los demás avisos (límite de solicitudes, restaurada sin id, sin id) conservan su texto', () => {
  assert.match(describePending(view({ cause: 'rate-limited', operationId: null })).title, /límite de solicitudes/);
  assert.match(describePending(view({ cause: 'restored', operationId: null })).title, /solicitud anterior sin confirmar/);
  assert.match(describePending(view({ cause: 'unknown', operationId: null })).title, /No pudimos confirmar el resultado/);
});

test('17f · el estado del sondeo sale del controlador: al agotarse los intentos la vista queda pausada y el aviso lo dice; al reanudar vuelve a decir que consulta', async () => {
  const h = harness({ posts: [accepted202('op1')], gets: [snapshotOf('PROCESSING')] });
  await h.controller.submit(BODY, 'u1', '');
  assert.match(describePending(h.controller.getSnapshot().pending).text, /Seguimos consultando/);
  await runPolling({ controller: h.controller, getEditorSignature: () => '', sleep: noSleep, isCancelled: () => false, onOutcome: () => {} });
  const paused = h.controller.getSnapshot().pending;
  assert.equal(paused.polling, false);
  assert.doesNotMatch(describePending(paused).text, /Seguimos consultando/);
  h.controller.resumePolling();
  assert.match(describePending(h.controller.getSnapshot().pending).text, /Seguimos consultando/);
  assert.equal(h.posts.length, 1);
});

test('17g · el estudio usa describePending de flow.ts y sus avisos ya no prometen un seguimiento incondicional', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/features/creator/LyricsStudio.tsx', import.meta.url), 'utf8');
  assert.match(src, /describePending,/);
  assert.doesNotMatch(src, /la seguimos por vos/);
  assert.doesNotMatch(src, /function describePending/);
});

/* ───────────────────────── H3 · VALIDATION_ERROR con detalles ───────────────────────── */

test('VALIDATION_ERROR real (UNPROCESSABLE + details.issues): el rechazo lleva los motivos del backend, no el genérico, y no queda clave', async () => {
  const err = apiError(422, 'UNPROCESSABLE', { code: 'VALIDATION_ERROR', issues: [{ path: 'existingLyrics', message: 'String must contain at most 5000 character(s)' }] }, 'Datos inválidos');
  const h = harness({ posts: [err] });
  const out = await h.controller.submit(BODY, 'u1', '');
  assert.deepEqual({ kind: out.kind, reason: out.reason, kept: out.kept }, { kind: 'rejected', reason: 'validation', kept: false });
  assert.equal(out.message, 'String must contain at most 5000 character(s)');
  assert.equal(stored(h.storage), null);
});

test('VALIDATION_ERROR sin detalles utilizables: se conserva el mensaje actual', async () => {
  const h = harness({ posts: [apiError(422, 'UNPROCESSABLE', { code: 'VALIDATION_ERROR', issues: [] }, 'Datos inválidos')] });
  const out = await h.controller.submit(BODY, 'u1', '');
  assert.equal(out.message, 'Datos inválidos');
});
