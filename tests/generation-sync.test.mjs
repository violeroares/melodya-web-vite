// Sincronización de generaciones con la caché (src/lib/generation-sync.ts): módulo puro, sin DOM ni React Query.
// Ejecutar: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  completionQueryKeys,
  isCoverCompletion,
  createCompletionGate,
  activeGenerationSignature,
  activeGenerationIds,
  settledSince,
  applyGenerationCompleted,
} from '../src/lib/generation-sync.ts';

const music = { generationId: 'g1', songId: 's1', versionId: 'v1', versionNumber: 2, versionIds: ['v1'] };
const cover = { generationId: 'g2', songId: 's1', versionId: 'v1', coverFileId: 'f1' };

test('música completada: canción puntual + listados + proyectos y letras', () => {
  assert.deepEqual(completionQueryKeys(music), [['songs'], ['song', 's1'], ['generations'], ['projects'], ['lyrics']]);
});

test('portada completada: no toca proyectos ni letras', () => {
  assert.equal(isCoverCompletion(cover), true);
  assert.equal(isCoverCompletion(music), false);
  assert.deepEqual(completionQueryKeys(cover), [['songs'], ['song', 's1'], ['generations']]);
});

test('no invalida el prefijo amplio ["song"] cuando se conoce la canción (no refresca otras tarjetas)', () => {
  const keys = completionQueryKeys(music);
  assert.ok(!keys.some((k) => k.length === 1 && k[0] === 'song'));
});

test('sin songId se conserva el prefijo amplio (no se queda nada viejo)', () => {
  assert.deepEqual(completionQueryKeys({ generationId: 'g3', songId: null, versionNumber: 1 })[1], ['song']);
});

test('una completada sin coverFileId ni versión (payload mínimo del sondeo) se trata como música', () => {
  assert.equal(isCoverCompletion({ generationId: 'g4', songId: 's2' }), false);
});

test('compuerta: solo la primera señal de cada generación pasa; las demás son duplicados', () => {
  const gate = createCompletionGate();
  assert.equal(gate.firstTime('a'), true);
  assert.equal(gate.firstTime('a'), false);
  assert.equal(gate.firstTime('b'), true);
});

test('compuerta: acotada (olvida las más viejas, sin crecer sin límite)', () => {
  const gate = createCompletionGate(3);
  for (const id of ['a', 'b', 'c', 'd']) gate.firstTime(id);
  assert.equal(gate.firstTime('a'), true, 'a ya fue olvidada');
  assert.equal(gate.firstTime('d'), false);
});

const gen = (id, status, jobs = []) => ({ id, status, jobs });

test('huella: vacía sin generaciones en curso; ignora terminadas', () => {
  assert.equal(activeGenerationSignature([]), '');
  assert.equal(activeGenerationSignature([gen('a', 'COMPLETED'), gen('b', 'FAILED')]), '');
});

test('huella: igual con el mismo estado (aunque cambie el orden) → no hay nada nuevo que invalidar', () => {
  const x = [gen('a', 'PROCESSING', [{ task: 'MUSIC', status: 'PROCESSING' }]), gen('b', 'PENDING')];
  assert.equal(activeGenerationSignature(x), activeGenerationSignature([...x].reverse()));
});

test('huella: cambia al terminar una, al pasar de fase (LYRICS → MUSIC) y al aparecer una nueva', () => {
  const lyrics = [gen('a', 'PROCESSING', [{ task: 'LYRICS', status: 'PROCESSING' }, { task: 'MUSIC', status: 'PENDING' }])];
  const music = [gen('a', 'PROCESSING', [{ task: 'LYRICS', status: 'COMPLETED' }, { task: 'MUSIC', status: 'PROCESSING' }])];
  assert.notEqual(activeGenerationSignature(lyrics), activeGenerationSignature(music));
  assert.notEqual(activeGenerationSignature(music), activeGenerationSignature([]));
  assert.notEqual(activeGenerationSignature(music), activeGenerationSignature([...music, gen('z', 'PENDING')]));
});

test('huella: tolera jobs ausentes (el listado puede no traerlos)', () => {
  assert.equal(activeGenerationSignature([{ id: 'a', status: 'PENDING' }]), 'a:PENDING:');
});

// ── Escenarios de extremo a extremo de la lógica (QueryClient simulado: solo registra qué se invalida) ──

function fakeClient() {
  const calls = [];
  return { calls, invalidateQueries: (filters) => calls.push(filters.queryKey.join('/')) };
}

test('escenario 1: música que termina → canciones, esa canción, generaciones, proyectos y letras (una vez)', () => {
  const qc = fakeClient();
  const gate = createCompletionGate();
  assert.equal(applyGenerationCompleted(qc, music, { gate }), true);
  assert.deepEqual(qc.calls, ['songs', 'song/s1', 'generations', 'projects', 'lyrics']);
});

