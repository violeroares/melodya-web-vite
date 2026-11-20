// Pruebas del flujo de letras del asistente (lógica pura). Ejecutar: node --test tests/
// Sin dependencias: Node 24 ejecuta el .ts directamente (type stripping).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PENDING_STORAGE_KEY,
  POLL_MAX_ATTEMPTS,
  classifyAssistantError,
  classifyAssistantResponse,
  ASSISTANT_EXISTING_LYRICS_MAX,
  improveLyricsTooLong,
  validationIssuesMessage,
  clearAttempt,
  createSubmitGate,
  fingerprintPayload,
  interpretOperationSnapshot,
  loadAttempt,
  newIdempotencyKey,
  pollDelayMs,
  resolveAttempt,
  saveAttempt,
  shouldContinuePolling,
  stableStringify,
} from '../src/lib/assistant-lyrics/flow.ts';

/** sessionStorage de pruebas. */
function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    raw: m,
  };
}

const PAYLOAD = { idea: 'un tango sobre el café', genre: 'tango', language: 'español' };
const makeCounter = () => {
  let n = 0;
  return { make: () => newIdempotencyKey(() => `uuid-${(n += 1)}`), calls: () => n };
};

/* ───────────────── 1–3 · respuestas del POST ───────────────── */

test('1 · 200 con letra válida ⇒ completed (con operationId si viene)', () => {
  const r = classifyAssistantResponse(200, {
    title: ' Café ', lyrics: '[verse]\nhola', tags: ['tango', 5],
    operation: { id: 'op1', status: 'COMPLETED', replayed: false },
  });
  assert.deepEqual(r, { kind: 'completed', title: 'Café', lyrics: '[verse]\nhola', tags: ['tango'], operationId: 'op1' });
});

test('1b · 200 sin título usa un título por defecto, pero exige la letra', () => {
  const r = classifyAssistantResponse(200, { lyrics: 'x' });
  assert.equal(r.kind, 'completed');
  assert.equal(r.title, 'Sin título');
});

test('2 · 200 con letra vacía, ausente o no-string ⇒ invalid (nunca éxito)', () => {
  for (const body of [{ lyrics: '' }, { lyrics: '   \n' }, { title: 'x' }, { lyrics: 42 }, {}, null, undefined, 'texto', []]) {
    assert.equal(classifyAssistantResponse(200, body).kind, 'invalid', JSON.stringify(body));
  }
});

test('3 · 202 sin letra ⇒ pending, sin falso éxito; conserva operation.id y la marca de incertidumbre', () => {
  const r = classifyAssistantResponse(202, { operation: { id: 'op9', status: 'PROCESSING', replayed: false, uncertain: true, message: 'pendiente' } });
  assert.deepEqual(r, { kind: 'pending', operationId: 'op9', uncertain: true, replayed: false, message: 'pendiente' });
  const inProgress = classifyAssistantResponse(202, { operation: { id: 'op9', status: 'PROCESSING', replayed: true } });
  assert.equal(inProgress.kind, 'pending');
  assert.equal(inProgress.uncertain, false);
});

test('3b · un 202 es pendiente AUNQUE trajera texto (el contrato dice que no hay letra todavía); sin operation.id es inválido', () => {
  assert.equal(classifyAssistantResponse(202, { lyrics: 'x', title: 'y', operation: { id: 'op1' } }).kind, 'pending');
  assert.equal(classifyAssistantResponse(202, {}).kind, 'invalid');
  assert.equal(classifyAssistantResponse(204, {}).kind, 'invalid');
});

/* ───────────────── 4 · timeout / corte de red y misma clave ───────────────── */

test('4 · (nivel función) timeout o corte de red ⇒ unknown; la integración con el componente está en assistant-lyrics-controller.test.mjs', () => {
  const storage = memoryStorage();
  const counter = makeCounter();
  const fp = fingerprintPayload(PAYLOAD);

  const first = resolveAttempt({ stored: loadAttempt(storage, 'u1'), userId: 'u1', fingerprint: fp, makeKey: counter.make });
  assert.equal(first.reused, false);
  saveAttempt(storage, first.attempt);

  // el POST falla por timeout (status 0, code TIMEOUT) o por corte de red
  assert.deepEqual(classifyAssistantError({ status: 0, code: 'TIMEOUT' }), { kind: 'unknown' });
  assert.deepEqual(classifyAssistantError({ status: 0, code: 'NETWORK' }), { kind: 'unknown' });

  const retry = resolveAttempt({ stored: loadAttempt(storage, 'u1'), userId: 'u1', fingerprint: fp, makeKey: counter.make });
  assert.equal(retry.reused, true);
  assert.equal(retry.attempt.key, first.attempt.key);
  assert.equal(counter.calls(), 1, 'no se generó ninguna clave nueva en el reintento');
});

