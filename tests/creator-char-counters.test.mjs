// Contadores de caracteres de los editores de «Estilo», «Tu idea» y «Título» (src/features/creator/PlanetEditors.tsx).
// Ejecutar: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { styleUsage, LIMITS } = await import('../src/features/creator/song-model.ts');
const editors = fs.readFileSync(new URL('../src/features/creator/PlanetEditors.tsx', import.meta.url), 'utf8');
const style = (genres, description) => ({ genres, description });

test('styleUsage: géneros + descripción comparten el presupuesto y quedan N', () => {
  const u = styleUsage(style(['rock', 'pop'], 'voz suave'));
  assert.equal(u.text, 'rock, pop, voz suave');
  assert.equal(u.used, 20);
  assert.equal(u.limit, LIMITS.styleBudget);
  assert.equal(u.remaining, LIMITS.styleBudget - 20);
  assert.equal(u.over, 0);
});

test('styleUsage: justo en el límite no sobra nada; un carácter más sobra 1', () => {
  const exact = styleUsage(style([], 'x'.repeat(LIMITS.styleBudget)));
  assert.equal(exact.remaining, 0);
  assert.equal(exact.over, 0);
  const over = styleUsage(style([], 'x'.repeat(LIMITS.styleBudget + 1)));
  assert.equal(over.over, 1);
  assert.equal(over.remaining, -1);
});

test('styleUsage: un género ya nombrado en la descripción no se cuenta dos veces', () => {
  const u = styleUsage(style(['rock'], 'un rock potente'));
  assert.equal(u.text, 'un rock potente');
  assert.deepEqual(u.omitted, ['rock']);
});

test('Estilo: el contador muestra usados/límite y «quedan N», o «sobran N» al excederse', () => {
  assert.match(editors, /Géneros \+ descripción: \{usage\.used\}\/\{usage\.limit\} caracteres/);
  assert.match(editors, /usage\.over > 0 \? ` · sobran \$\{usage\.over\}: acortá la descripción o quitá géneros` : ` · quedan \$\{usage\.remaining\}`/);
});

test('Tu idea: contador n/límite debajo del campo, que se marca al llegar al máximo', () => {
  assert.equal(LIMITS.idea, 2000);
  assert.match(editors, /\{c\.idea\.length\}\/\{LIMITS\.idea\} caracteres/);
  assert.match(editors, /c\.idea\.length >= LIMITS\.idea \? 'font-semibold text-destructive'/);
});

test('Título: el contador n/límite se muestra siempre y se marca solo al pasarse', () => {
  assert.match(editors, /aria-describedby="song-title-help"/);
  assert.match(editors, /\{c\.title\.trim\(\)\.length\}\/\{LIMITS\.title\}/);
  assert.doesNotMatch(editors, /c\.titleFromLyrics \|\| c\.title\.trim\(\)\.length > LIMITS\.title/, 'ya no depende de excederse para mostrarse');
});
