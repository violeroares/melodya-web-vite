// Decisiones puras del flujo «Crear voz» (src/features/voice/voice-session-flow.ts): sin DOM ni React.
// Ejecutar: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  creationOutcome, phraseOutcome, failedBeforeVoice, sessionErrorMessage, sanitizeDurationSec, resolveDurationSec, pollSession,
  MAX_SAMPLE_DURATION_SEC,
} from '../src/features/voice/voice-session-flow.ts';

/* ───────────── B1: la voz solo está lista con READY ───────────── */

test('creationOutcome: solo READY es éxito; FAILED es fallo; todo lo demás sigue pendiente', () => {
  assert.equal(creationOutcome({ status: 'READY' }), 'ready');
  assert.equal(creationOutcome({ status: 'FAILED' }), 'failed');
  for (const status of ['VOICE_PENDING', 'PHRASE_READY', 'PHRASE_PENDING', 'VERIFYING', 'algo-raro', '']) {
    assert.equal(creationOutcome({ status }), 'pending', status);
  }
  assert.equal(creationOutcome(null), 'pending');
  assert.equal(creationOutcome(undefined), 'pending');
});

test('polling agotado sin READY: devuelve el último estado pendiente y NO se interpreta como éxito', async () => {
  let calls = 0;
  const slept = [];
  const last = await pollSession(
    async () => { calls += 1; return { status: 'VOICE_PENDING' }; },
    (s) => creationOutcome(s) !== 'pending',
    3, 2500,
    { sleep: async (ms) => { slept.push(ms); } },
  );
  assert.equal(calls, 4, 'una consulta inicial + 3 reintentos');
  assert.deepEqual(slept, [2500, 2500, 2500]);
  assert.equal(last.status, 'VOICE_PENDING');
  assert.equal(creationOutcome(last), 'pending', 'agotar los intentos no es READY');
});

test('polling: corta en cuanto la sesión es READY o FAILED, y respeta la cancelación', async () => {
  const states = ['VOICE_PENDING', 'VOICE_PENDING', 'READY', 'VOICE_PENDING'];
  let i = 0;
  const done = await pollSession(async () => ({ status: states[i++] }), (s) => creationOutcome(s) !== 'pending', 10, 1, { sleep: async () => {} });
  assert.equal(done.status, 'READY');
  assert.equal(i, 3);

  let n = 0;
  let cancelled = false;
  await pollSession(
    async () => { n += 1; return { status: 'VOICE_PENDING' }; },
    () => false, 10, 1,
    { sleep: async () => { cancelled = true; }, isCancelled: () => cancelled },
  );
  assert.equal(n, 1, 'cancelado durante la espera: no consulta de nuevo');
});

test('polling: un error de red se propaga (quien llama decide; el diálogo lo trata como «sigue creándose»)', async () => {
  await assert.rejects(pollSession(async () => { throw new Error('red'); }, () => true, 2, 1, { sleep: async () => {} }), /red/);
});

/* ───────────── B2: frase de verificación ───────────── */

test('phraseOutcome: PHRASE_READY con texto es lista; PHRASE_PENDING es pendiente; FAILED es fallo definitivo', () => {
  assert.equal(phraseOutcome({ status: 'PHRASE_READY', phrase: 'Cantá esto' }), 'ready');
  assert.equal(phraseOutcome({ status: 'PHRASE_PENDING', phrase: null }), 'pending');
  assert.equal(phraseOutcome({ status: 'FAILED', phrase: null }), 'failed');
  assert.equal(phraseOutcome({ status: 'FAILED', phrase: 'quedó una frase vieja' }), 'failed', 'FAILED manda aunque haya texto');
});

