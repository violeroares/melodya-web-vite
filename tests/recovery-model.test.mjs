// Recuperar y reintentar una generación FAILED (E4): candidata, planetas, referencias no disponibles, letra retenida, destino, pedido a enviar,
// rechazos del reintento y cableado (creador, resumen, Perfil → Actividad).
// Ejecutar: node --test "tests/*.test.mjs"
import './_helpers/register-ts-resolve.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const R = await import('../src/features/creator/recovery-model.ts');
const V = await import('../src/features/creator/version-source.ts');
const P = await import('../src/lib/pending-request.ts');
const M = await import('../src/features/creator/song-model.ts');

const root = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const NOW = Date.parse('2026-11-12T12:00:00Z');
const ago = (days) => new Date(NOW - days * 86_400_000).toISOString();

const gen = (over = {}) => ({ id: 'g1', status: 'FAILED', generationTypes: ['MUSIC'], createdAt: ago(1), retriedBy: null, ...over });

function recovery(over = {}) {
  return {
    generationId: 'g1',
    status: 'FAILED',
    failure: { reasonCode: 'PROVIDER_ERROR', userMessage: 'x' },
    retryable: { allowed: true, reason: null, requiresEdit: false, requiresDecision: false },
    target: { kind: 'NEW_SONG', status: 'AVAILABLE', reason: null },
    destinationOptions: ['SAME', 'NEW_SONG'],
    request: {
      inputs: [{ field: 'IDEA', text: 'una cumbia alegre' }, { field: 'GENRE', value: ['Cumbia'] }],
      options: {},
      title: 'Mi cumbia',
    },
    meta: { lyrics: { origin: 'NONE' } },
    held: [], missing: [], checks: [], notes: [], validation: { ok: true, issues: [] }, credits: { cost: 5, balance: 10 },
    ...over,
  };
}
const session = (over = {}) => ({ generationId: 'g1', needsApply: false, destination: null, otherOrigin: null, heldDecision: null, regenerateLyrics: false, startedAt: ago(0), ...over });
const hydrate = (rec, extra = {}) => R.songFromRecovery({ recovery: rec, voice: null, reference: null, ...extra });

/* ───────── Qué ofrecer ───────── */

test('candidata: la fallida más reciente de música, sin reintento y reciente', () => {
  assert.equal(R.pickRecoveryCandidate([gen()], {}, NOW)?.id, 'g1');
});

test('candidata: si lo último fue otra cosa (en curso o terminada) no se insiste', () => {
  assert.equal(R.pickRecoveryCandidate([gen({ id: 'g2', status: 'PROCESSING' }), gen()], {}, NOW), null);
  assert.equal(R.pickRecoveryCandidate([gen({ id: 'g2', status: 'COMPLETED' }), gen()], {}, NOW), null);
});

test('candidata: las canceladas y lo que no es música se saltean', () => {
  assert.equal(R.pickRecoveryCandidate([gen({ id: 'c', status: 'CANCELED' }), gen({ id: 'p', generationTypes: ['COVER'] }), gen()], {}, NOW)?.id, 'g1');
});

test('candidata: ya reintentada, atendida o vieja no se ofrece', () => {
  assert.equal(R.pickRecoveryCandidate([gen({ retriedBy: 'g9' })], {}, NOW), null);
  assert.equal(R.pickRecoveryCandidate([gen()], { g1: { state: 'DISMISSED' } }, NOW), null);
  assert.equal(R.pickRecoveryCandidate([gen({ createdAt: ago(20) })], {}, NOW), null);
});

test('historial: solo se ofrece «Recuperar» de una FAILED de música sin reintento', () => {
  assert.equal(R.canRecoverFromHistory(gen()), true);
  assert.equal(R.canRecoverFromHistory(gen({ status: 'CANCELED' })), false);
  assert.equal(R.canRecoverFromHistory(gen({ status: 'COMPLETED' })), false);
  assert.equal(R.canRecoverFromHistory(gen({ retriedBy: 'g2' })), false);
  assert.equal(R.canRecoverFromHistory(gen({ generationTypes: ['LYRICS'] })), false);
});

/* ───────── Planetas ───────── */

test('reconstruye los planetas desde el contrato, aunque el editor esté vacío', () => {
  const { song, notes } = hydrate(recovery());
  assert.equal(song.composition.mode, 'idea');
  assert.equal(song.composition.idea, 'una cumbia alegre');
  assert.equal(song.composition.title, 'Mi cumbia');
  assert.equal(notes.length, 0);
});

test('con letra en la solicitud, el modo es letra', () => {
  const rec = recovery({ request: { inputs: [{ field: 'LYRICS', text: 'la la la' }], options: {} } });
  const { song } = hydrate(rec);
  assert.equal(song.composition.mode, 'lyrics');
  assert.equal(song.composition.lyrics, 'la la la');
});

test('instrumental: modo instrumental', () => {
  const rec = recovery({ request: { inputs: [{ field: 'IDEA', text: 'jazz' }], options: { instrumental: true } } });
  assert.equal(hydrate(rec).song.composition.mode, 'instrumental');
});

