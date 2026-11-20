// Recuperación acotada tras un refresco fallido al completarse una generación (src/lib/generation-sync.ts).
// Usa el QueryClient REAL de TanStack Query (@tanstack/query-core) con el mismo criterio de reintentos que la app
// (un reintento, sin refetch al enfocar): lo que se prueba es el comportamiento de verdad, no un doble.
// Ejecutar: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryClient, QueryObserver } from '@tanstack/query-core';

import { applyGenerationCompleted, createCompletionGate, RECOVERY_DELAY_MS } from '../src/lib/generation-sync.ts';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => sleep(40); // pedido + su reintento (retryDelay 1 ms)

const music = { generationId: 'g1', songId: 's1', versionNumber: 1, versionIds: ['v1'] };
const cover = { generationId: 'g2', songId: 's1', coverFileId: 'f1' };

function world() {
  const qc = new QueryClient({
    defaultOptions: { queries: { staleTime: 20_000, refetchOnWindowFocus: false, retry: (n) => n < 1, retryDelay: 1 } },
  });
  const state = { version: 1, failing: new Set(), calls: {} };
  const unsubs = [];
  const scheduled = [];
  const schedule = (fn, ms) => scheduled.push({ fn, ms });
  const gate = createCompletionGate();
  const id = (key) => key.join('/');

  async function watch(key) {
    const observer = new QueryObserver(qc, {
      queryKey: key,
      queryFn: async () => {
        state.calls[id(key)] = (state.calls[id(key)] ?? 0) + 1;
        if (state.failing.has(id(key))) throw new Error('503');
        return { v: state.version };
      },
    });
    unsubs.push(observer.subscribe(() => {}));
    await settle();
  }
  const queryState = (key) => qc.getQueryCache().find({ queryKey: key }).state;
  const apply = (payload) => applyGenerationCompleted(qc, payload, { gate, schedule });
  const calls = (key) => state.calls[id(key)] ?? 0;
  const close = () => unsubs.forEach((u) => u());
  return { qc, state, scheduled, watch, queryState, apply, calls, close };
}

const MUSIC_KEYS = [['songs'], ['song', 's1'], ['generations'], ['projects'], ['lyrics']];

test('1. finalización normal: una actualización efectiva por consulta y ninguna recuperación programada', async () => {
  const w = world();
  for (const key of MUSIC_KEYS) await w.watch(key);
  w.state.version = 2;
  w.apply(music);
  await settle();
  for (const key of MUSIC_KEYS) {
    assert.equal(w.calls(key), 2, `${key.join('/')}: carga inicial + una actualización`);
    assert.equal(w.queryState(key).data.v, 2);
  }
  assert.equal(w.scheduled.length, 0);
  w.close();
});

test('2. socket y sondeo anuncian la misma finalización: no se duplica el trabajo', async () => {
  const w = world();
  for (const key of MUSIC_KEYS) await w.watch(key);
  w.state.version = 2;
  assert.equal(w.apply(music), true); // socket
  assert.equal(w.apply({ generationId: 'g1', songId: 's1' }), false); // sondeo de GenerationStatus
  assert.equal(w.apply({ generationId: 'g1', songId: 's1' }), false); // reconciliación
  await settle();
  for (const key of MUSIC_KEYS) assert.equal(w.calls(key), 2);
  assert.equal(w.scheduled.length, 0);
  w.close();
});

test('3. fallan el pedido y su reintento: se programa UNA recuperación (~5 s) y nada más', async () => {
  const w = world();
  for (const key of MUSIC_KEYS) await w.watch(key);
  w.state.version = 2;
  w.state.failing.add('songs');
  w.state.failing.add('song/s1');
  w.apply(music);
  await settle();
  assert.equal(w.queryState(['songs']).status, 'error');
  assert.equal(w.queryState(['songs']).data.v, 1, 'conserva el dato viejo');
  assert.equal(w.calls(['songs']), 1 + 2, 'inicial + pedido + reintento normal');
  assert.equal(w.scheduled.length, 1);
  assert.equal(w.scheduled[0].ms, RECOVERY_DELAY_MS);
  assert.equal(RECOVERY_DELAY_MS, 5_000);
  // otra señal de la misma generación (la compuerta la descarta) no programa una segunda recuperación
  assert.equal(w.apply(music), false);
  await settle();
  assert.equal(w.scheduled.length, 1);
  w.close();
});

