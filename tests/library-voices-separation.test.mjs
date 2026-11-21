// Biblioteca › Voces / Samples: qué se muestra en cada sección y cómo se quita una voz.
//  • Lógica pura (voice-session-flow.ts): se prueba el comportamiento.
//  • Pruebas ESTRUCTURALES sobre el código fuente de los componentes: el repo no tiene jsdom ni testing-library, así que NO montan
//    React; impiden reintroducir los defectos leyendo el código. El filtrado de verificaciones y de voces clonadas vive en el
//    BACKEND (test/unit/services/sample-library-separation.test.js de melodya.backend); acá solo se comprueba que el front lo pide.
// Ejecutar: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { sessionNeedsAction, uploadPhraseReading, resumePhase } from '../src/features/voice/voice-session-flow.ts';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const voices = read('src/features/library/VoicesTab.tsx');
const samples = read('src/features/library/SamplesTab.tsx');
const api = read('src/lib/api/index.ts');

/* ───────────── sesiones: solo las que piden una acción ───────────── */

test('sessionNeedsAction: en curso y FAILED sí; READY y estados desconocidos no', () => {
  for (const status of ['PHRASE_PENDING', 'PHRASE_READY', 'VERIFYING', 'VOICE_PENDING', 'FAILED']) assert.equal(sessionNeedsAction(status), true, status);
  for (const status of ['READY', '', 'algo-raro', null, undefined]) assert.equal(sessionNeedsAction(status), false, String(status));
});

test('toda sesión con acción es retomable (en curso) o FAILED (reintentar/descartar): ninguna queda sin salida', () => {
  for (const status of ['PHRASE_PENDING', 'PHRASE_READY', 'VERIFYING', 'VOICE_PENDING']) assert.notEqual(resumePhase(status), null, status);
});

