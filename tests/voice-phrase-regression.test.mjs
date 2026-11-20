// Regresión: «Continuar» no hacía nada tras la frase. PhrasePanel veía PHRASE_READY por polling, pero el diálogo conservaba la
// sesión PHRASE_PENDING y su guarda descartaba el envío en silencio. Aquí se recorre la secuencia con la lógica real
// (src/features/voice/voice-session-flow.ts), sin DOM: el repo no tiene jsdom/testing-library y el componente solo cablea estas funciones.
// Ejecutar: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';

import { awaitPhrase, uploadPhraseReading, phraseOutcome, findActiveSession, closeNotice, isRecordingPending, withoutSession, resumePhase, nextCloneAction, PHRASE_INSTRUCTION, PHRASE_HINT, PHRASE_RETRY_TIP } from '../src/features/voice/voice-session-flow.ts';

const noSleep = async () => {};
const file = { name: 'voz.webm', type: 'audio/webm' };

function deps(log) {
  return {
    readDuration: async () => null, // WebM de MediaRecorder: no mide → cae a la duración de la grabadora
    createSample: async (f, meta) => { log.push({ f, meta }); return { id: 'sample-lectura' }; },
  };
}

test('PHRASE_PENDING → polling PHRASE_READY → el envío usa la sesión actualizada y sube la lectura', async () => {
  const initial = { id: 'ses-1', status: 'PHRASE_PENDING', phrase: null };
  const polled = [initial, { id: 'ses-1', status: 'PHRASE_READY', phrase: 'Canta con armonía' }];
  let i = 0;
  const step = await awaitPhrase(async () => polled[Math.min(i++, polled.length - 1)], 5, 1, { sleep: noSleep });
  assert.equal(step.kind, 'ready');
  assert.equal(step.session.id, 'ses-1');

  // El diálogo guarda la sesión del polling (onSession → setSession) y el envío se evalúa contra ella.
  let dialogSession = initial;
  dialogSession = step.session;
  const log = [];
  const res = await uploadPhraseReading(dialogSession, file, 6.4, 'Frase de verificación', deps(log));
  assert.deepEqual(res, { status: 'uploaded', sampleId: 'sample-lectura' });
  assert.equal(log.length, 1);
  assert.equal(log[0].f, file);
  assert.deepEqual(log[0].meta, { type: 'VOICE', name: 'Frase de verificación', purpose: 'VOICE_VERIFICATION', durationSec: 6.4 });
});

test('con la sesión obsoleta (PENDING) el envío NO es silencioso: devuelve blocked y no sube nada', async () => {
  const log = [];
  const res = await uploadPhraseReading({ id: 'ses-1', status: 'PHRASE_PENDING', phrase: null }, file, 6, 'x', deps(log));
  assert.deepEqual(res, { status: 'blocked' });
  assert.equal(log.length, 0);
  assert.equal((await uploadPhraseReading(null, file, 6, 'x', deps(log))).status, 'blocked');
});

test('awaitPhrase: timeout no es fallo ni éxito; FAILED y READY sin texto son fallo', async () => {
  const pending = await awaitPhrase(async () => ({ status: 'PHRASE_PENDING' }), 2, 1, { sleep: noSleep });
  assert.equal(pending.kind, 'timeout');
  assert.equal((await awaitPhrase(async () => ({ status: 'FAILED' }), 2, 1, { sleep: noSleep })).kind, 'failed');
  assert.equal((await awaitPhrase(async () => ({ status: 'PHRASE_READY', phrase: '  ' }), 2, 1, { sleep: noSleep })).kind, 'failed');
  assert.equal(phraseOutcome({ status: 'PHRASE_READY', phrase: 'hola' }), 'ready');
});

test('cancelado el polling no entrega una sesión como lista', async () => {
  let calls = 0;
  const step = await awaitPhrase(async () => { calls++; return { status: 'PHRASE_PENDING' }; }, 5, 1, { sleep: noSleep, isCancelled: () => calls >= 1 });
  assert.equal(step.kind, 'timeout');
  assert.equal(calls, 1);
});

