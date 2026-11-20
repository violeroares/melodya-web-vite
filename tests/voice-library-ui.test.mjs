// Biblioteca de voces: botón Play/Pausa y diálogo «Editar voz».
//  • Lógica pura (src/features/library/sample-playback.ts): se prueba el comportamiento.
//  • Pruebas ESTRUCTURALES sobre el código fuente de los componentes: el repo no tiene jsdom ni testing-library, así que NO
//    montan React; solo impiden que se reintroduzca el defecto (un icono fijo / cerrar el diálogo al subir la foto).
//    El comportamiento en pantalla se verificó aparte, a mano, en el navegador.
// Ejecutar: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { isTrackPlaying, playButtonView } from '../src/features/library/sample-playback.ts';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/* ───────────── Play / Pausa ───────────── */

test('isTrackPlaying: solo es true si ESA pista es la actual y está sonando', () => {
  assert.equal(isTrackPlaying({ track: { id: 'a' }, isPlaying: true }, 'a'), true);
  assert.equal(isTrackPlaying({ track: { id: 'a' }, isPlaying: false }, 'a'), false, 'cargada pero en pausa');
  assert.equal(isTrackPlaying({ track: { id: 'b' }, isPlaying: true }, 'a'), false, 'suena otra pista: la anterior vuelve a Play');
  assert.equal(isTrackPlaying({ track: null, isPlaying: true }, 'a'), false);
});

test('playButtonView: icono y etiqueta accesible siempre coinciden', () => {
  assert.deepEqual(playButtonView(false, 'Mi voz'), { icon: 'play', label: 'Reproducir Mi voz' });
  assert.deepEqual(playButtonView(true, 'Mi voz'), { icon: 'pause', label: 'Pausar Mi voz' });
});

test('estructura: las tarjetas de Voces y Samples usan el botón compartido (estado real del reproductor), no un icono fijo', () => {
  for (const file of ['src/features/library/VoicesTab.tsx', 'src/features/library/SamplesTab.tsx']) {
    const src = read(file);
    assert.match(src, /<SamplePlayButton\b/, file);
    assert.doesNotMatch(src, /usePlayerStore\.getState\(\)\.play\(/, `${file}: no debe armar su propio botón de Play`);
    assert.doesNotMatch(src, /<Play\b/, `${file}: el icono lo decide SamplePlayButton`);
  }
  const voices = read('src/features/library/VoicesTab.tsx');
  assert.equal((voices.match(/<SamplePlayButton\b/g) || []).length, 1, 'solo «Muestras sin clonar»: las voces clonadas no tienen Play');
  const shared = read('src/features/library/library-utils.tsx');
  assert.match(shared, /isTrackPlaying\(s, id\)/, 'el estado sale del store compartido');
  assert.match(shared, /view\.icon === 'pause'/, 'alterna Pause/Play');
  assert.match(shared, /aria-label=\{view\.label\}/, 'la etiqueta sale de la misma vista que el icono');
});

/* ───────────── Editar voz: subir la foto ───────────── */

test('estructura: subir la foto NO cierra el diálogo ni descarta lo escrito', () => {
  const src = read('src/features/library/VoicesTab.tsx');
  const start = src.indexOf('const uploadAvatar = async');
  assert.ok(start > 0, 'existe uploadAvatar');
  const body = src.slice(start, src.indexOf('\n  };', start));
  assert.match(body, /samplesApi\.setAvatar\(/, 'la foto se sigue subiendo igual');
  assert.doesNotMatch(body, /onClose\(\)/, 'subir la foto no debe cerrar el diálogo');
  assert.match(body, /setError\(toUserMessage\(err\)\)/, 'los errores se siguen mostrando');
  assert.match(body, /setNewAvatarUrl\(/, 'la foto nueva se ve en el propio diálogo');
  // Guardar sigue siendo la única acción que cierra
  const save = src.slice(src.indexOf('const save = async'), src.indexOf('const uploadAvatar = async'));
  assert.match(save, /onClose\(\)/);
});