/* ───────── Referencias no disponibles ───────── */

test('voz vencida / muestra eliminada / en Papelera: avisa y conserva el resto', () => {
  const rec = recovery({ missing: [
    { field: 'VOICE_SAMPLE', reason: 'VOICE_EXPIRED', sampleId: 'v1' },
    { field: 'REFERENCE_SAMPLE', reason: 'SAMPLE_IN_TRASH', sampleId: 'r1' },
  ] });
  const { song, notes } = hydrate(rec);
  assert.equal(song.composition.idea, 'una cumbia alegre', 'el resto de la composición se conserva');
  const voice = notes.find((n) => n.planet === 'voice');
  assert.match(voice.text, /caducó/);
  assert.equal(voice.action, 'recreate-voice');
  assert.equal(voice.sampleId, 'v1');
  assert.match(notes.find((n) => n.planet === 'reference').text, /Papelera/);
  assert.ok(notes.every((n) => n.tone === 'warning'));
});

test('motivo desconocido: aviso genérico, nunca silencio', () => {
  const notes = R.missingNotes({ missing: [{ field: 'VOICE_SAMPLE', reason: 'ALGO_NUEVO' }] });
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /ya no está disponible/);
});

test('avisos del servidor: se muestran, salvo los del destino (los explica la tarjeta de decisión)', () => {
  const notes = R.serverNotes({ notes: [
    { code: 'AI_LYRICS_REUSED', text: 'Reutilizamos tu letra.' },
    { code: 'TARGET_UNAVAILABLE', text: 'duplicado' },
    { code: 'REMIX_ORIGIN_UNAVAILABLE', text: 'duplicado' },
  ] });
  assert.deepEqual(notes.map((n) => n.text), ['Reutilizamos tu letra.']);
  assert.equal(notes[0].tone, 'info');
});

/* ───────── Letra retenida ───────── */

const HELD = [{ field: 'LYRICS', text: 'letra de procedencia incierta', reason: 'UNCERTAIN_PROVENANCE' }];

test('letra retenida: NUNCA se carga sola', () => {
  const { song } = hydrate(recovery({ held: HELD }));
  assert.notEqual(song.composition.lyrics, 'letra de procedencia incierta');
  assert.equal(song.composition.mode, 'idea');
});

test('letra retenida: con decisión explícita de conservarla pasa al planeta; descartarla la deja fuera', () => {
  const keep = hydrate(recovery({ held: HELD }), { heldDecision: 'KEEP' }).song;
  assert.equal(keep.composition.lyrics, 'letra de procedencia incierta');
  assert.equal(keep.composition.mode, 'lyrics');
  const drop = hydrate(recovery({ held: HELD }), { heldDecision: 'DROP' }).song;
  assert.equal(drop.composition.lyrics, '');
  const back = R.withoutHeldLyrics(keep, 'letra de procedencia incierta');
  assert.equal(back.composition.lyrics, '');
  assert.equal(back.composition.mode, 'idea');
});

test('quitar la letra retenida no toca una letra que el usuario ya cambió', () => {
  const edited = R.withHeldLyrics(M.emptySong, 'otra cosa');
  assert.equal(R.withoutHeldLyrics(edited, 'letra de procedencia incierta').composition.lyrics, 'otra cosa');
});

test('con letra retenida y sin decisión no se puede enviar', () => {
  const rec = recovery({ held: HELD });
  assert.match(R.recoveryBlockedReason({ session: session({ destination: 'SAME' }), recovery: rec, loading: false, failed: false }), /letra retenida/);
  assert.equal(R.recoveryBlockedReason({ session: session({ destination: 'SAME', heldDecision: 'DROP' }), recovery: rec, loading: false, failed: false }), null);
});

/* ───────── Destino ───────── */

const trashed = () => recovery({
  target: { kind: 'NEW_VERSION', status: 'UNAVAILABLE', reason: 'TRASHED', songId: 's1' },
  destinationOptions: ['RESTORE', 'NEW_SONG'],
});
const goneRemix = () => recovery({
  target: { kind: 'REMIX', status: 'UNAVAILABLE', reason: 'NOT_AVAILABLE', remix: { songId: 's9', mode: 'COVER' } },
  destinationOptions: ['NEW_SONG'],
});

test('«otra versión» con la canción en la Papelera: ofrece restaurar o crear canción nueva, y exige decidir', () => {
  const d = R.describeTarget(trashed());
  assert.equal(d.needsDecision, true);
  assert.equal(d.canRestore, true);
  assert.deepEqual(d.options, ['RESTORE', 'NEW_SONG']);
  assert.equal(R.effectiveDestination(session(), trashed()), null, 'nunca cambia el destino en silencio');
});

test('remix cuyo origen ya no existe: elegir otro origen o convertir en canción nueva; no se restaura', () => {
  const d = R.describeTarget(goneRemix());
  assert.deepEqual(d.options, ['NEW_SONG', 'OTHER_ORIGIN']);
  assert.equal(d.canRestore, false);
  assert.equal(R.effectiveDestination(session(), goneRemix()), null);
});

