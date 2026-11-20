// Recuperación de generaciones fallidas (E4): estado local aislado por cuenta, una sola recuperación activa, descartar no borra nada.
// Ejecutar: node --test "tests/*.test.mjs"
import './_helpers/register-ts-resolve.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

const S = await import('../src/lib/recovery-store.ts');
const A = await import('../src/lib/retry-availability.ts');
const { readRecovery, startSession, updateSession, endSession, markHandled, recoveryKey, MAX_HANDLED } = S;

function memStorage() {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}

test('sin registro: vacío, sin sesión activa', () => {
  const rec = readRecovery(memStorage(), 'u1');
  assert.equal(rec.active, null);
  assert.deepEqual(rec.handled, {});
});

test('empezar una recuperación: queda activa, pendiente de aplicar y la generación figura como recuperada', () => {
  const st = memStorage();
  const rec = startSession(st, 'u1', 'g1');
  assert.equal(rec.active.generationId, 'g1');
  assert.equal(rec.active.needsApply, true);
  assert.equal(rec.active.destination, null, 'el destino no se elige solo');
  assert.equal(rec.active.heldDecision, null, 'la letra retenida no se decide sola');
  assert.equal(rec.handled.g1.state, 'RECOVERED');
  assert.equal(readRecovery(st, 'u1').active.generationId, 'g1', 'sobrevive a recargar');
});

test('una sola recuperación activa: empezar otra reemplaza la anterior', () => {
  const st = memStorage();
  startSession(st, 'u1', 'g1');
  const rec = startSession(st, 'u1', 'g2');
  assert.equal(rec.active.generationId, 'g2');
});

test('las decisiones del usuario se guardan en la sesión activa', () => {
  const st = memStorage();
  startSession(st, 'u1', 'g1');
  updateSession(st, 'u1', { needsApply: false, destination: 'NEW_SONG', heldDecision: 'DROP', regenerateLyrics: true });
  const a = readRecovery(st, 'u1').active;
  assert.equal(a.needsApply, false);
  assert.equal(a.destination, 'NEW_SONG');
  assert.equal(a.heldDecision, 'DROP');
  assert.equal(a.regenerateLyrics, true);
});

test('actualizar sin sesión activa no inventa una', () => {
  const st = memStorage();
  assert.equal(updateSession(st, 'u1', { destination: 'SAME' }).active, null);
});

test('terminar la recuperación deja constancia del desenlace y libera el espacio', () => {
  const st = memStorage();
  startSession(st, 'u1', 'g1');
  const rec = endSession(st, 'u1', 'SENT');
  assert.equal(rec.active, null);
  assert.equal(rec.handled.g1.state, 'SENT');
});

test('descartar el aviso solo lo marca localmente (no hay llamada alguna al servidor desde este módulo)', () => {
  const st = memStorage();
  const rec = markHandled(st, 'u1', 'g9', 'DISMISSED');
  assert.equal(rec.handled.g9.state, 'DISMISSED');
  assert.equal(rec.active, null);
});

test('aislamiento por cuenta: otra cuenta no ve la recuperación ni lo atendido', () => {
  const st = memStorage();
  startSession(st, 'u1', 'g1');
  markHandled(st, 'u1', 'g2', 'DISMISSED');
  const other = readRecovery(st, 'u2');
  assert.equal(other.active, null);
  assert.deepEqual(other.handled, {});
  assert.notEqual(recoveryKey('u1'), recoveryKey('u2'));
});

test('un registro de otra cuenta guardado bajo la clave propia se ignora', () => {
  const st = memStorage();
  startSession(st, 'u1', 'g1');
  st.setItem(recoveryKey('u2'), st.getItem(recoveryKey('u1')));
  assert.equal(readRecovery(st, 'u2').active, null);
});

test('registro corrupto o de otro formato: vacío, sin romper', () => {
  const st = memStorage();
  st.setItem(recoveryKey('u1'), '{no es json');
  assert.equal(readRecovery(st, 'u1').active, null);
  st.setItem(recoveryKey('u1'), JSON.stringify({ v: 99, userId: 'u1', handled: {}, active: null }));
  assert.equal(readRecovery(st, 'u1').active, null);
});

test('sin usuario no hay registro', () => {
  assert.equal(readRecovery(memStorage(), null).active, null);
});

test('sin almacenamiento: no lanza', () => {
  assert.doesNotThrow(() => startSession(null, 'u1', 'g1'));
  const broken = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); }, removeItem: () => {} };
  assert.doesNotThrow(() => markHandled(broken, 'u1', 'g1', 'DISMISSED'));
});

test('lo atendido tiene tope: se olvidan las más viejas', () => {
  const st = memStorage();
  for (let i = 0; i < MAX_HANDLED + 5; i += 1) markHandled(st, 'u1', `g${i}`, 'DISMISSED', new Date(2026, 0, 1, 0, 0, i));
  const rec = readRecovery(st, 'u1');
  assert.equal(Object.keys(rec.handled).length, MAX_HANDLED);
  assert.ok(rec.handled[`g${MAX_HANDLED + 4}`], 'la más nueva se conserva');
  assert.ok(!rec.handled.g0, 'la más vieja se olvida');
});

test('cerrar sesión no borra la recuperación (no hay función que lo haga)', () => {
  assert.equal(typeof S.clearRecovery, 'undefined');
});

test('disponibilidad del reintento: se descubre una vez, se recuerda y avisa a quien escucha', () => {
  A.resetRetryAvailability();
  assert.equal(A.isRetryAvailable(), true);
  let calls = 0;
  const off = A.subscribeRetryAvailability(() => { calls += 1; });
  A.markRetryDisabled();
  A.markRetryDisabled();
  assert.equal(A.isRetryAvailable(), false);
  assert.equal(calls, 1, 'avisa una sola vez');
  off();
  A.resetRetryAvailability();
});

test('desvincular: se guarda en la sesión, no la cierra y los registros viejos (sin el campo) quedan vinculados', () => {
  const st = memStorage();
  const started = startSession(st, 'u1', 'g1');
  assert.equal(started.active.detached, false);
  updateSession(st, 'u1', { detached: true });
  assert.equal(readRecovery(st, 'u1').active.detached, true);
  updateSession(st, 'u1', { detached: false });
  assert.equal(readRecovery(st, 'u1').active.detached, false);
  const raw = JSON.parse(st.getItem(recoveryKey('u1')));
  delete raw.active.detached;
  st.setItem(recoveryKey('u1'), JSON.stringify(raw));
  assert.equal(readRecovery(st, 'u1').active.detached, false);
});