test('escenario 2: portada que termina → no invalida proyectos ni letras', () => {
  const qc = fakeClient();
  applyGenerationCompleted(qc, cover, { gate: createCompletionGate() });
  assert.deepEqual(qc.calls, ['songs', 'song/s1', 'generations']);
});

test('escenario 4: socket y sondeo anuncian la MISMA finalización → una sola tanda, sin importar el orden', () => {
  for (const order of [['socket', 'poll'], ['poll', 'socket']]) {
    const qc = fakeClient();
    const gate = createCompletionGate();
    const signals = { socket: music, poll: { generationId: 'g1', songId: 's1' } };
    const results = order.map((who) => applyGenerationCompleted(qc, signals[who], { gate }));
    assert.deepEqual(results, [true, false], order.join('→'));
    assert.equal(qc.calls.length, 5, 'una sola tanda de invalidaciones');
  }
});

test('escenarios 3 y 8: dos generaciones distintas y cercanas NO se confunden: cada una invalida (la compuerta es por generationId)', () => {
  const qc = fakeClient();
  const gate = createCompletionGate();
  assert.equal(applyGenerationCompleted(qc, { generationId: 'gA', songId: 'sA', versionNumber: 1 }, { gate }), true);
  assert.equal(applyGenerationCompleted(qc, { generationId: 'gB', songId: 'sB', versionNumber: 1 }, { gate }), true);
  assert.deepEqual(qc.calls.filter((k) => k.startsWith('song/')), ['song/sA', 'song/sB']);
  // la misma canción con dos generaciones (música y luego portada) tampoco se confunden
  assert.equal(applyGenerationCompleted(qc, { generationId: 'gC', songId: 'sA', coverFileId: 'f' }, { gate }), true);
  assert.equal(applyGenerationCompleted(qc, { generationId: 'gA', songId: 'sA', versionNumber: 1 }, { gate }), false, 'solo la repetición de gA se descarta');
});

test('no se usa cancelRefetch: false (un segundo evento legítimo debe poder reiniciar un pedido en vuelo)', () => {
  const seen = [];
  const qc = { invalidateQueries: (...args) => seen.push(args) };
  applyGenerationCompleted(qc, music, { gate: createCompletionGate() });
  assert.ok(seen.every((args) => args.length === 1), 'invalidateQueries se llama solo con los filtros (cancelRefetch por defecto)');
});

const item = (id, status, songId = 's1') => ({ id, status, songId, jobs: [] });

test('escenarios 5 y 6: terminó mientras la pestaña estaba oculta (sin evento) → la reconciliación la detecta y refresca como completada', () => {
  const before = [item('g1', 'PROCESSING')];
  const afterHidden = [item('g1', 'COMPLETED', 's9')];
  const settled = settledSince(activeGenerationIds(before), afterHidden);
  assert.deepEqual(settled.completed, [{ generationId: 'g1', songId: 's9' }]);
  const qc = fakeClient();
  for (const done of settled.completed) applyGenerationCompleted(qc, done, { gate: createCompletionGate() });
  assert.ok(qc.calls.includes('song/s9') && qc.calls.includes('projects'));
});

test('escenario 6 con el socket vivo: el evento ya refrescó → la reconciliación posterior no repite', () => {
  const qc = fakeClient();
  const gate = createCompletionGate();
  applyGenerationCompleted(qc, { ...music, generationId: 'g1' }, { gate });
  const n = qc.calls.length;
  const settled = settledSince(new Set(['g1']), [item('g1', 'COMPLETED')]);
  for (const done of settled.completed) applyGenerationCompleted(qc, done, { gate });
  assert.equal(qc.calls.length, n);
});

test('escenario 7: falla o cancelación detectadas por reconciliación → se avisan (créditos); no cuentan como completadas', () => {
  const settled = settledSince(new Set(['a', 'b', 'c']), [item('a', 'FAILED'), item('b', 'CANCELED'), item('c', 'PROCESSING')]);
  assert.deepEqual(settled.unsuccessful, ['a', 'b']);
  assert.deepEqual(settled.completed, []);
});

test('reconciliación: una generación que no estaba en curso en el ciclo anterior no dispara nada; las ausentes de la página no se asumen terminadas', () => {
  assert.deepEqual(settledSince(new Set(), [item('x', 'COMPLETED')]), { completed: [], unsuccessful: [] });
  assert.deepEqual(settledSince(new Set(['gone']), [item('other', 'COMPLETED')]), { completed: [], unsuccessful: [] });
});

test('escenario 7: cambio de estado (PENDING → PROCESSING) cambia la huella → la reconciliación invalida el listado', () => {
  assert.notEqual(activeGenerationSignature([item('g', 'PENDING')]), activeGenerationSignature([item('g', 'PROCESSING')]));
});