test('destino disponible: se mantiene sin pedir nada', () => {
  const rec = recovery({ target: { kind: 'NEW_VERSION', status: 'AVAILABLE', reason: null, songId: 's1' } });
  assert.equal(R.describeTarget(rec).needsDecision, false);
  assert.equal(R.effectiveDestination(session(), rec), 'SAME');
});

test('sin decidir el destino no se puede enviar; con la decisión, sí', () => {
  assert.match(R.recoveryBlockedReason({ session: session(), recovery: trashed(), loading: false, failed: false }), /destino/);
  assert.equal(R.recoveryBlockedReason({ session: session({ destination: 'NEW_SONG' }), recovery: trashed(), loading: false, failed: false }), null);
});

test('otro origen sin elegir bloquea; cargando o con error también', () => {
  assert.match(R.recoveryBlockedReason({ session: session({ destination: 'OTHER_ORIGIN' }), recovery: goneRemix(), loading: false, failed: false }), /otro origen/);
  assert.match(R.recoveryBlockedReason({ session: session(), recovery: null, loading: true, failed: false }), /recuperando/i);
  assert.match(R.recoveryBlockedReason({ session: session(), recovery: null, loading: false, failed: true }), /No pudimos/);
  assert.match(R.recoveryBlockedReason({ session: session({ needsApply: true, destination: 'SAME' }), recovery: recovery(), loading: false, failed: false }), /cargando/i);
});

/* ───────── Pedido a enviar ───────── */

const songOf = (rec) => hydrate(rec).song;

test('reintento enlazado: SAME en canción nueva, con la intención estable `retry.<id>`', () => {
  const rec = recovery();
  const out = R.buildRecoverySubmit({ song: songOf(rec), recovery: rec, session: session(), retryAvailable: true });
  assert.equal(out.kind, 'RETRY');
  assert.equal(out.endpoint, 'POST /generations/:id/retry');
  assert.equal(out.intent, 'retry.g1');
  assert.deepEqual(out.body.destination, { kind: 'SAME' });
  assert.ok(Array.isArray(out.body.request.inputs));
  assert.equal(out.body.songId, undefined);
  assert.equal(out.body.remix, undefined);
});

test('reintento: la edición del usuario viaja en `request` (se puede editar antes de reintentar)', () => {
  const rec = recovery();
  const edited = M.updatePlanet(songOf(rec), 'composition', { idea: 'una cumbia triste' });
  const out = R.buildRecoverySubmit({ song: edited, recovery: rec, session: session(), retryAvailable: true });
  const idea = out.body.request.inputs.find((i) => i.field === 'IDEA');
  assert.equal(idea.text, 'una cumbia triste');
});

test('destino canción nueva sobre un destino que era otra versión: pide confirmación explícita', () => {
  const rec = trashed();
  const out = R.buildRecoverySubmit({ song: songOf(rec), recovery: rec, session: session({ destination: 'NEW_SONG' }), retryAvailable: true });
  assert.deepEqual(out.body.destination, { kind: 'NEW_SONG', confirm: true });
});

test('regenerar la letra solo viaja si el usuario lo pidió', () => {
  const rec = recovery();
  const a = R.buildRecoverySubmit({ song: songOf(rec), recovery: rec, session: session(), retryAvailable: true });
  const b = R.buildRecoverySubmit({ song: songOf(rec), recovery: rec, session: session({ regenerateLyrics: true }), retryAvailable: true });
  assert.equal(a.body.regenerateLyrics, undefined);
  assert.equal(b.body.regenerateLyrics, true);
});

test('destino sin decidir ⇒ BLOQUEADO (nunca se manda a ningún lado)', () => {
  const rec = trashed();
  assert.equal(R.buildRecoverySubmit({ song: songOf(rec), recovery: rec, session: session(), retryAvailable: true }).kind, 'BLOCKED');
});

test('otro origen del remix: creación normal con ese origen, sin vínculo con la original', () => {
  const rec = goneRemix();
  const s = session({ destination: 'OTHER_ORIGIN', otherOrigin: { songId: 'z1', versionId: null, mode: 'PROMPT_REUSE' } });
  const out = R.buildRecoverySubmit({ song: songOf(rec), recovery: rec, session: s, retryAvailable: true });
  assert.equal(out.kind, 'PLAIN');
  assert.equal(out.endpoint, 'POST /generations');
  assert.equal(out.body.remix.songId, 'z1');
  assert.equal(out.intent, P.intentKey({ remixSongId: 'z1', remixMode: 'PROMPT_REUSE' }));
});

test('reintento apagado: se crea como canción nueva por la vía normal (decisión explícita), con su propia intención', () => {
  const rec = recovery();
  const out = R.buildRecoverySubmit({ song: songOf(rec), recovery: rec, session: session(), retryAvailable: false });
  assert.equal(out.kind, 'PLAIN');
  assert.equal(out.intent, 'new');
  assert.equal(out.body.retryOf, undefined);
});

