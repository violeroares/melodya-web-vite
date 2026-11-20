// Voces clonadas temporales (Suno Voice): caducidad, aviso y recreación. Ejecutar: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const {
  VOICE_EXPIRED, VOICE_EXPIRED_TEXT, VOICE_EXPIRED_TITLE, VOICE_AVAILABILITY_STALE_MS,
  isVoiceExpiredFailure, voiceExpiredSample, availabilityState, voiceSampleIdOf,
  voiceCardStatus, createConcurrencyLimiter, VOICE_AVAILABILITY_MAX_CONCURRENT,
}= await import('../src/features/voice/voice-expiry.ts');
const { generationFailureMessage, GENERIC_FAILURE_MESSAGE } = await import('../src/lib/generation-failure.ts');

const read = (rel) => fs.readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8');

/* ───────────── el fallo de una generación ───────────── */

test('VOICE_EXPIRED se reconoce solo por reasonCode, nunca por el texto ni por SENSITIVE_CONTENT', () => {
  assert.equal(isVoiceExpiredFailure({ reasonCode: 'VOICE_EXPIRED' }), true);
  for (const e of [{ reasonCode: 'SENSITIVE_CONTENT' }, { reasonCode: 'UNKNOWN' }, { message: 'The voice has expired' }, {}, null, undefined]) {
    assert.equal(isVoiceExpiredFailure(e), false);
  }
});

test('el mensaje que ve el usuario es el userMessage del backend (voz caducada) y no habla de contenido ni de la letra', () => {
  const userMessage = 'Tu voz clonada caducó y hay que volver a crearla.';
  assert.equal(generationFailureMessage({ reasonCode: 'VOICE_EXPIRED', userMessage }), userMessage);
  assert.doesNotMatch(`${VOICE_EXPIRED_TITLE} ${VOICE_EXPIRED_TEXT}`, /contenido|letra|términos|modific/i);
  assert.match(VOICE_EXPIRED_TEXT, /Recreala/);
  // respuesta antigua sin userMessage: mensaje general, nunca el texto crudo del proveedor
  assert.equal(generationFailureMessage({ code: 'GENERATION_FAILED', message: 'The voice has expired. Please recreate the voice' }), GENERIC_FAILURE_MESSAGE);
});

/* ───────────── rechazo previo a cobrar (422 VOICE_EXPIRED) ───────────── */

test('voiceExpiredSample: reconoce el 422 VOICE_EXPIRED y devuelve la muestra; cualquier otro error es undefined', () => {
  assert.equal(voiceExpiredSample({ status: 422, details: { code: VOICE_EXPIRED, sampleId: 'smp1' } }), 'smp1');
  assert.equal(voiceExpiredSample({ status: 422, details: { code: VOICE_EXPIRED } }), null, 'sin muestra informada');
  for (const err of [
    { status: 422, details: { code: 'INCOMPATIBLE_PREFERENCE' } },
    { status: 422, details: { code: 'VOICE_NOT_READY' } },
    { status: 402, details: {} },
    { status: 500 }, new Error('x'), null, undefined, 'texto', 42,
  ]) {
    assert.equal(voiceExpiredSample(err), undefined);
  }
});

/* ───────────── disponibilidad al elegir la voz ───────────── */

test('availabilityState: solo available:false es «caducada»; null o ausente es «desconocida», nunca caducada', () => {
  assert.equal(availabilityState({ available: false }), 'expired');
  assert.equal(availabilityState({ available: true }), 'available');
  for (const r of [{ available: null }, {}, null, undefined]) assert.equal(availabilityState(r), 'unknown');
});

test('la interfaz no consulta más seguido que la caché del backend (2 minutos)', () => {
  assert.equal(VOICE_AVAILABILITY_STALE_MS, 2 * 60 * 1000);
});

test('voiceSampleIdOf toma la muestra del input VOICE_SAMPLE de la generación', () => {
  assert.equal(voiceSampleIdOf({ inputs: [{ field: 'LYRICS' }, { field: 'VOICE_SAMPLE', sampleId: 'smp9' }] }), 'smp9');
  assert.equal(voiceSampleIdOf({ inputs: [{ field: 'VOICE_SAMPLE', sampleId: null }] }), null);
  assert.equal(voiceSampleIdOf({}), null);
  assert.equal(voiceSampleIdOf(null), null);
});

/* ───────────── cableado de la interfaz (se lee el código fuente, como el resto de estas pruebas) ───────────── */

test('API: availability y recreate; recreate solo viaja cuando se pide', () => {
  const api = read('lib/api/index.ts');
  assert.match(api, /voiceAvailability: \(id: string\) => getData<VoiceAvailability>\(`\/samples\/\$\{id\}\/voice-availability`\)/);
  assert.match(api, /create: \(sampleId: string, opts\?: \{ recreate\?: boolean \}\)/);
  assert.match(api, /\{ sampleId, \.\.\.\(opts\?\.recreate \? \{ recreate: true \} : \{\}\) \}/);
});

/* ───────────── tarjeta de «Mis voces»: estado real de cada voz ───────────── */