test('4b · la clave cumple el contrato (8–128 caracteres)', () => {
  const key = newIdempotencyKey(() => '123e4567-e89b-12d3-a456-426614174000');
  assert.ok(key.length >= 8 && key.length <= 128);
});

/* ───────────────── 5 · recuperación por operation.id ───────────────── */

test('5 · recuperación por operation.id: pendiente → incierta → completada con la letra', () => {
  assert.deepEqual(interpretOperationSnapshot({ status: 'PROCESSING', jobs: [{ task: 'LYRICS', status: 'PROCESSING', uncertainSince: null }] }), { kind: 'pending', uncertain: false });
  assert.deepEqual(interpretOperationSnapshot({ status: 'PENDING', jobs: [] }), { kind: 'pending', uncertain: false });
  assert.deepEqual(
    interpretOperationSnapshot({ status: 'PROCESSING', jobs: [{ task: 'LYRICS', status: 'PROCESSING', uncertainSince: '2026-10-12T10:00:00.000Z' }] }),
    { kind: 'pending', uncertain: true },
  );
  assert.deepEqual(
    interpretOperationSnapshot({ status: 'COMPLETED', jobs: [{ task: 'LYRICS', status: 'COMPLETED', result: { title: 'T', lyrics: '[verse]\nok', tags: ['a'] } }] }),
    { kind: 'completed', title: 'T', lyrics: '[verse]\nok', tags: ['a'] },
  );
});

test('5b · PROCESSING sin uncertainSince NO se trata como incierta ni como final; COMPLETED sin letra es inválida', () => {
  const r = interpretOperationSnapshot({ status: 'PROCESSING', jobs: [{ task: 'LYRICS', status: 'PROCESSING' }] });
  assert.equal(r.kind, 'pending');
  assert.equal(r.uncertain, false);
  assert.equal(interpretOperationSnapshot({ status: 'COMPLETED', jobs: [{ task: 'LYRICS', result: { lyrics: '  ' } }] }).kind, 'invalid');
  assert.equal(interpretOperationSnapshot({ status: 'COMPLETED', jobs: [] }).kind, 'invalid');
  assert.equal(interpretOperationSnapshot({ status: 'RARO' }).kind, 'invalid');
  assert.equal(interpretOperationSnapshot(null).kind, 'invalid');
});

test('5c · estados finales sin letra: FAILED y CANCELED', () => {
  assert.deepEqual(interpretOperationSnapshot({ status: 'FAILED' }), { kind: 'failed', reason: 'failed' });
  assert.deepEqual(interpretOperationSnapshot({ status: 'CANCELED' }), { kind: 'failed', reason: 'canceled' });
});

test('5d · el polling es acotado y con espera creciente', () => {
  assert.equal(pollDelayMs(0), 2000);
  assert.ok(pollDelayMs(1) > pollDelayMs(0));
  assert.equal(pollDelayMs(100), 15000);
  assert.equal(shouldContinuePolling(0), true);
  assert.equal(shouldContinuePolling(POLL_MAX_ATTEMPTS), false);
});

/* ───────────────── 6 · reutilización idempotente ───────────────── */

test('6 · misma acción ⇒ misma clave y mismo operationId guardado; la repetición 200 trae la misma operación', () => {
  const storage = memoryStorage();
  const counter = makeCounter();
  const fp = fingerprintPayload(PAYLOAD);
  const { attempt } = resolveAttempt({ stored: null, userId: 'u1', fingerprint: fp, makeKey: counter.make });
  saveAttempt(storage, { ...attempt, operationId: 'op7' });

  const again = resolveAttempt({ stored: loadAttempt(storage, 'u1'), userId: 'u1', fingerprint: fp, makeKey: counter.make });
  assert.equal(again.reused, true);
  assert.equal(again.attempt.key, attempt.key);
  assert.equal(again.attempt.operationId, 'op7');
  assert.equal(counter.calls(), 1);

  const replay = classifyAssistantResponse(200, { lyrics: 'ya estaba', title: 'T', operation: { id: 'op7', status: 'COMPLETED', replayed: true } });
  assert.equal(replay.kind, 'completed');
  assert.equal(replay.operationId, 'op7');
});