test('reintento apagado sobre «otra versión» disponible: conserva el destino (songId)', () => {
  const rec = recovery({ target: { kind: 'NEW_VERSION', status: 'AVAILABLE', reason: null, songId: 's1' } });
  const out = R.buildRecoverySubmit({ song: songOf(rec), recovery: rec, session: session(), retryAvailable: false });
  assert.equal(out.kind, 'PLAIN');
  assert.equal(out.body.songId, 's1');
  assert.equal(out.intent, 'version.s1');
});

/* ───────── Reintento: rechazos e idempotencia ───────── */

const apiErr = (status, details) => Object.assign(new Error('x'), { status, details });

test('rechazos del reintento: se interpretan por código', () => {
  assert.deepEqual(R.interpretRetryError(apiErr(404, { code: 'GENERATION_RETRY_DISABLED' })), { kind: 'DISABLED' });
  assert.deepEqual(R.interpretRetryError(apiErr(409, { code: 'RETRY_ALREADY_EXISTS', retriedBy: 'g2' })), { kind: 'ALREADY_RETRIED', retriedBy: 'g2' });
  assert.deepEqual(R.interpretRetryError(apiErr(409, { code: 'GENERATION_NOT_RETRYABLE', reason: 'COMPLETED' })), { kind: 'NOT_RETRYABLE', reason: 'COMPLETED' });
  assert.equal(R.interpretRetryError(apiErr(409, { code: 'TARGET_UNAVAILABLE', reason: 'TRASHED' })).kind, 'TARGET_CHANGED');
  assert.equal(R.interpretRetryError(apiErr(409, { code: 'REMIX_ORIGIN_UNAVAILABLE' })).kind, 'TARGET_CHANGED');
  assert.equal(R.interpretRetryError(apiErr(500, {})).kind, 'OTHER');
  assert.equal(R.interpretRetryError(null).kind, 'OTHER');
});

test('los textos del reintento: explican y no prometen cobros ni reintegros', () => {
  assert.match(R.RETRY_DISABLED_TEXT, /todavía no está disponible/);
  assert.match(R.RETRY_DISABLED_TEXT, /canción nueva/);
  assert.match(R.RETRY_ALREADY_TEXT, /ya se había vuelto a intentar/i);
  assert.match(R.TARGET_CHANGED_TEXT, /No se cobró nada/);
  assert.match(R.notRetryableText('COMPLETED'), /terminó bien/);
  assert.match(R.notRetryableText('RAREZA'), /ya no se puede recuperar/);
});

test('idempotencia: la intención `retry.<id>` es estable y los 409 definitivos del reintento son REJECTED (sin cobro, sin pendiente)', () => {
  assert.equal(P.intentKey({ retryOfId: 'g1' }), 'retry.g1');
  assert.equal(P.retryTargetOf('retry.g1'), 'g1');
  assert.equal(P.retryTargetOf('new'), null);
  for (const code of ['RETRY_ALREADY_EXISTS', 'GENERATION_NOT_RETRYABLE', 'TARGET_UNAVAILABLE', 'REMIX_ORIGIN_UNAVAILABLE']) {
    assert.equal(P.classifyError(apiErr(409, { code })), 'REJECTED', code);
  }
  assert.equal(P.classifyError(apiErr(409, {})), 'UNCERTAIN', 'un 409 sin código propio sigue siendo incierto (puede haberse creado)');
  assert.equal(P.classifyError(apiErr(404, { code: 'GENERATION_RETRY_DISABLED' })), 'REJECTED');
  assert.equal(P.classifyError(apiErr(0, {})), 'UNCERTAIN');
});

test('doble envío: el mismo reintento reutiliza el clientRequestId y no se envía otro cuerpo mientras haya uno sin resolver', async () => {
  const m = new Map();
  const storage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
  let n = 0;
  const store = P.createPendingStore({ storage, newId: () => `id-${++n}` });
  const body = { request: { inputs: [{ field: 'IDEA', text: 'a' }], options: {} }, destination: { kind: 'SAME' } };
  const sent = [];
  const send = async (b) => { sent.push(b); throw Object.assign(new Error('net'), { status: 0 }); }; // sin respuesta: incierto
  const first = await store.submit({ userId: 'u1', intent: 'retry.g1', body, send, endpoint: 'POST /generations/:id/retry' });
  assert.equal(first.kind, 'UNCERTAIN');
  const again = await store.submit({ userId: 'u1', intent: 'retry.g1', body, send, endpoint: 'POST /generations/:id/retry' });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].clientRequestId, sent[1].clientRequestId, 'misma clave: el servidor devuelve la misma generación');
  const edited = { ...body, request: { inputs: [{ field: 'IDEA', text: 'b' }], options: {} } };
  const blocked = await store.submit({ userId: 'u1', intent: 'retry.g1', body: edited, send, endpoint: 'POST /generations/:id/retry' });
  assert.equal(blocked.kind, 'BLOCKED', 'con un pedido sin confirmar no se puede mandar otro cuerpo');
  assert.equal(sent.length, 2);
  assert.ok(again);
});