test('voiceCardStatus: «Lista» y «Caducada» solo con confirmación explícita; verificando y sin verificar nunca las simulan', () => {
  assert.equal(voiceCardStatus({ data: { available: true } }), 'available');
  assert.equal(voiceCardStatus({ data: { available: false } }), 'expired');
  // mientras se consulta (sin dato ni error): ni «Lista» ni «Caducada»
  assert.equal(voiceCardStatus({}), 'checking');
  assert.equal(voiceCardStatus({ data: undefined, isError: false }), 'checking');
  // null (red, timeout, NO_VOICE_SESSION…), dato vacío o error: sin verificar
  assert.equal(voiceCardStatus({ data: { available: null } }), 'unverified');
  assert.equal(voiceCardStatus({ data: {} }), 'unverified');
  assert.equal(voiceCardStatus({ isError: true }), 'unverified');
  for (const q of [{}, { isError: true }, { data: { available: null } }]) {
    assert.notEqual(voiceCardStatus(q), 'available');
    assert.notEqual(voiceCardStatus(q), 'expired');
  }
});

test('createConcurrencyLimiter: nunca más de N tareas a la vez y todas terminan en orden de llegada', async () => {
  const limit = createConcurrencyLimiter(VOICE_AVAILABILITY_MAX_CONCURRENT);
  assert.equal(VOICE_AVAILABILITY_MAX_CONCURRENT, 5);
  let active = 0; let peak = 0; const started = [];
  const task = (i) => limit(async () => {
    active++; peak = Math.max(peak, active); started.push(i);
    await new Promise((r) => setTimeout(r, 5));
    active--; return i;
  });
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => task(i)));
  assert.equal(peak, 5);
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual(started, results, 'orden de llegada');
  // un fallo no bloquea la cola
  await assert.rejects(limit(async () => { throw new Error('x'); }), /x/);
  assert.equal(await limit(async () => 'ok'), 'ok');
});

