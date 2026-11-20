// Textos de cobros y reintegros en el seguimiento de pedidos sin confirmar (E1): exactos y solo donde corresponden.
// Ejecutar: node --test "tests/*.test.mjs"
import './_helpers/register-ts-resolve.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const C = await import('../src/features/creator/pending-copy.ts');
const root = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const norm = (s) => s.replace(/\s+/g, ' ').toLowerCase();

const PROMESA_DE_REINTEGRO = /te las devolvemos|devolvemos autom|vuelven a tu saldo|te devolvimos/i;

test('resultado incierto: dice que el pedido pudo aceptarse, que se confirma desde el estudio y que no hay segundo cobro', () => {
  const t = norm(C.UNCERTAIN_SUBMIT_TEXT);
  assert.match(t, /puede que ya se haya aceptado/);
  assert.match(t, /confirmalo desde el estudio/);
  assert.match(t, /mismo pedido/);
  assert.match(t, /no se cobra una segunda vez/);
});

test('resultado incierto: NO promete ningún reintegro (el cobro puede ser legítimo)', () => {
  for (const s of [C.UNCERTAIN_SUBMIT_TEXT, C.UNCERTAIN_TITLE, C.UNCERTAIN_ACTION]) {
    assert.ok(!PROMESA_DE_REINTEGRO.test(s), s);
  }
  assert.ok(!/no pudimos generar tu canción/i.test(C.UNCERTAIN_TITLE), 'tampoco afirma que la generación falló');
});

test('«Descartar»: aclara que NO cancela una generación aceptada, NO devuelve fichas y que otra generación podría cobrarse de nuevo', () => {
  const t = norm(C.DISCARD_DESCRIPTION);
  assert.match(t, /solo borra el seguimiento de este pedido en este dispositivo/);
  assert.match(t, /no cancela una generación que ya se haya aceptado/);
  assert.match(t, /no devuelve las fichas/);
  assert.match(t, /segunda vez/);
  assert.match(t, /revis[aá] tu actividad/);
  assert.ok(C.DISCARD_TITLE.length > 0);
});

test('la pantalla de error genérica ya no promete un reintegro universal', () => {
  const src = read('src/features/creator/GenerationStatus.tsx');
  assert.ok(!src.includes('Si se cobraron fichas'), 'la frase genérica se eliminó');
  assert.ok(!src.includes('te las devolvemos automáticamente'));
  // la pantalla de error usa el título y la acción del resultado incierto solo cuando corresponde
  assert.match(src, /state\.uncertain \? UNCERTAIN_TITLE : 'No pudimos generar tu canción'/);
  assert.match(src, /state\.uncertain \? UNCERTAIN_ACTION : 'Intentar de nuevo'/);
});

test('el aviso de reintegro automático sigue SOLO donde corresponde: generación terminada en FAILED (o cancelada)', () => {
  const src = read('src/features/creator/GenerationStatus.tsx');
  assert.match(src, /note=\{gen\?\.status === 'FAILED' \? 'Las fichas vuelven a tu saldo automáticamente\.' : undefined\}/);
  assert.match(src, /gen\?\.status === 'CANCELED'\s*\? 'Las fichas vuelven a tu saldo automáticamente\.'/);
  // y no aparece en la rama de error de envío (phase === 'error')
  const errorBranch = src.slice(src.indexOf("if (state.phase === 'error')"), src.indexOf("if (state.phase === 'done'"));
  assert.ok(!PROMESA_DE_REINTEGRO.test(errorBranch), 'la rama de error de envío no menciona reintegros');
});

test('el creador marca el resultado incierto y usa los textos del módulo (sin copias sueltas)', () => {
  const src = read('src/features/creator/CreatorWizard.tsx');
  assert.match(src, /message: UNCERTAIN_SUBMIT_TEXT, canRetry: true, uncertain: true/);
  assert.match(src, /<AlertDialogDescription>\{DISCARD_DESCRIPTION\}<\/AlertDialogDescription>/);
  assert.ok(!/const UNCERTAIN_SUBMIT_TEXT/.test(src), 'sin una segunda definición del mensaje');
  assert.ok(!PROMESA_DE_REINTEGRO.test(src.slice(src.indexOf('onUncertain'), src.indexOf('onUncertain') + 400)), 'onUncertain no promete reintegro');
});

test('los rechazos definitivos conservan su propio texto «No se descontaron fichas» (no se cobró nada)', () => {
  const src = read('src/features/creator/CreatorWizard.tsx');
  assert.match(src, /VOICE_EXPIRED_TEXT\} No se descontaron fichas\./);
  assert.match(src, /BLOCKED_TEXT\[kind\]\} No se descontaron fichas\./);
});