test('ausencia de frase válida: no hay panel de grabación ni verificación posible', () => {
  for (const phrase of [null, undefined, '', '   ', 7, {}]) {
    assert.equal(phraseOutcome({ status: 'PHRASE_READY', phrase }), 'unavailable', String(phrase));
  }
  for (const status of ['READY', 'VOICE_PENDING', 'VERIFYING', 'desconocido']) {
    assert.equal(phraseOutcome({ status, phrase: 'hola' }), 'unavailable', status);
  }
  assert.equal(phraseOutcome(null), 'unavailable');
});

test('failedBeforeVoice distingue el fallo de la frase del fallo al crear la voz', () => {
  assert.equal(failedBeforeVoice({ status: 'FAILED', verifyTaskId: null }), true);
  assert.equal(failedBeforeVoice({ status: 'FAILED', verifyTaskId: 'task-1' }), false);
});

/* ───────────── M2: mensaje de error seguro ───────────── */

test('sessionErrorMessage: usa error.message del backend ({code, providerCode, message}) y lo limpia', () => {
  assert.equal(sessionErrorMessage({ code: 'fail', providerCode: 500, message: 'Verification audio did not match the validation phrase' }), 'Verification audio did not match the validation phrase');
  assert.equal(sessionErrorMessage({ message: '  Suno no\n pudo   generar la frase  ' }), 'Suno no pudo generar la frase');
  assert.equal(sessionErrorMessage({ code: 'VOICE_TIMEOUT', message: 'Suno no terminó de crear la voz a tiempo' }), 'Suno no terminó de crear la voz a tiempo');
});

test('sessionErrorMessage: sin mensaje utilizable devuelve null (cae al texto genérico)', () => {
  for (const error of [undefined, null, 'texto', 42, [], {}, { message: 5 }, { message: '' }, { message: '   ' }, { code: 'X' }]) {
    assert.equal(sessionErrorMessage(error), null, JSON.stringify(error));
  }
});

test('sessionErrorMessage: no deja pasar URLs (firmadas), tokens, claves ni trazas internas', () => {
  const unsafe = [
    'No se pudo descargar https://api.melodya.test/api/files/abc/stream?st=eyJhbGciOiJIUzI1NiJ9.xxxxxxxx.yyyy',
    'fallo en http://localhost:4000/api/files/x',
    'Authorization: Bearer abcdef123456',
    'token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    'sk-abcdef123456789',
    'apiKey inválida',
    'Error: boom\n    at run (/srv/app/src/x.js:10:5)',
    'falló en fn (/srv/app/src/x.js:10:5)',
  ];
  for (const message of unsafe) assert.equal(sessionErrorMessage({ message }), null, message);
});

test('sessionErrorMessage: acota la longitud', () => {
  const out = sessionErrorMessage({ message: 'a'.repeat(500) });
  assert.equal(out.length, 200);
  assert.ok(out.endsWith('…'));
});

/* ───────────── M1: duración de las muestras ───────────── */

test('sanitizeDurationSec: solo números finitos > 0 y ≤ 600 (el límite de POST /samples); el resto se omite', () => {
  assert.equal(sanitizeDurationSec(12.34), 12.3);
  assert.equal(sanitizeDurationSec(MAX_SAMPLE_DURATION_SEC), 600);
  for (const v of [0, -1, 600.5, Infinity, NaN, '12', null, undefined]) assert.equal(sanitizeDurationSec(v), undefined, String(v));
});

test('resolveDurationSec: prefiere la duración medida; si no, la de la grabadora; nunca inventa una', () => {
  assert.equal(resolveDurationSec(14.2, 20), 14.2);
  assert.equal(resolveDurationSec(null, 20), 20, 'WebM de MediaRecorder: sin duración en los metadatos → tiempo de la grabadora');
  assert.equal(resolveDurationSec(Infinity, 18), 18);
  assert.equal(resolveDurationSec(null, undefined), undefined, 'subida sin duración medible: no se envía');
  assert.equal(resolveDurationSec(null, 0), undefined);
  assert.equal(resolveDurationSec(1200, undefined), undefined, 'más de 600 s: el backend lo rechazaría, no se envía');
});