test('la tarjeta consulta la disponibilidad de su voz y la muestra con los cuatro estados (sin «Lista» fija)', () => {
  const tab = read('features/library/VoicesTab.tsx');
  const card = tab.slice(tab.indexOf('function VoiceCard('), tab.indexOf('/* ── Edición de detalles'));
  assert.match(card, /useVoiceAvailability\(sample\.id\)/, 'una consulta por voz, con la caché compartida');
  assert.match(card, /voiceCardStatus\(\{ data: availability\.data, isError: availability\.isError \}\)/);
  assert.doesNotMatch(card, /> Lista\s*<\/span>|Lista\n/, '«Lista» ya no está escrito fijo en la tarjeta');
  const table = tab.slice(tab.indexOf('const CARD_STATUS'), tab.indexOf('function VoiceCard('));
  assert.match(table, /checking: \{ chip: 'Verificando…'/);
  assert.match(table, /available: \{ chip: 'Lista', text: 'Disponible al crear canciones'/);
  assert.match(table, /expired: \{ chip: 'Caducada', text: 'Recreala con tu grabación original'/);
  assert.match(table, /unverified: \{ chip: 'Sin verificar', text: 'No pudimos comprobar la disponibilidad de esta voz\. Podés volver a intentarlo más tarde'/);
  // «Lista» y su texto solo existen en la rama `available`
  const cardArea = tab.slice(tab.indexOf('const CARD_STATUS'), tab.indexOf('/* ── Edición de detalles'));
  assert.equal((cardArea.match(/'Lista'/g) ?? []).length, 1);
  assert.equal((cardArea.match(/Disponible al crear canciones/g) ?? []).length, 1);
  // accesibilidad y acción de recrear
  assert.match(card, /role="status" aria-live="polite"/);
  assert.match(card, /variant=\{expired \? 'default' : 'ghost'\}/, 'recrear se destaca solo si caducó');
  assert.match(card, /aria-label=\{`Recrear la voz \$\{sample\.name\}`\}/, 'recrear sigue disponible en todos los estados');
});

test('la consulta por tarjeta no se duplica ni reintenta: una clave por voz, 2 min, sin reintentos ni refetch al enfocar, con tope de 5', () => {
  const hook = read('features/voice/VoiceAvailabilityNotice.tsx');
  assert.match(hook, /queryKey: \['voice-availability', sampleId\]/);
  assert.match(hook, /staleTime: VOICE_AVAILABILITY_STALE_MS/);
  assert.match(hook, /retry: false/);
  assert.match(hook, /refetchOnWindowFocus: false/);
  assert.match(hook, /limitAvailabilityChecks\(\(\) => samplesApi\.voiceAvailability\(sampleId as string\)\)/);
  // la vista lista/cuadrícula no cambia la clave (se reutiliza el resultado al remontar la tarjeta)
  assert.doesNotMatch(read('features/library/VoicesTab.tsx').slice(read('features/library/VoicesTab.tsx').indexOf('function VoiceCard(')), /useVoiceAvailability\([^)]*(list|view)/);
});

test('la disponibilidad se consulta al elegir la voz y en las tarjetas de «Mis voces», no en el listado de Samples', () => {
  const editor = read('features/creator/PlanetEditors.tsx');
  assert.match(editor, /<VoiceAvailabilityNotice sampleId=\{v\.voiceSampleId\}/, 'solo la voz elegida');
  assert.doesNotMatch(read('features/library/SamplesTab.tsx'), /voiceAvailability|useVoiceAvailability/, 'Samples no consulta al proveedor');
  const notice = read('features/voice/VoiceAvailabilityNotice.tsx');
  assert.match(notice, /availabilityState\(data\) !== 'expired'\) return null/, 'sin respuesta definitiva «caducada» no se muestra nada');
  assert.match(notice, /retry: false/);
});

test('el aviso de voz caducada ofrece «Recrear mi voz» y no pide cambiar la letra', () => {
  const notice = read('features/voice/VoiceAvailabilityNotice.tsx');
  assert.match(notice, /Recrear mi voz/);
  assert.doesNotMatch(notice, /letra|contenido sensible/i);
});

test('generar con una voz caducada (422 antes de cobrar): mensaje propio, sin reintento y con la acción de recrear', () => {
  const wizard = read('features/creator/CreatorWizard.tsx');
  assert.match(wizard, /voiceExpiredSample\(err\)/);
  assert.match(wizard, /canRetry: false, recreateVoiceId:/);
  assert.match(wizard, /No se descontaron fichas/);
  assert.match(wizard, /onRecreateVoice=\{\(sampleId\) => \{ setLive\(\{ phase: 'idle' \}\); openRecreateVoice\(sampleId\); \}\}/, 'vuelve al estudio y abre el asistente con la muestra');
  assert.match(wizard, /recreateSampleId=\{recreateVoiceId\}/);
  assert.match(wizard, /queryKey: \['voice-availability'\]/, 'al recrear o fallar se invalida la disponibilidad cacheada');
});

test('la generación que falla por voz caducada ofrece recrear la voz con su muestra original', () => {
  const status = read('features/creator/GenerationStatus.tsx');
  assert.match(status, /isVoiceExpiredFailure\(gen\.error \?\? musicJob\?\.error\) && voiceSampleIdOf\(gen\)/);
  assert.match(status, /Recrear mi voz/);
});

test('el asistente de clonación reutiliza la muestra original: recreate, sin pedir el audio otra vez y reintentos también como recreate', () => {
  const dialog = read('features/voice/VoiceCloneDialog.tsx');
  assert.match(dialog, /recreateSampleId\?: string \| null/);
  assert.match(dialog, /voiceSessionsApi\.create\(recreateSampleId, \{ recreate: true \}\)/);
  assert.match(dialog, /findActiveSession\(existing\.items, recreateSampleId\)/, 'retoma la sesión en curso en vez de duplicarla');
  assert.match(dialog, /voiceSessionsApi\.create\(sourceId, isRecreate \? \{ recreate: true \} : undefined\)/, 'el reintento tras un fallo sigue recreando');
  assert.match(dialog, /recreateStartedRef/, 'no duplica la sesión si el efecto corre dos veces');
  assert.match(dialog, /setVerifySampleId\(null\)/, 'no se reutiliza ninguna grabación de verificación anterior');
});

test('«Mis voces» ofrece recrear una voz y abre el mismo asistente (sin un segundo flujo paralelo)', () => {
  const tab = read('features/library/VoicesTab.tsx');
  assert.match(tab, /aria-label=\{`Recrear la voz \$\{sample\.name\}`\}/);
  assert.match(tab, /recreateSampleId=\{recreateSampleId\}/);
  assert.equal((tab.match(/<VoiceCloneDialog/g) ?? []).length, 1);
});

test('al recrear: la disponibilidad cacheada se invalida solo cuando la voz nueva está confirmada (READY), desde Biblioteca y desde el creador', () => {
  const dialog = read('features/voice/VoiceCloneDialog.tsx');
  const ready = dialog.slice(dialog.indexOf('if (!fresh?.sunoPersonaId) {'), dialog.indexOf("setPhase('avatar');"));
  assert.match(ready, /setVoice\(fresh\);/);
  assert.match(ready, /invalidateQueries\(\{ queryKey: \['samples'\] \}\)/, 'se mantiene la invalidación existente');
  assert.match(ready, /invalidateQueries\(\{ queryKey: \['voice-availability'\] \}\)/);
  assert.ok(ready.indexOf("['voice-availability']") > ready.indexOf('setVoice(fresh)'), 'después de confirmar la voz');
  // Ningún otro punto del diálogo la invalida: ni al cerrar con una sesión a medias, ni al iniciar la recreación, ni en fallos.
  assert.equal((dialog.match(/\['voice-availability'\]/g) ?? []).length, 1);
  // Es el único diálogo de clonación de Biblioteca › Voces y del creador, así que cubre ambos orígenes.
  assert.match(read('features/library/VoicesTab.tsx'), /recreateSampleId=\{recreateSampleId\}/);
  assert.match(read('features/creator/CreatorWizard.tsx'), /recreateSampleId=\{recreateVoiceId\}/);
});