/* ───────── Cableado ───────── */

test('creador: avisa con dos acciones, no pisa composiciones existentes y descartar no borra el historial', () => {
  const w = read('src/features/creator/CreatorWizard.tsx');
  const ui = read('src/features/creator/RecoveryUI.tsx');
  assert.match(ui, /Recuperar composición/);
  assert.match(ui, /Descartar y empezar de cero/);
  assert.match(w, /requestRecovery/);
  assert.match(w, /isEmptySong\(normalSong\)/, 'reemplazar una composición en curso exige confirmación');
  assert.match(w, /Recuperar y reemplazar/);
  assert.ok(!/generationApi\.(remove|delete)/.test(w), 'descartar jamás borra la generación fallida');
  assert.match(w, /recover/, 'maneja ?recover=');
  assert.match(w, /rec\.end\('DISMISSED'\)/);
});

test('creador: el envío usa el reintento enlazado y el destino se decide, nunca se cambia en silencio', () => {
  const w = read('src/features/creator/CreatorWizard.tsx');
  assert.match(w, /generationApi\.retry\(/);
  assert.match(w, /buildRecoverySubmit/);
  assert.match(w, /handleRetryRejection/);
  assert.match(w, /markRetryDisabled/);
  assert.match(w, /recoveryBlock/);
});

test('resumen de una FALLIDA: «Editar y reintentar» recupera desde el servidor; la cancelada conserva «Intentar de nuevo»', () => {
  const g = read('src/features/creator/GenerationStatus.tsx');
  assert.match(g, /onRecover/);
  assert.match(g, /Editar y reintentar/);
  assert.match(g, /gen\?\.status === 'FAILED'/);
  assert.match(g, /Intentar de nuevo/);
});

test('API: reintento, recuperación y búsqueda por clave existen con las rutas del contrato', () => {
  const a = read('src/lib/api/index.ts');
  assert.match(a, /\/generations\/\$\{[^}]+\}\/recovery/);
  assert.match(a, /\/generations\/\$\{[^}]+\}\/retry/);
  assert.match(a, /by-request/);
});

test('el módulo de recuperación no toca el borrador heredado ni borra borradores al cerrar sesión', () => {
  for (const f of ['src/lib/recovery-store.ts', 'src/features/creator/recovery-model.ts', 'src/features/creator/use-recovery-session.ts']) {
    const s = read(f);
    assert.ok(!s.includes('melodya.creator.solar.v1'), f);
    assert.ok(!/localStorage\.(removeItem|clear)/.test(s), f);
  }
});

/* ───────── Simplificación del aviso y desvincular (E4, ajuste de UX) ───────── */

test('desvincular: la sesión sigue abierta, se envía como generación independiente (sin reintento enlazado)', () => {
  const rec = recovery();
  const linked = R.buildRecoverySubmit({ song: songOf(rec), recovery: rec, session: session(), retryAvailable: true });
  const detached = R.buildRecoverySubmit({ song: songOf(rec), recovery: rec, session: session({ detached: true }), retryAvailable: true });
  assert.equal(linked.kind, 'RETRY');
  assert.equal(detached.kind, 'PLAIN');
  assert.equal(detached.endpoint, 'POST /generations');
  assert.equal(detached.body.retryOf, undefined);
  assert.notEqual(detached.intent, linked.intent, 'otra intención: no comparte clave con el reintento');
});

test('desvincular conserva los planetas y NO oculta las advertencias (voz, referencias y letra retenida siguen exigiéndose)', () => {
  const rec = recovery({ held: HELD, missing: [{ field: 'VOICE_SAMPLE', reason: 'VOICE_EXPIRED', sampleId: 'v1' }] });
  const h = hydrate(rec);
  assert.equal(h.song.composition.idea, 'una cumbia alegre');
  assert.ok(h.notes.some((n) => n.planet === 'voice'));
  assert.match(R.recoveryBlockedReason({ session: session({ detached: true, destination: 'SAME' }), recovery: rec, loading: false, failed: false }), /letra retenida/);
});

test('el botón principal: «Reintentar esta canción» si es un reintento enlazado; el «Crear mi canción» de siempre en cualquier otra vía; sin explicaciones', () => {
  const linked = R.recoveryActionLabels({ session: session(), retryAvailable: true });
  assert.deepEqual(linked, { label: 'Reintentar esta canción' });
  for (const [s, avail] of [[session({ detached: true }), true], [session(), false], [session({ destination: 'OTHER_ORIGIN' }), true]]) {
    assert.deepEqual(R.recoveryActionLabels({ session: s, retryAvailable: avail }), { label: 'Crear mi canción' });
  }
  assert.equal(R.isLinkedRetry(session(), true), true);
  assert.equal(R.isLinkedRetry(session({ detached: true }), true), false);
});

test('recuperar sigue siendo un reintento ENLAZADO por defecto (no se convierte en una generación normal)', () => {
  const rec = recovery();
  const out = R.buildRecoverySubmit({ song: songOf(rec), recovery: rec, session: session(), retryAvailable: true });
  assert.equal(out.kind, 'RETRY');
  assert.equal(out.endpoint, 'POST /generations/:id/retry');
});