test('4. la recuperación tiene éxito: la interfaz obtiene los datos actualizados y solo se piden las consultas que fallaron', async () => {
  const w = world();
  for (const key of MUSIC_KEYS) await w.watch(key);
  w.state.version = 2;
  w.state.failing.add('songs');
  w.state.failing.add('song/s1');
  w.apply(music);
  await settle();
  const callsBefore = Object.fromEntries(MUSIC_KEYS.map((k) => [k.join('/'), w.calls(k)]));

  w.state.failing.clear(); // el servidor vuelve
  w.scheduled[0].fn();
  await settle();

  assert.equal(w.queryState(['songs']).status, 'success');
  assert.equal(w.queryState(['songs']).data.v, 2);
  assert.equal(w.queryState(['song', 's1']).data.v, 2);
  for (const key of [['generations'], ['projects'], ['lyrics']]) {
    assert.equal(w.calls(key), callsBefore[key.join('/')], `${key.join('/')}: ya estaba bien, no se vuelve a pedir`);
  }
  assert.equal(w.scheduled.length, 1, 'no se programa otra');
  w.close();
});

test('5. si la recuperación también falla: termina ahí (sin bucle ni reintentos indefinidos)', async () => {
  const w = world();
  await w.watch(['songs']);
  w.state.version = 2;
  w.state.failing.add('songs');
  w.apply(music);
  await settle();
  assert.equal(w.scheduled.length, 1);
  const before = w.calls(['songs']); // inicial + pedido + reintento = 3

  w.scheduled[0].fn(); // la recuperación vuelve a fallar
  await settle();
  const afterRecovery = w.calls(['songs']);
  assert.equal(afterRecovery, before + 2, 'un pedido + su reintento normal, nada más');

  await sleep(200); // si hubiera un bucle o un reintento oculto, aparecerían más pedidos
  assert.equal(w.calls(['songs']), afterRecovery);
  assert.equal(w.scheduled.length, 1, 'no se programó otra recuperación');
  assert.equal(w.queryState(['songs']).status, 'error');
  w.close();
});

test('6. si la consulta ya se recuperó por otra vía, la recuperación pendiente no hace ningún pedido', async () => {
  const w = world();
  for (const key of MUSIC_KEYS) await w.watch(key);
  w.state.version = 2;
  w.state.failing.add('songs');
  w.apply(music);
  await settle();
  assert.equal(w.scheduled.length, 1);

  w.state.failing.clear();
  await w.qc.invalidateQueries({ queryKey: ['songs'] }); // otra vía: p. ej. otra generación, o renombrar una canción
  await settle();
  assert.equal(w.queryState(['songs']).status, 'success');
  const callsBefore = Object.fromEntries(MUSIC_KEYS.map((k) => [k.join('/'), w.calls(k)]));

  w.scheduled[0].fn();
  await settle();
  for (const key of MUSIC_KEYS) assert.equal(w.calls(key), callsBefore[key.join('/')], `${key.join('/')}: sin pedido innecesario`);
  w.close();
});

test('7a. la recuperación no toca consultas ajenas a la generación (otra canción, créditos, otros errores previos)', async () => {
  const w = world();
  for (const key of MUSIC_KEYS) await w.watch(key);
  // consultas que ya estaban en error por su cuenta y no pertenecen a esta generación
  w.state.failing.add('song/otra');
  w.state.failing.add('credits');
  await w.watch(['song', 'otra']);
  await w.watch(['credits']);
  const otherBefore = [w.calls(['song', 'otra']), w.calls(['credits'])];

  w.state.version = 2;
  w.state.failing.add('songs');
  w.apply(music);
  await settle();
  assert.equal(w.scheduled.length, 1);
  w.scheduled[0].fn();
  await settle();

  assert.deepEqual([w.calls(['song', 'otra']), w.calls(['credits'])], otherBefore, 'ni la otra canción ni los créditos se piden de nuevo');
  w.close();
});

test('7b. una portada no invalida ni recupera proyectos ni letras', async () => {
  const w = world();
  for (const key of MUSIC_KEYS) await w.watch(key);
  w.state.version = 2;
  w.state.failing.add('songs');
  w.state.failing.add('projects'); // en error, pero una portada no debe tocarla
  w.state.failing.add('lyrics');
  const before = { projects: w.calls(['projects']), lyrics: w.calls(['lyrics']) };

  w.apply(cover);
  await settle();
  assert.equal(w.scheduled.length, 1, 'por songs');
  w.state.failing.clear();
  w.scheduled[0].fn();
  await settle();

  assert.equal(w.calls(['projects']), before.projects);
  assert.equal(w.calls(['lyrics']), before.lyrics);
  assert.equal(w.queryState(['songs']).data.v, 2, 'songs sí se recupera');
  w.close();
});

test('consultas inactivas (otra pantalla): no hay pedido que pueda fallar, no se programa nada', async () => {
  const w = world();
  // se cargan y se sueltan: quedan en caché sin observadores
  await w.watch(['songs']);
  w.close();
  w.state.failing.add('songs');
  w.apply(music);
  await settle();
  assert.equal(w.scheduled.length, 0);
});

// ── Instantánea de consultas fallidas, compuerta y temporizador por defecto ──

