// Descarga en WAV en la web: qué ofrece el menú según plan y estado de la conversión, y el pedido al backend.
// Ejecutar: node --test "tests/*.test.mjs"  (sin dependencias nuevas; Node 24 carga .ts directamente).
import test from 'node:test';
import assert from 'node:assert/strict';

const C = await import('../src/lib/capabilities.ts');
const G = await import('../src/lib/plan-gate.ts');
const A = await import('../src/lib/audio-download.ts');
const { wavMenuState, hasWavInProgress, newlyReadyWavs, isLocked, LOCK_REASON } = C;

const entry = (enabled, enforced) => ({ enabled, enforced });
const proEnt = { DOWNLOAD_WAV: entry(true, true) };
const creatorEnt = { DOWNLOAD_WAV: entry(false, true) };
const allowed = { allowed: true, reason: null, lock: null };
const wav = (status, extra = {}) => ({ status, retryable: status === 'FAILED', ...extra });

test('Free y Creator (capacidad exigida y no incluida): el WAV queda bloqueado con el aviso de upgrade, aunque exista y esté listo', () => {
  for (const ent of [creatorEnt, { DOWNLOAD_WAV: entry(false, true) }]) {
    for (const status of ['COMPLETED', 'PROCESSING', 'FAILED', 'NONE']) {
      const s = wavMenuState(ent, wav(status), allowed);
      assert.equal(s.kind, 'locked', status);
      assert.equal(s.disabled, false, 'sigue siendo clicable: abre el aviso de upgrade, no descarga');
      assert.equal(s.title, LOCK_REASON.DOWNLOAD_WAV);
    }
  }
});

test('Pro: WAV listo → descargar inmediatamente; mismo criterio de «exigida» que el resto (si el servidor no la exige, no se bloquea)', () => {
  const ready = wavMenuState(proEnt, wav('COMPLETED'), allowed);
  assert.deepEqual([ready.kind, ready.label, ready.disabled], ['ready', 'Descargar WAV', false]);
  assert.equal(isLocked({ DOWNLOAD_WAV: entry(false, false) }, 'DOWNLOAD_WAV'), false, 'modo off/shadow: no se bloquea');
  assert.equal(wavMenuState({ DOWNLOAD_WAV: entry(false, false) }, wav('COMPLETED'), allowed).kind, 'ready');
  assert.equal(wavMenuState(null, wav('COMPLETED'), allowed).kind, 'ready', 'sin capacidades cargadas decide el servidor');
});

test('en preparación SIN intento del usuario: se ofrece esperar la existente (no pedir otra); con intento: progreso sin acción (sin doble clic)', () => {
  for (const status of ['PENDING', 'PROCESSING']) {
    const wait = wavMenuState(proEnt, wav(status), allowed);
    assert.deepEqual([wait.kind, wait.label, wait.disabled, wait.busy], ['waitable', 'Descargar WAV cuando esté listo', false, false], status);
    for (const [phase, kind, label] of [['requesting', 'preparing', 'Pidiendo el WAV…'], ['preparing', 'preparing', 'Preparando WAV…'], ['downloading', 'downloading', 'Descargando WAV…']]) {
      const s = wavMenuState(proEnt, wav(status), allowed, phase);
      assert.deepEqual([s.kind, s.label, s.disabled, s.busy], [kind, label, true, true], `${status}/${phase}`);
    }
  }
});

test('el indicador acompaña TODO el intento (aunque el estado del servidor aún no esté cargado o ya esté listo) y no tapa el bloqueo comercial', () => {
  assert.equal(wavMenuState(proEnt, undefined, allowed, 'preparing').busy, true);
  assert.equal(wavMenuState(proEnt, wav('COMPLETED'), allowed, 'downloading').busy, true);
  assert.equal(wavMenuState(proEnt, wav('COMPLETED'), allowed).busy, false);
  assert.equal(wavMenuState(creatorEnt, wav('PROCESSING'), allowed, 'preparing').kind, 'locked', 'sin capacidad manda el aviso de upgrade');
  for (const ent of [proEnt, creatorEnt]) for (const status of ['NONE', 'FAILED', 'COMPLETED']) assert.equal(wavMenuState(ent, wav(status), allowed).busy, false, status);
});