test('sin tarjeta permanente: el panel solo muestra lo indispensable y no tiene textos de vínculos ni de intentos', () => {
  const ui = read('src/features/creator/RecoveryUI.tsx');
  for (const gone of ['¡Composición recuperada!', 'Podés seguir editándola', 'Se va a crear como una', 'Crear de forma independiente', 'sin vincular', 'Volver a vincular',
    'Descartar recuperación', 'Seguir con esto como una composición normal', 'onKeepAsNew', 'onDetach', 'onReattach', 'recovery-no-retry', 'Pedir una letra nueva', 'Reutilizamos la letra']) {
    assert.ok(!ui.includes(gone), gone);
  }
  assert.match(ui, /return null; \/\/ nada que decidir ni advertir/, 'sin nada que decidir, no renderiza nada');
  assert.match(ui, /warnings = p\.notes\.filter\(\(n\) => n\.tone === 'warning'\)/, 'solo advertencias, no avisos informativos');
  assert.match(ui, /min-w-0 max-w-full break-words/, 'no desborda');
  assert.match(ui, /whitespace-normal/);
  assert.equal((ui.match(/mb-5 /g) ?? []).length, 1, 'solo el aviso inicial (antes de recuperar) conserva el tamaño de tarjeta');
});

test('la confirmación de haber recuperado es transitoria (toast), no un bloque del layout', () => {
  const w = read('src/features/creator/CreatorWizard.tsx');
  assert.match(w, /toast\(\{ title: '¡Composición recuperada!', description: 'Podés seguir editándola y volver a intentarlo\.' \}\)/);
  assert.ok(!w.includes('detachOpen'), 'no hay diálogo ni opción de desvincular en la interfaz');
  assert.ok(!w.includes('recovery-action-hint'), 'sin explicaciones debajo del botón principal');
});

test('«Empezar de cero» durante una recuperación pide confirmación y no oculta un pedido pendiente', () => {
  const w = read('src/features/creator/CreatorWizard.tsx');
  assert.match(w, /recoveryActive \? setDiscardRecoveryOpen\(true\) : setRestartConfirm\(true\)/);
  // Y al confirmar, «Empezar de cero» reinicia con la animación (restart(true)), tanto desde el aviso de recuperación como desde el diálogo normal.
  assert.match(w, /restart\(true\)/);
  assert.match(w, /disabled=\{recoveryActive && pending !== null\}/);
  assert.match(w, /pendingBlocks=\{pending !== null\}/);
  assert.match(w, /¿Empezar de cero\?/);
  assert.match(w, /no se borra: sigue en tu actividad/);
});

/* ───────── El origen del Remix cambia ENTRE recuperar y enviar (REMIX_ORIGIN_UNAVAILABLE) ───────── */

const remixRec = (status, reason = null) => recovery({
  target: { kind: 'REMIX', status, reason, remix: { songId: 'orig', versionId: 'v1', versionNumber: 1, mode: 'COVER' } },
  destinationOptions: status === 'AVAILABLE' ? ['SAME', 'NEW_SONG'] : ['NEW_SONG'],
  request: { inputs: [{ field: 'IDEA', text: 'más oscuro' }, { field: 'GENRE', value: ['Synthwave'] }], options: {}, title: 'Mi versión' },
});
// Lo que responde el servidor (409 definitivo, sin cobro ni efectos).
const originGone = (reason) => Object.assign(new Error('origen'), { status: 409, details: { code: 'REMIX_ORIGIN_UNAVAILABLE', reason, recovery: { newSong: true }, destinationOptions: ['NEW_SONG'] } });

test('remix · el origen cambia entre recuperar y enviar: se interpreta como «el destino cambió» (con su causa), no como un error genérico', () => {
  for (const reason of ['NOT_ALLOWED', 'NOT_AVAILABLE', 'VERSION_NOT_CURRENT', 'AUDIO_UNAVAILABLE']) {
    const f = R.interpretRetryError(originGone(reason));
    assert.deepEqual(f, { kind: 'TARGET_CHANGED', code: 'REMIX_ORIGIN_UNAVAILABLE', reason });
  }
  assert.match(R.TARGET_CHANGED_TEXT, /destino de la canción cambió/);
  assert.match(R.TARGET_CHANGED_TEXT, /No se cobró nada/);
});

test('remix · el rechazo es DEFINITIVO: no deja un pedido pendiente ni se reintenta a ciegas', async () => {
  const m = new Map();
  const storage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
  const store = P.createPendingStore({ storage, newId: () => 'id-1' });
  const body = { request: { inputs: [{ field: 'IDEA', text: 'x' }], options: {} }, destination: { kind: 'SAME' } };
  const res = await store.submit({ userId: 'u1', intent: 'retry.g1', body, send: async () => { throw originGone('NOT_ALLOWED'); }, endpoint: 'POST /generations/:id/retry' });
  assert.equal(res.kind, 'REJECTED');
  assert.equal(store.load('u1', 'retry.g1'), null, 'sin pedido pendiente: no hay nada que confirmar');
  assert.equal(P.classifyError(originGone('NOT_AVAILABLE')), 'REJECTED');
});

