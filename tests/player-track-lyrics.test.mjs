// Letra del reproductor (src/components/player/track-lyrics.ts): una muestra (kind:'sample') nunca consulta songsApi.get
// (GET /songs/:id daba 404 con el id de un sample); las canciones conservan su comportamiento (propia → /songs, pública → /community).
// Ejecutar: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchTrackLyrics, trackSupportsLyrics } from '../src/components/player/track-lyrics.ts';

function lookup(calls, { community = 'letra pública', song = 'letra propia' } = {}) {
  return {
    communityLyrics: async (id) => { calls.push(['community', id]); return community; },
    songLyrics: async (id) => { calls.push(['song', id]); return song; },
  };
}

test('sample: no hay ninguna petición y no hay letra', async () => {
  const calls = [];
  for (const isPublic of [false, true, undefined]) {
    assert.equal(await fetchTrackLyrics({ id: 'cmvo6n1ci01z9n70jt5r43t93', kind: 'sample', isPublic }, lookup(calls)), null);
  }
  assert.deepEqual(calls, []);
  assert.equal(trackSupportsLyrics({ kind: 'sample' }), false);
});

test('canciones (kind ausente o "song"): mismo comportamiento de siempre', async () => {
  const calls = [];
  assert.equal(await fetchTrackLyrics({ id: 'a', isPublic: false }, lookup(calls)), 'letra propia');
  assert.equal(await fetchTrackLyrics({ id: 'b', kind: 'song', isPublic: true }, lookup(calls)), 'letra pública');
  assert.equal(await fetchTrackLyrics({ id: 'c' }, lookup(calls)), 'letra propia'); // visibilidad desconocida = ruta propia, como antes
  assert.deepEqual(calls, [['song', 'a'], ['community', 'b'], ['song', 'c']]);
  assert.equal(trackSupportsLyrics({}), true);
  assert.equal(trackSupportsLyrics(null), true);
});

test('canción instrumental sin letra: devuelve null tras consultar (el reproductor oculta la card)', async () => {
  const calls = [];
  assert.equal(await fetchTrackLyrics({ id: 'd', isPublic: false }, lookup(calls, { song: null })), null);
  assert.equal(calls.length, 1);
});
