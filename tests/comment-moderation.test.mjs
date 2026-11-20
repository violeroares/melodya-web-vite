// Moderación de comentarios en la web: la DECISIÓN es del backend; la web solo conserva el texto, informa el rechazo y evita envíos duplicados.
// Este archivo es IDÉNTICO en melodya_web (Next.js) y melodya.web-vite (Vite): fija el mismo comportamiento en las dos.
// Ejecutar: node --test "tests/*.test.mjs"
import './_helpers/register-ts-resolve.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const M = await import('../src/lib/comment-moderation.ts');
const { ApiError } = await import('../src/lib/api/client.ts');
const { toUserMessage } = await import('../src/lib/errors.ts');

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const REJECTED = new ApiError(422, 'COMMENT_REJECTED', 'Tu comentario no cumple las normas de la comunidad. Modificalo y volvé a enviarlo.');

/* ── Clasificación del error ─────────────────────────────────────────────── */

test('COMMENT_REJECTED (422) se reconoce como rechazo y conserva el mensaje del backend', () => {
  assert.equal(M.COMMENT_REJECTED_CODE, 'COMMENT_REJECTED');
  assert.equal(M.isCommentRejected(REJECTED), true);
  assert.deepEqual(M.classifyCommentFailure(REJECTED, toUserMessage), { kind: 'rejected', message: REJECTED.message });
});

test('un rechazo sin mensaje usa el texto por defecto (nunca queda vacío)', () => {
  for (const message of ['', '   ']) {
    const err = new ApiError(422, 'COMMENT_REJECTED', message);
    assert.deepEqual(M.classifyCommentFailure(err, toUserMessage), { kind: 'rejected', message: M.COMMENT_REJECTED_FALLBACK });
  }
  assert.match(M.COMMENT_REJECTED_FALLBACK, /normas de la comunidad/);
  assert.equal(M.classifyCommentFailure({ code: 'COMMENT_REJECTED' }, toUserMessage).kind, 'rejected');
});

test('cualquier otra falla NO es un rechazo: sigue el camino de siempre (toast con el mensaje amable)', () => {
  const others = [
    new ApiError(429, 'RATE_LIMITED', 'Estás comentando muy rápido'),
    new ApiError(422, 'UNPROCESSABLE', 'Datos inválidos', { code: 'INVALID_PARENT' }),
    new ApiError(403, 'FORBIDDEN', 'Los comentarios están desactivados para esta canción'),
    new ApiError(500, 'INTERNAL', 'Error interno'),
    new ApiError(503, 'SERVICE_UNAVAILABLE', 'Servicio no disponible'),
    new ApiError(0, 'NETWORK', 'No pudimos conectar con Melodya.'),
    new Error('boom'), null, undefined, 'COMMENT_REJECTED',
  ];
  for (const err of others) {
    assert.equal(M.isCommentRejected(err), false, String(err?.code ?? err));
    const out = M.classifyCommentFailure(err, toUserMessage);
    assert.equal(out.kind, 'error');
    assert.equal(out.message, toUserMessage(err));
  }
});

test('toUserMessage traduce COMMENT_REJECTED y el 429 de comentarios con mensajes amables (nada técnico)', () => {
  assert.match(toUserMessage(REJECTED), /normas de la comunidad/);
  assert.match(toUserMessage(new ApiError(429, 'RATE_LIMITED', 'x')), /muy rápido/);
});

/* ── Envío único ─────────────────────────────────────────────────────────── */

test('canSubmitComment: con texto y sin otro envío en curso (evita duplicados con el botón y con Enter)', () => {
  assert.equal(M.canSubmitComment('hola', false), true);
  assert.equal(M.canSubmitComment('  hola  ', false), true);
  assert.equal(M.canSubmitComment('hola', true), false, 'mientras se valida no se envía otro');
  assert.equal(M.canSubmitComment('', false), false);
  assert.equal(M.canSubmitComment('   \n ', false), false);
});

test('el aviso «Revisando…» espera un poco para no parpadear con respuestas rápidas', () => {
  assert.ok(M.COMMENT_CHECKING_DELAY_MS >= 300 && M.COMMENT_CHECKING_DELAY_MS <= 1500);
});

/* ── Cableado en la pantalla (comentarios y respuestas comparten el mismo compositor) ────────────── */

test('SongDetailView: carga, un solo envío, rechazo con el texto conservado y respuestas por el mismo camino', () => {
  const src = read('src/features/song/SongDetailView.tsx');
  assert.match(src, /from '@\/lib\/comment-moderation'/);
  // un solo envío: el submit (Enter o botón) consulta canSubmitComment con el estado de la mutación
  assert.match(src, /if \(!canSubmitComment\(draft, addMutation\.isPending\)\) return;/);
  assert.match(src, /disabled=\{!canSubmitComment\(draft, addMutation\.isPending\)\}/);
  assert.match(src, /readOnly=\{addMutation\.isPending\}/);
  // indicador de carga y aviso
  assert.match(src, /addMutation\.isPending \? <Loader2 className="h-4 w-4 animate-spin"/);
  assert.match(src, /Revisando tu comentario…/);
  // el rechazo muestra el mensaje junto al editor y NO limpia el texto: el borrador solo se limpia en onSuccess
  assert.match(src, /classifyCommentFailure\(err, toUserMessage\)/);
  assert.match(src, /failure\.kind === 'rejected'/);
  const onError = src.slice(src.indexOf('const failure = classifyCommentFailure'), src.indexOf('const removeMutation'));
  assert.doesNotMatch(onError, /setDraft\(''\)/);
  assert.doesNotMatch(onError, /setReplyTo\(null\)/);
  const onSuccess = src.slice(src.indexOf('onSuccess: async () => {'), src.indexOf('onError: (err) => {'));
  assert.match(onSuccess, /setDraft\(''\)/);
  assert.match(onSuccess, /setReplyTo\(null\)/);
  // comentarios y respuestas: la misma mutación, con parentId
  assert.match(src, /addMutation\.mutate\(\{ content: draft\.trim\(\), parentId: replyTo\?\.id \}\)/);
  assert.equal((src.match(/songsApi\.addComment\(/g) ?? []).length, 1, 'un único camino de envío para comentarios y respuestas');
});

test('la web no duplica la lógica de moderación: no clasifica, no filtra palabras ni llama a ningún modelo', () => {
  const src = read('src/features/song/SongDetailView.tsx') + read('src/lib/comment-moderation.ts');
  assert.doesNotMatch(src, /ollama|openrouter|gpt-oss|reasoning|boludo|pelotudo|insult|moderation\/|\/moderation/i);
  assert.doesNotMatch(read('src/lib/api/index.ts'), /moderation/i, 'no hay endpoints de moderación en el cliente');
});