test('8. una consulta anidada que se monta y falla DESPUÉS de la invalidación no entra en la recuperación', async () => {
  const w = world();
  await w.watch(['songs']);
  w.state.version = 2;
  w.state.failing.add('songs');
  w.apply(music);
  await settle();
  assert.equal(w.scheduled.length, 1);

  // el usuario abre los comentarios y fallan por su cuenta (p. ej. la red), bajo ['song', 's1']
  w.state.failing.add('song/s1/comments');
  await w.watch(['song', 's1', 'comments']);
  assert.equal(w.queryState(['song', 's1', 'comments']).status, 'error');
  const commentsBefore = w.calls(['song', 's1', 'comments']);

  w.state.failing.clear();
  w.scheduled[0].fn();
  await settle();
  assert.equal(w.queryState(['songs']).data.v, 2, 'la lista de la generación sí se recupera');
  assert.equal(w.calls(['song', 's1', 'comments']), commentsBefore, 'los comentarios (ajenos) no se vuelven a pedir');
  assert.equal(w.queryState(['song', 's1', 'comments']).status, 'error');
  w.close();
});

test('9. una consulta anidada que ya estaba en error y fue pedida por la invalidación SÍ se recupera (está en el alcance de la generación)', async () => {
  const w = world();
  w.state.failing.add('songs');
  w.state.failing.add('song/s1/comments');
  await w.watch(['songs']);
  await w.watch(['song', 's1', 'comments']);
  w.state.version = 2;
  w.apply(music);
  await settle();
  assert.equal(w.scheduled.length, 1);
  w.state.failing.clear();
  w.scheduled[0].fn();
  await settle();
  assert.equal(w.queryState(['songs']).status, 'success');
  assert.equal(w.queryState(['song', 's1', 'comments']).status, 'success');
  w.close();
});

test('10. con dos consultas fallidas, la que se recuperó por otra vía no se vuelve a pedir y la que sigue en error sí', async () => {
  const w = world();
  for (const key of MUSIC_KEYS) await w.watch(key);
  w.state.version = 2;
  w.state.failing.add('songs');
  w.state.failing.add('generations');
  w.apply(music);
  await settle();
  assert.equal(w.scheduled.length, 1);

  w.state.failing.delete('songs');
  await w.qc.invalidateQueries({ queryKey: ['songs'] }); // 'songs' se recupera por otra vía; 'generations' sigue fallando
  await settle();
  assert.equal(w.queryState(['songs']).status, 'success');
  const songsBefore = w.calls(['songs']);
  const generationsBefore = w.calls(['generations']);

  w.state.failing.clear();
  w.scheduled[0].fn();
  await settle();
  assert.equal(w.calls(['songs']), songsBefore, 'songs: sin pedido innecesario');
  assert.equal(w.calls(['generations']), generationsBefore + 1, 'generations: se vuelve a pedir una vez');
  assert.equal(w.queryState(['generations']).status, 'success');
  w.close();
});

test('11. compuerta compartida POR DEFECTO (sin inyectar una propia): la misma generación se deduplica entre los tres llamadores', () => {
  const invalidated = [];
  const qc = { invalidateQueries: (filters) => invalidated.push(filters.queryKey.join('/')) };
  // misma firma que usan el socket, GenerationStatus y la reconciliación: applyGenerationCompleted(qc, payload)
  const results = [
    applyGenerationCompleted(qc, { generationId: 'gen-compuerta-por-defecto', songId: 's1', versionNumber: 1, versionIds: ['v1'] }),
    applyGenerationCompleted(qc, { generationId: 'gen-compuerta-por-defecto', songId: 's1' }),
    applyGenerationCompleted(qc, { generationId: 'gen-compuerta-por-defecto', songId: 's1' }),
  ];
  assert.deepEqual(results, [true, false, false]);
  assert.equal(invalidated.length, 5, 'una sola tanda');
  // otra generación distinta no queda bloqueada por la anterior
  assert.equal(applyGenerationCompleted(qc, { generationId: 'otra-generacion', songId: 's2', versionNumber: 1 }), true);
});

test('12. el temporizador por defecto (sin inyectar schedule) usa setTimeout de 5 segundos y su recuperación funciona', async () => {
  const w = world();
  await w.watch(['songs']);
  w.state.version = 2;
  w.state.failing.add('songs');

  const realSetTimeout = globalThis.setTimeout;
  const captured = [];
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms === RECOVERY_DELAY_MS) {
      captured.push({ fn, ms }); // se captura sin esperar los 5 s reales
      return 0;
    }
    return realSetTimeout(fn, ms, ...args);
  };
  try {
    applyGenerationCompleted(w.qc, { generationId: 'gen-timer-por-defecto', songId: 's1', versionNumber: 1 }, { gate: createCompletionGate() });
    await settle();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(captured.length, 1, 'una sola recuperación programada');
  assert.equal(captured[0].ms, 5_000);

  w.state.failing.clear();
  captured[0].fn();
  await settle();
  assert.equal(w.queryState(['songs']).data.v, 2);
  w.close();
});