/* ───────────────── 7 · 409 y 5xx ───────────────── */

test('7 · 409 se interpreta por el código de detalle real, no por el status', () => {
  assert.deepEqual(
    classifyAssistantError({ status: 409, code: 'CONFLICT', details: { code: 'ASSISTANT_OPERATION_FAILED', operationId: 'op3', status: 'FAILED' } }),
    { kind: 'failed', reason: 'operation-failed', operationId: 'op3' },
  );
  assert.equal(classifyAssistantError({ status: 409, code: 'CONFLICT', details: { code: 'ASSISTANT_OPERATION_NOT_ACTIVE', operationId: 'op3' } }).reason, 'not-active');
  // un 409 cualquiera, sin ese detalle, NO es terminal
  assert.deepEqual(classifyAssistantError({ status: 409, code: 'CONFLICT' }), { kind: 'unknown' });
  assert.deepEqual(classifyAssistantError({ status: 409, code: 'CONFLICT', details: { code: 'OTRA_COSA' } }), { kind: 'unknown' });
});

test('7b · 5xx y 4xx reenviados por el proveedor ⇒ unknown (no terminal) y NO piden una operación nueva', () => {
  for (const status of [500, 502, 503, 504, 400, 401, 403, 404, 408]) {
    assert.deepEqual(classifyAssistantError({ status, code: 'INTERNAL' }), { kind: 'unknown' }, String(status));
  }
  // un 429 que NO es el límite propio del backend (código distinto) tampoco es terminal
  assert.deepEqual(classifyAssistantError({ status: 429, code: 'INTERNAL' }), { kind: 'unknown' });
});

test('7c · errores que prueban que NO se creó la operación: fichas, límite propio, validación', () => {
  assert.equal(classifyAssistantError({ status: 402, code: 'INSUFFICIENT_CREDITS' }).kind, 'not-started');
  assert.equal(classifyAssistantError({ status: 429, code: 'RATE_LIMITED' }).kind, 'not-started');
  assert.equal(classifyAssistantError({ status: 422, code: 'VALIDATION_ERROR' }).kind, 'not-started');
  assert.equal(classifyAssistantError({ status: 422, code: 'UNPROCESSABLE', details: { code: 'IDEMPOTENCY_KEY_REUSED', operationId: 'x' } }).reason, 'key-conflict');
  assert.equal(classifyAssistantError({ status: 422, code: 'UNPROCESSABLE', details: { code: 'INVALID_IDEMPOTENCY_KEY' } }).reason, 'validation');
  assert.deepEqual(classifyAssistantError({ status: 422, code: 'UNPROCESSABLE', details: { code: 'LYRICS_EMPTY' } }), { kind: 'unknown' }); // LYRICS_EMPTY no prueba por si solo el estado final (el cierre pudo fallar)
});

/* ───────────────── 8 · cambio de payload ───────────────── */

test('8 · payload distinto ⇒ clave nueva (nunca se reutiliza una clave con otros parámetros)', () => {
  const counter = makeCounter();
  const stored = resolveAttempt({ stored: null, userId: 'u1', fingerprint: fingerprintPayload(PAYLOAD), makeKey: counter.make }).attempt;
  const changed = resolveAttempt({ stored, userId: 'u1', fingerprint: fingerprintPayload({ ...PAYLOAD, genre: 'milonga' }), makeKey: counter.make });
  assert.equal(changed.reused, false);
  assert.notEqual(changed.attempt.key, stored.key);
  assert.equal(changed.attempt.operationId, undefined, 'la operación vieja no se arrastra');
  // otro usuario con el mismo payload tampoco reutiliza
  const other = resolveAttempt({ stored, userId: 'u2', fingerprint: stored.fingerprint, makeKey: counter.make });
  assert.equal(other.reused, false);
});