test('fallido: informa y permite reintentar solo si el servidor lo permite; sin conversión: permite prepararla', () => {
  const failed = wavMenuState(proEnt, wav('FAILED', { message: 'El archivo WAV es demasiado grande para guardarlo.' }), allowed);
  assert.deepEqual([failed.kind, failed.label, failed.disabled, failed.title], ['failed', 'Reintentar WAV', false, 'El archivo WAV es demasiado grande para guardarlo.']);
  const final = wavMenuState(proEnt, { status: 'FAILED', retryable: false, message: 'Contactá a soporte.' }, allowed);
  assert.deepEqual([final.kind, final.label, final.disabled, final.title], ['failed', 'WAV no disponible', true, 'Contactá a soporte.'], 'sin reintento posible no se ofrece «Reintentar»');
  const none = wavMenuState(proEnt, wav('NONE'), allowed);
  assert.deepEqual([none.kind, none.label, none.disabled], ['missing', 'Preparar WAV', false]);
  assert.match(none.title, /primera vez.*unos minutos/, 'avisa que la primera descarga requiere una espera');
});

test('sin el estado cargado no se ofrece nada; con el cupo de descargas agotado y exigido, el WAV listo no se puede pedir (motivo visible)', () => {
  assert.equal(wavMenuState(proEnt, undefined, allowed).kind, 'unknown');
  assert.equal(wavMenuState(proEnt, undefined, allowed).disabled, true);
  const quota = wavMenuState(proEnt, wav('COMPLETED'), { allowed: false, reason: 'Usaste las 60 descargas de tu plan en este período.', lock: 'quota' });
  assert.deepEqual([quota.kind, quota.disabled, quota.title], ['quota', true, 'Usaste las 60 descargas de tu plan en este período.']);
  // El cupo no tapa el bloqueo comercial: sin capacidad manda el aviso de upgrade.
  assert.equal(wavMenuState(creatorEnt, wav('COMPLETED'), { allowed: false, reason: 'x', lock: 'quota' }).kind, 'locked');
});

test('polling y aviso: se vuelve a consultar solo mientras haya un WAV en curso y se avisa una vez cuando queda listo', () => {
  assert.equal(hasWavInProgress([{ wav: wav('COMPLETED') }, { wav: wav('PROCESSING') }]), true);
  assert.equal(hasWavInProgress([{ wav: wav('COMPLETED') }, { wav: wav('FAILED') }, {}]), false);
  assert.equal(hasWavInProgress(undefined), false);
  const prev = new Map([['a', 'PROCESSING'], ['b', 'COMPLETED'], ['c', 'PENDING']]);
  const ready = newlyReadyWavs(prev, [{ id: 'a', wav: wav('COMPLETED') }, { id: 'b', wav: wav('COMPLETED') }, { id: 'c', wav: wav('PENDING') }, { id: 'd', wav: wav('COMPLETED') }]);
  assert.deepEqual(ready.map((v) => v.id), ['a'], 'solo la que pasó de en curso a lista; no las que ya estaban listas ni las nuevas');
});

test('el texto de la funcionalidad y el nombre del archivo: el WAV se descarga con extensión .wav según el Content-Type real', () => {
  assert.equal(G.FEATURE_NAME.DOWNLOAD_WAV, 'Descargar tus canciones en WAV');
  assert.equal(G.upgradeCopy('DOWNLOAD_WAV', [{ code: 'pro', name: 'Pro', priceCents: 1000, entitlements: { DOWNLOAD_WAV: { enabled: true } } }, { code: 'creator', name: 'Creator', priceCents: 500, entitlements: { DOWNLOAD_WAV: { enabled: false } } }]).planLabel, 'Pro', 'el plan requerido sale del catálogo (solo Pro)');
  assert.equal(A.downloadFilename('Mi canción', 'audio/wav'), 'Mi canción.wav');
  assert.equal(A.downloadFilename('Mi canción', 'audio/x-wav'), 'Mi canción.wav');
  assert.equal(A.downloadFilename('Mi canción', 'audio/mpeg'), 'Mi canción.mp3');
});