test('retomar una sesión pendiente: findActiveSession la encuentra y no hace falta crear otra', () => {
  const sessions = [
    { id: 'a', voiceSampleId: 's1', status: 'FAILED' },
    { id: 'b', voiceSampleId: 's1', status: 'PHRASE_READY' },
    { id: 'c', voiceSampleId: 's2', status: 'READY' },
  ];
  assert.equal(findActiveSession(sessions, 's1')?.id, 'b');
  for (const status of ['PHRASE_PENDING', 'PHRASE_READY', 'VERIFYING', 'VOICE_PENDING']) {
    assert.ok(findActiveSession([{ id: 'x', voiceSampleId: 's', status }], 's'), status);
  }
  assert.equal(findActiveSession(sessions, 's2'), undefined, 'READY no es reanudable');
  assert.equal(findActiveSession(sessions, 's3'), undefined);
  assert.equal(findActiveSession([{ id: 'f', voiceSampleId: 's1', status: 'FAILED' }], 's1'), undefined, 'FAILED: se ofrece reintento, no retomar');
});

test('grabación del micrófono en una sesión PHRASE_READY: el id de la muestra nueva es el que se verifica', async () => {
  const log = [];
  const d = { readDuration: async () => 4.2, createSample: async (f, m) => { log.push(m); return { id: 'mic-1' }; } };
  const res = await uploadPhraseReading({ id: 'ses-9', status: 'PHRASE_READY', phrase: 'hola' }, file, 3, 'n', d);
  assert.deepEqual(res, { status: 'uploaded', sampleId: 'mic-1' });
  assert.equal(log[0].durationSec, 4.2, 'prefiere la duración medida a la de la grabadora');
});

test('un fallo al subir NO se presenta como éxito (propaga el error)', async () => {
  const d = { readDuration: async () => null, createSample: async () => { throw new Error('413 demasiado grande'); } };
  await assert.rejects(uploadPhraseReading({ id: 's', status: 'PHRASE_READY', phrase: 'hola' }, file, 3, 'n', d), /413/);
});

test('cerrar el diálogo: avisa solo si hay sesión creada y según la fase', () => {
  assert.equal(closeNotice('phrase', false), null);
  assert.equal(closeNotice('source', true), null);
  assert.match(closeNotice('phrase', true), /retomala/);
  assert.match(closeNotice('details', true), /retomala/);
  assert.match(closeNotice('creating', true), /creándose/);
  assert.equal(closeNotice('avatar', true), null);
});

test('reintento de una sesión FAILED: si hay otra activa para la misma muestra se detecta (no se duplica)', () => {
  const sessions = [
    { id: 'viejo', voiceSampleId: 's1', status: 'FAILED' },
    { id: 'nuevo', voiceSampleId: 's1', status: 'PHRASE_PENDING' },
    { id: 'otro', voiceSampleId: 's2', status: 'FAILED' },
  ];
  assert.ok(findActiveSession(sessions, 's1'), 's1 ya tiene una activa: no ofrecer reintento');
  assert.equal(findActiveSession(sessions, 's2'), undefined, 's2 solo tiene la fallida: sí se puede reintentar');
});

test('isRecordingPending: solo una toma terminada, con archivo y de duración válida cuenta como dato a perder', () => {
  assert.equal(isRecordingPending('ready', true, 12, 10), true);
  assert.equal(isRecordingPending('ready', true, 3, 3), true);
  assert.equal(isRecordingPending('ready', true, 2.9, 3), false, 'demasiado corta: no se puede enviar');
  assert.equal(isRecordingPending('ready', false, 12, 10), false, 'sin archivo');
  for (const st of ['idle', 'requesting', 'recording', 'stopping']) assert.equal(isRecordingPending(st, true, 12, 10), false, st);
});