test('8b · la huella ignora el orden de las claves y los undefined, pero distingue valores', () => {
  assert.equal(stableStringify({ b: 1, a: [2, { z: 1, y: undefined }] }), stableStringify({ a: [2, { z: 1 }], b: 1 }));
  assert.equal(fingerprintPayload({ a: 1, b: 2 }), fingerprintPayload({ b: 2, a: 1 }));
  assert.notEqual(fingerprintPayload({ a: 1 }), fingerprintPayload({ a: 2 }));
  assert.notEqual(fingerprintPayload({ idea: 'abc' }), fingerprintPayload({ idea: 'abd' }));
});

/* ───────────────── 9 · doble clic ───────────────── */

test('9 · doble clic o envío concurrente: solo el primero toma el candado hasta liberarlo', () => {
  const gate = createSubmitGate();
  let posts = 0;
  const click = () => { if (!gate.tryAcquire()) return false; posts += 1; return true; };
  assert.equal(click(), true);
  assert.equal(click(), false);
  assert.equal(click(), false);
  assert.equal(posts, 1);
  gate.release();
  assert.equal(click(), true);
  assert.equal(posts, 2);
});

/* ───────────────── 10 · recarga de la pestaña ───────────────── */

test('10 · tras recargar, un registro válido del MISMO usuario se recupera y solo guarda los campos mínimos', () => {
  const storage = memoryStorage();
  saveAttempt(storage, {
    v: 1, userId: 'u1', key: 'mly-clave-estable', fingerprint: 'fp1:abc:10', operationId: 'op5',
    // intentos de colar contenido que NO debe persistirse
    idea: 'MI IDEA SECRETA', lyrics: 'LETRA COMPLETA', token: 'Bearer xyz',
  });
  const raw = storage.raw.get(PENDING_STORAGE_KEY);
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['fingerprint', 'key', 'operationId', 'userId', 'v']);
  for (const secret of ['IDEA SECRETA', 'LETRA COMPLETA', 'Bearer']) assert.ok(!raw.includes(secret));

  // "recarga": nuevo componente, mismo storage
  const restored = loadAttempt(storage, 'u1');
  assert.deepEqual(restored, { v: 1, userId: 'u1', key: 'mly-clave-estable', fingerprint: 'fp1:abc:10', operationId: 'op5' });
});

test('10b · un registro de OTRO usuario, corrupto o inválido NO se usa y se elimina', () => {
  const storage = memoryStorage();
  saveAttempt(storage, { v: 1, userId: 'u1', key: 'mly-clave-estable', fingerprint: 'fp1:abc:10' });
  assert.equal(loadAttempt(storage, 'u2'), null);
  assert.equal(storage.raw.has(PENDING_STORAGE_KEY), false, 'se limpió el registro ajeno');

  storage.setItem(PENDING_STORAGE_KEY, '{no es json');
  assert.equal(loadAttempt(storage, 'u1'), null);
  assert.equal(storage.raw.has(PENDING_STORAGE_KEY), false);

  storage.setItem(PENDING_STORAGE_KEY, JSON.stringify({ v: 1, userId: 'u1', key: 'corta', fingerprint: 'x' }));
  assert.equal(loadAttempt(storage, 'u1'), null);

  assert.equal(loadAttempt(storage, null), null);
  assert.equal(loadAttempt(null, 'u1'), null);
});

test('10c · clearAttempt limpia el registro (resultado terminal o acción nueva) y tolera un storage ausente', () => {
  const storage = memoryStorage();
  saveAttempt(storage, { v: 1, userId: 'u1', key: 'mly-clave-estable', fingerprint: 'fp1:abc:10' });
  clearAttempt(storage);
  assert.equal(loadAttempt(storage, 'u1'), null);
  clearAttempt(null);
  saveAttempt(null, { v: 1, userId: 'u1', key: 'mly-clave-estable', fingerprint: 'x' });
});

test('10d · un storage que lanza errores (cuota/bloqueado) no rompe el flujo', () => {
  const broken = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); }, removeItem: () => { throw new Error('x'); } };
  assert.equal(loadAttempt(broken, 'u1'), null);
  assert.doesNotThrow(() => saveAttempt(broken, { v: 1, userId: 'u1', key: 'mly-clave-estable', fingerprint: 'x' }));
  assert.doesNotThrow(() => clearAttempt(broken));
});