test('una sesión READY no se muestra: el filtro de la lista y la tarjeta no tienen el bloque «¡Tu voz está lista!»', () => {
  assert.match(voices, /sessions\.filter\(\(s\) => sessionNeedsAction\(s\.status\)\)/);
  assert.match(voices, /actionableSessions\.map\(/);
  assert.doesNotMatch(voices, /sessions\.map\(/, 'la lista nunca se recorre sin filtrar');
  assert.doesNotMatch(voices, /¡Tu voz está lista!/);
  assert.doesNotMatch(voices, /voiceId: \{session\.voiceId\}/);
  assert.match(voices, /if \(status === 'READY'\) return null;/, 'hasta el refresco no se dibuja una tarjeta terminada');
});

test('la lógica de reanudar y reintentar se conserva: «Continuar clonación», «Volver a intentar» y descartar', () => {
  assert.match(voices, /Continuar clonación/);
  assert.match(voices, /Volver a intentar/);
  assert.match(voices, /Descartar esta clonación/);
  assert.match(voices, /nextCloneAction\(sessions, sample\.id\)/, 'la decisión de retomar usa TODAS las sesiones, no solo las visibles');
});

/* ───────────── Mis voces / Muestras sin clonar ───────────── */

test('«Mis voces»: sin Play, con Editar (modal de voz) y quitar la voz (no borra la grabación)', () => {
  const card = voices.slice(voices.indexOf('function VoiceCard('), voices.indexOf('/* ── Tarjeta de sesión'));
  assert.ok(card.length > 200, 'se encontró VoiceCard');
  assert.doesNotMatch(card, /SamplePlayButton/, 'las voces clonadas no ofrecen reproducción');
  assert.match(card, /Editar \$\{sample\.name\}/);
  assert.match(card, /Quitar la voz/);
  assert.match(voices, /onEdit=\{\(\) => setEditing\(sample\)\}/);
  assert.match(voices, /onDelete=\{\(\) => setToRemoveVoice\(sample\)\}/);
  assert.match(voices, /mutationFn: \(id: string\) => samplesApi\.removeVoice\(id\)/);
});

test('quitar una voz usa DELETE /samples/:id/voice y NO samples.remove; eliminar una grabación sin clonar sigue usando samples.remove', () => {
  assert.match(api, /removeVoice: \(id: string\) => deleteData<UserSample>\(`\/samples\/\$\{id\}\/voice`\)/);
  assert.match(voices, /mutationFn: \(id: string\) => samplesApi\.remove\(id\)/, 'eliminar una grabación sin clonar');
  const removeVoiceBlock = voices.slice(voices.indexOf('const removeVoiceMutation'), voices.indexOf('const openResume'));
  assert.doesNotMatch(removeVoiceBlock, /samplesApi\.remove\(/, 'quitar la voz nunca borra la grabación');
  assert.match(voices, /Tu grabación se conserva en «Muestras sin clonar»/);
  assert.match(voices, /Melodya no puede eliminar la voz del servicio de clonación/, 'no se promete un borrado remoto inexistente');
});

test('«Muestras sin clonar» conserva Play, Enviar a la Papelera y Clonar mi voz', () => {
  const pending = voices.slice(voices.indexOf('Muestras sin clonar'), voices.indexOf('Sesiones de clonación') > 0 ? voices.indexOf('Sesiones de clonación') : voices.indexOf('Clonación de voz'));
  assert.match(pending, /<SamplePlayButton/);
  // Eliminar vive en el menú de opciones de cada muestra (ya no hay un botón suelto con aria-label propio).
  assert.match(pending, /Opciones de \$\{sample\.name\}/);
  assert.match(pending, /setToDelete\(sample\)/);
  assert.match(pending, /Trash2[\s\S]*Enviar a la Papelera/);
  assert.match(pending, /Clonar mi voz/);
  assert.match(voices, /voiceSamples\.filter\(\(s\) => !s\.sunoPersonaId\)/);
  assert.match(voices, /voiceSamples\.filter\(\(s\) => s\.sunoPersonaId\)/);
});

/* ───────────── Samples ───────────── */

test('Samples lista también las grabaciones ya clonadas (sin filtro cloned), conserva su modal de edición y no usa el de voces', () => {
  assert.match(samples, /samplesApi\.list\(\{ kind: kind === 'ALL' \? undefined : kind, pageSize: 50 \}\)/);
  assert.doesNotMatch(samples, /cloned: false/, 'la grabación original de una voz clonada sigue siendo un sample');
  assert.match(samples, /Editar audio/); // «Samples» pasó a llamarse «Audios» en los textos visibles (diseño de Biblioteca)
  assert.doesNotMatch(samples, /EditVoiceDialog|Editar voz/);
  assert.match(voices, /Editar voz/);
  assert.doesNotMatch(voices, /Editar audio|Editar sample|EditSampleDialog/);
  assert.match(samples, /<SamplePlayButton/, 'Play de samples intacto');
  assert.match(samples, /samplesApi\.remove\(id\)/, 'se puede eliminar cualquier sample de esta sección');
});

test('el listado de la API acepta cloned y la subida acepta purpose', () => {
  assert.match(api, /cloned\?: boolean/);
  assert.match(api, /if \(meta\.purpose\) form\.append\('purpose', meta\.purpose\)/);
});

/* ───────────── la frase se sube marcada como verificación ───────────── */

test('la grabación de la frase se sube con purpose VOICE_VERIFICATION y con tipo VOICE', async () => {
  const seen = [];
  const deps = { readDuration: async () => null, createSample: async (f, meta) => { seen.push(meta); return { id: 'v1' }; } };
  const res = await uploadPhraseReading({ id: 's', status: 'PHRASE_READY', phrase: 'hola' }, { name: 'a.webm' }, 5, 'Frase de verificación · hoy', deps);
  assert.equal(res.status, 'uploaded');
  assert.deepEqual(seen[0], { type: 'VOICE', name: 'Frase de verificación · hoy', purpose: 'VOICE_VERIFICATION', durationSec: 5 });
});

test('la subida de la muestra ORIGINAL no lleva purpose (sigue siendo una muestra normal que se puede clonar)', () => {
  const dialog = read('src/features/voice/VoiceCloneDialog.tsx');
  const original = dialog.slice(dialog.indexOf('const submitSource'), dialog.indexOf('const submitPhraseReading'));
  assert.match(original, /samplesApi\.create\(file, \{/);
  assert.doesNotMatch(original, /purpose/);
});
