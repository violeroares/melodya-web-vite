// Mensaje que ve el usuario cuando una generación falla. Ejecutar: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { generationFailureMessage, GENERIC_FAILURE_MESSAGE } = await import('../src/lib/generation-failure.ts');

test('usa el userMessage del backend tal cual', () => {
  const userMessage = 'No pudimos generar la canción porque el audio de referencia coincide con una grabación existente en nuestro catálogo. Probá con otro audio.';
  assert.equal(generationFailureMessage({ code: 'GENERATION_FAILED', message: userMessage, reasonCode: 'REFERENCE_AUDIO_MATCHES_CATALOG', userMessage }), userMessage);
});

test('respuesta ANTIGUA (solo code/message): mensaje general, nunca el message crudo del proveedor', () => {
  const raw = 'Uploaded audio contains copyrighted lyrics';
  assert.equal(generationFailureMessage({ code: 'GENERATION_FAILED', message: raw }), GENERIC_FAILURE_MESSAGE);
  assert.doesNotMatch(generationFailureMessage({ code: 'GENERATION_FAILED', message: 'Suno createTask falló (code 401): IP whitelist' }), /whitelist|Suno|401/);
});

test('sin error, null, userMessage vacío o de tipo inesperado: mensaje general', () => {
  for (const e of [undefined, null, {}, { userMessage: '' }, { userMessage: '   ' }, { userMessage: 42 }]) {
    assert.equal(generationFailureMessage(e), GENERIC_FAILURE_MESSAGE);
  }
  assert.match(GENERIC_FAILURE_MESSAGE, /Podés volver a intentarlo en unos minutos/);
});

test('las pantallas que muestran el fallo usan el selector (no el toast fijo ni error.message)', () => {
  const status = fs.readFileSync(new URL('../src/features/creator/GenerationStatus.tsx', import.meta.url), 'utf8');
  const shell = fs.readFileSync(new URL('../src/components/layout/AppShell.tsx', import.meta.url), 'utf8');
  assert.match(status, /generationFailureMessage\(/);
  assert.match(shell, /generationFailureMessage\(ev\.payload\.error\)/);
  assert.doesNotMatch(status, /error\??\.message/);
  assert.doesNotMatch(shell, /payload\.error\??\.message/);
});