/* 422 definitivos previos a la operación: solo por su código real (details.code), no por el 422 en general */
test('classifyAssistantError: PRICING_NOT_CONFIGURED y NO_LYRICS_PROVIDER son «not-started»; otros 422 no lo son', () => {
  assert.deepEqual(
    classifyAssistantError({ status: 422, code: 'UNPROCESSABLE', details: { code: 'PRICING_NOT_CONFIGURED' } }),
    { kind: 'not-started', reason: 'pricing-not-configured' },
  );
  assert.deepEqual(
    classifyAssistantError({ status: 422, code: 'UNPROCESSABLE', details: { code: 'NO_LYRICS_PROVIDER' } }),
    { kind: 'not-started', reason: 'no-lyrics-provider' },
  );
  for (const err of [
    { status: 422, code: 'UNPROCESSABLE' },
    { status: 422, code: 'UNPROCESSABLE', details: { code: 'LYRICS_EMPTY' } },
    { status: 500, code: 'INTERNAL', details: { code: 'PRICING_NOT_CONFIGURED' } },
    { status: 0, code: 'TIMEOUT' },
  ]) assert.deepEqual(classifyAssistantError(err), { kind: 'unknown' }, JSON.stringify(err));
});

test('classifyAssistantError: NO_LYRICS_PROVIDER con details.operationId es «operation-exists» (posterior a crear la operación); sin él, «not-started»', () => {
  assert.deepEqual(
    classifyAssistantError({ status: 422, code: 'UNPROCESSABLE', details: { code: 'NO_LYRICS_PROVIDER', operationId: 'op1' } }),
    { kind: 'operation-exists', reason: 'no-lyrics-provider', operationId: 'op1', closeUncertain: false },
  );
  assert.deepEqual(
    classifyAssistantError({ status: 422, code: 'UNPROCESSABLE', details: { code: 'NO_LYRICS_PROVIDER', operationId: 'op1', closeUncertain: true } }),
    { kind: 'operation-exists', reason: 'no-lyrics-provider', operationId: 'op1', closeUncertain: true },
  );
  assert.deepEqual(
    classifyAssistantError({ status: 422, code: 'UNPROCESSABLE', details: { code: 'NO_LYRICS_PROVIDER' } }),
    { kind: 'not-started', reason: 'no-lyrics-provider' },
  );
  // PRICING_NOT_CONFIGURED solo ocurre antes de crear la operación: no cambia
  assert.deepEqual(
    classifyAssistantError({ status: 422, code: 'UNPROCESSABLE', details: { code: 'PRICING_NOT_CONFIGURED', operationId: 'x' } }),
    { kind: 'not-started', reason: 'pricing-not-configured' },
  );
});

/* ───────────────── H3 · validación de «Mejorar» y mensajes de VALIDATION_ERROR ───────────────── */

test('Mejorar: 5000 caracteres se aceptan y 5001 no (medido como el backend: sin espacios en los extremos)', () => {
  assert.equal(ASSISTANT_EXISTING_LYRICS_MAX, 5000);
  assert.equal(improveLyricsTooLong('x'.repeat(5000)), false);
  assert.equal(improveLyricsTooLong('x'.repeat(5001)), true);
  assert.equal(improveLyricsTooLong(`  ${'x'.repeat(5000)}
`), false, 'zod recorta antes de medir el máximo');
});

test('un 422 del middleware de validación (code UNPROCESSABLE + details.code VALIDATION_ERROR) es un rechazo previo, no un estado desconocido', () => {
  const real = { status: 422, code: 'UNPROCESSABLE', details: { code: 'VALIDATION_ERROR', issues: [{ path: 'existingLyrics', message: 'x' }] } };
  assert.deepEqual(classifyAssistantError(real), { kind: 'not-started', reason: 'validation' });
});

test('validationIssuesMessage: une los motivos sin repetir; sin detalles utilizables devuelve undefined', () => {
  assert.equal(validationIssuesMessage({ issues: [{ path: 'a', message: 'Demasiado larga' }, { path: 'b', message: 'Demasiado larga' }, { message: 'Otra cosa' }] }), 'Demasiado larga Otra cosa');
  for (const d of [undefined, null, {}, { issues: [] }, { issues: [{ path: 'a' }, { message: '  ' }, 7] }, 'texto']) assert.equal(validationIssuesMessage(d), undefined);
});
