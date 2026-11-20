// Pantalla «¡Tu canción está lista!» (src/features/creator/GenerationStatus.tsx): una sola acción para escuchar.
// Ejecutar: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../src/features/creator/GenerationStatus.tsx', import.meta.url), 'utf8');
const done = src.slice(src.indexOf("state.phase === 'done'"), src.indexOf('const failed'));

test('queda un solo punto de escucha: el círculo «Escuchar», que navega al detalle', () => {
  assert.match(done, /<GenerationArt mode="done" onListen=\{state\.songId \? \(\) => navigate\(`\/songs\/\$\{state\.songId\}`\) : undefined\} \/>/);
  assert.equal((done.match(/navigate\(/g) ?? []).length, 1, 'solo el círculo navega al detalle');
  assert.doesNotMatch(src, /Escuchar mi canción/);
  assert.doesNotMatch(src, /DonePlayer|Reproducir|Sonando…/);
});

test('«Crear otra» no depende de que exista songId', () => {
  assert.match(done, /Crear otra/);
  assert.doesNotMatch(done, /state\.songId &&/);
});