test('remix · tras el rechazo el destino se vuelve a decidir: nunca se envía solo ni se convierte en canción nueva en silencio', () => {
  const before = remixRec('AVAILABLE');
  // 1) con el origen vigente se enviaba como reintento enlazado al mismo origen
  const first = R.buildRecoverySubmit({ song: songOf(before), recovery: before, session: session(), retryAvailable: true });
  assert.equal(first.kind, 'RETRY');
  assert.deepEqual(first.body.destination, { kind: 'SAME' });
  // 2) el servidor rechaza; el creador borra la elección y vuelve a leer la recuperación (ahora con el origen no disponible)
  const after = remixRec('UNAVAILABLE', 'NOT_ALLOWED');
  const reset = session({ destination: null });
  assert.equal(R.effectiveDestination(reset, after), null, 'falta decidir');
  assert.equal(R.buildRecoverySubmit({ song: songOf(after), recovery: after, session: reset, retryAvailable: true }).kind, 'BLOCKED');
  assert.match(R.recoveryBlockedReason({ session: reset, recovery: after, loading: false, failed: false }), /destino/);
  const d = R.describeTarget(after);
  assert.equal(d.needsDecision, true);
  assert.deepEqual(d.options, ['NEW_SONG', 'OTHER_ORIGIN']);
  assert.match(d.summary, /dejó de permitir remixes/);
});

test('remix · salida a canción nueva: el pedido ya no lleva el origen ni nada que dependa de él, y pide confirmación explícita', () => {
  const after = remixRec('UNAVAILABLE', 'NOT_ALLOWED');
  const s = session({ destination: 'NEW_SONG' });
  const out = R.buildRecoverySubmit({ song: songOf(after), recovery: after, session: s, retryAvailable: true });
  assert.equal(out.kind, 'RETRY');
  assert.deepEqual(out.body.destination, { kind: 'NEW_SONG', confirm: true });
  const text = JSON.stringify(out.body);
  for (const gone of ['remix', 'REMIX_SOURCE', 'AUDIO_WEIGHT', 'REFERENCE_SAMPLE', 'songId']) assert.ok(!text.includes(gone), `no viaja «${gone}»`);
  assert.equal(out.body.request.title, 'Mi versión', 'se conservan los ajustes reutilizables');
});

test('remix · elegir OTRO origen válido: creación normal hacia ese origen, sin retryOf; la intención es la del remix y no la del reintento', () => {
  const after = remixRec('UNAVAILABLE', 'NOT_ALLOWED');
  const s = session({ destination: 'OTHER_ORIGIN', otherOrigin: { songId: 'otro', versionId: null, mode: 'COVER' } });
  const out = R.buildRecoverySubmit({ song: songOf(after), recovery: after, session: s, retryAvailable: true });
  assert.equal(out.kind, 'PLAIN');
  assert.equal(out.endpoint, 'POST /generations');
  assert.equal(out.body.remix.songId, 'otro');
  assert.equal(out.body.retryOf, undefined);
  assert.equal(out.intent, P.intentKey({ remixSongId: 'otro', remixMode: 'COVER' }));
  assert.notEqual(out.intent, 'retry.g1');
});