test('findActiveSession con excludeId: la sesión propia (aunque la lista la vea activa) no cuenta como «otra»', () => {
  // Lista desactualizada: la tarjeta ya está en FAILED, pero la lista todavía dice VOICE_PENDING.
  const stale = [{ id: 'propia', voiceSampleId: 's1', status: 'VOICE_PENDING' }];
  assert.ok(findActiveSession(stale, 's1'), 'sin excluir se detectaría a sí misma (el defecto)');
  assert.equal(findActiveSession(stale, 's1', 'propia'), undefined, 'excluida: se puede reintentar');
});

test('findActiveSession con excludeId: otra sesión activa de la misma muestra sí cuenta; la de otra muestra no', () => {
  const sessions = [
    { id: 'propia', voiceSampleId: 's1', status: 'FAILED' },
    { id: 'otra', voiceSampleId: 's1', status: 'PHRASE_READY' },
    { id: 'ajena', voiceSampleId: 's2', status: 'VOICE_PENDING' },
  ];
  assert.equal(findActiveSession(sessions, 's1', 'propia')?.id, 'otra');
  assert.equal(findActiveSession([sessions[0], sessions[2]], 's1', 'propia'), undefined, 'solo hay una activa de otra muestra');
});

test('eliminar una sesión: la tarjeta sale de la página en caché y las demás se conservan', () => {
  const page = { items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], pagination: { total: 3 } };
  const next = withoutSession(page, 'b');
  assert.deepEqual(next.items.map((s) => s.id), ['a', 'c']);
  assert.deepEqual(next.pagination, page.pagination);
  assert.equal(page.items.length, 3, 'no muta la caché original');
  assert.equal(withoutSession(undefined, 'b'), undefined);
});

test('retomar: cada estado en curso entra por la fase que le toca; las terminadas no se retoman', () => {
  assert.equal(resumePhase('PHRASE_PENDING'), 'phrase');
  assert.equal(resumePhase('PHRASE_READY'), 'phrase');
  assert.equal(resumePhase('VERIFYING'), 'creating');
  assert.equal(resumePhase('VOICE_PENDING'), 'creating');
  for (const st of ['READY', 'FAILED', 'algo-raro', '', null, undefined]) assert.equal(resumePhase(st), null, String(st));
  // nunca se vuelve a la fase de grabar la muestra original: ninguna fase de retomar es «source»
  for (const st of ['PHRASE_PENDING', 'PHRASE_READY', 'VERIFYING', 'VOICE_PENDING']) assert.notEqual(resumePhase(st), 'source');
});

test('clonar una muestra con sesión en curso la retoma (no se crea otra); sin sesión en curso, se crea', () => {
  const sessions = [
    { id: 'vieja', voiceSampleId: 's1', status: 'FAILED' },
    { id: 'activa', voiceSampleId: 's1', status: 'PHRASE_READY' },
    { id: 'otra', voiceSampleId: 's2', status: 'READY' },
  ];
  const resumed = nextCloneAction(sessions, 's1');
  assert.deepEqual([resumed.action, resumed.session.id], ['resume', 'activa']);
  assert.deepEqual(nextCloneAction(sessions, 's2'), { action: 'create' }, 'READY no se retoma');
  assert.deepEqual(nextCloneAction(sessions, 's3'), { action: 'create' });
  assert.deepEqual(nextCloneAction([], 's1'), { action: 'create' });
});

test('frase de verificación: todas las pantallas piden cantarla (docs de Suno) y ninguna pide hablar', () => {
  for (const text of [PHRASE_INSTRUCTION, PHRASE_HINT, PHRASE_RETRY_TIP]) {
    assert.match(text, /cant/i, text);
    assert.doesNotMatch(text, /voz natural|leé|leéla|leyéndola|leerla/i, text);
  }
  assert.ok(!PHRASE_INSTRUCTION.includes('“'), 'el texto de la frase lo pone el proveedor: no se mezcla con la instrucción');
});