test('remix · el creador reacciona al rechazo: borra el destino, vuelve a leer la recuperación y explica (sin tocar la composición)', () => {
  const w = read('src/features/creator/CreatorWizard.tsx');
  const handler = w.slice(w.indexOf("case 'TARGET_CHANGED':"), w.indexOf('default:', w.indexOf("case 'TARGET_CHANGED':")));
  assert.match(handler, /rec\.chooseDestination\(null\)/);
  assert.match(handler, /rec\.refetchRecovery\(\)/);
  assert.match(handler, /TARGET_CHANGED_TEXT/);
  assert.ok(!/setNormalSong|restart\(/.test(handler), 'la composición del usuario se conserva');
  assert.match(w, /handleRetryRejection\(err\)/, 'se usa tanto al enviar como al confirmar un pedido pendiente');
  assert.match(w, /handleRetryRejection\(res\.error\)/);
});

/* ───────── Remix de otra persona con el origen no autorizado: recuperación BLOQUEADA por completo ───────── */

const blockedGen = (over = {}) => gen({ retry: { allowed: false, reason: 'REMIX_ORIGIN_BLOCKED', requiresEdit: false }, ...over });

test('bloqueo · los textos acordados, exactos', () => {
  assert.equal(R.REMIX_BLOCKED_TITLE, 'Este Remix ya no se puede recuperar');
  assert.equal(R.REMIX_BLOCKED_DESCRIPTION, 'La canción original o la versión utilizada ya no está disponible para Remix. Para respetar los permisos del autor, esta generación no puede recuperarse.');
});

test('bloqueo · el servidor lo informa con retry.reason; «Recuperar» se oculta y vuelve a aparecer si el origen se autoriza otra vez', () => {
  assert.equal(R.isRemixBlocked(blockedGen()), true);
  assert.equal(R.canRecoverFromHistory(blockedGen()), false);
  assert.equal(R.canRecoverFromHistory(gen()), true, 'sin la marca, recuperable como siempre');
  assert.equal(R.canRecoverFromHistory(gen({ retry: { allowed: true, reason: null, requiresEdit: false } })), true, 'autorizado de nuevo: reaparece');
  assert.equal(R.canRecoverFromHistory(blockedGen({ status: 'COMPLETED' })), false);
});

test('bloqueo · el aviso de entrada al creador no ofrece un Remix bloqueado', () => {
  assert.equal(R.pickRecoveryCandidate([blockedGen()], {}, NOW), null);
  assert.equal(R.pickRecoveryCandidate([gen()], {}, NOW)?.id, 'g1');
});

test('bloqueo · el rechazo del reintento se interpreta como «no recuperable» con su causa (también el definitivo de la red)', () => {
  const err = Object.assign(new Error('x'), { status: 409, details: { code: 'GENERATION_NOT_RETRYABLE', reason: 'REMIX_ORIGIN_BLOCKED' } });
  assert.deepEqual(R.interpretRetryError(err), { kind: 'NOT_RETRYABLE', reason: 'REMIX_ORIGIN_BLOCKED' });
  assert.equal(P.classifyError(err), 'REJECTED', 'sin pedido pendiente: no hay nada que confirmar');
});

test('bloqueo · pantalla compacta con SOLO dos acciones; no ofrece canción nueva ni otro origen ni carga planetas', () => {
  const ui = read('src/features/creator/RecoveryUI.tsx');
  const screen = ui.slice(ui.indexOf('export function RecoveryBlocked'), ui.indexOf('/* ───────────── Lo indispensable'));
  assert.match(screen, /REMIX_BLOCKED_TITLE/);
  assert.match(screen, /REMIX_BLOCKED_DESCRIPTION/);
  assert.match(screen, />Volver a Mi actividad</);
  assert.match(screen, />Crear canción desde cero</);
  assert.equal((screen.match(/<Button/g) ?? []).length, 2, 'exactamente dos acciones');
  for (const gone of ['Crear una canción nueva', 'Elegir otro origen', 'Conservar como mía', 'Restaurar']) assert.ok(!screen.includes(gone), gone);
  assert.ok(!/recovery\.request|hydration|songFromRecovery/.test(screen), 'no usa datos de la generación bloqueada');
});

test('bloqueo · el creador: ante el bloqueo cierra la recuperación y delega qué se limpia en el helper probado (tests/recovery-block.test.mjs)', () => {
  const w = read('src/features/creator/CreatorWizard.tsx');
  const fn = w.slice(w.indexOf('const blockRecovery = () => {'), w.indexOf('/** ¿El Remix de la recuperación dejó de estar autorizado?'));
  assert.match(fn, /discardBlockedRecovery\(/);
  assert.match(fn, /rec\.end\('DISMISSED'\)/);
  assert.ok(!/generationApi\.|songsApi\.|\.remove|\.delete/.test(fn), 'no borra nada del servidor');
  // se dispara al entrar (recuperación) y al reintentar (la revocación llegó mientras se editaba)
  assert.match(w, /rec\.problem\?\.kind === 'not-retryable' && rec\.problem\.reason === REMIX_BLOCKED_REASON/);
  assert.match(w, /if \(f\.reason === REMIX_BLOCKED_REASON\) \{ blockRecovery\(\); return true; \}/);
  // pantalla de bloqueo ANTES del creador (sin planetas) y sus dos salidas
  assert.ok(w.indexOf('<RecoveryBlocked') < w.indexOf('const current = openPlanet'), 'se muestra antes de armar el creador');
  assert.match(w, /navigate\('\/profile\/activity'\)/);
  assert.match(w, /onFresh=\{\(\) => setRemixBlocked\(null\)\}/);
});

test('bloqueo · sin reintento enlazado (creación normal) y reintento apagado: se vuelve a consultar la recuperación y, si quedó bloqueada, se bloquea', () => {
  const w = read('src/features/creator/CreatorWizard.tsx');
  const fn = w.slice(w.indexOf('const checkRemixBlocked = async () => {'), w.indexOf('/* eslint-disable react-hooks/set-state-in-effect */', w.indexOf('const checkRemixBlocked = async () => {')));
  assert.match(fn, /rec\.recovery\?\.target\.kind !== 'REMIX'/, 'solo para recuperaciones de Remix');
  assert.match(fn, /rec\.refetchRecovery\(\)/);
  assert.match(fn, /blockRecovery\(\)/);
  assert.match(w, /if \(recoveryActive\) void checkRemixBlocked\(\);/, 'tras un rechazo de la creación normal');
  assert.match(w, /void checkRemixBlocked\(\); \/\/ sin reintento enlazado/, 'al descubrir que el reintento está apagado');
});

