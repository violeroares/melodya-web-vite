// Pantalla «¡Tu canción está lista!» (src/features/creator/GenerationStatus.tsx): una sola acción para escuchar.
// Ejecutar: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../src/features/creator/GenerationStatus.tsx', import.meta.url), 'utf8');
// El bloque que dibuja la pantalla «lista». Se ancla en su `if` completo: `state.phase === 'done'` también aparece antes (el seguimiento REST), así que
// buscar solo esa frase abarcaba código ajeno a la pantalla.
const done = src.slice(src.indexOf("if (state.phase === 'done' && gen?.status === 'COMPLETED')"), src.indexOf('const failed'));

test('queda un solo punto de escucha: el círculo «Escuchar», que navega al detalle', () => {
  // `size="sm"` es la medida del rediseño (arte de 200 px); lo que importa es que el círculo «Escuchar» sea el único acceso y navegue al detalle.
  assert.match(done, /<GenerationArt mode="done" size="sm" onListen=\{state\.songId \? \(\) => navigate\(`\/songs\/\$\{state\.songId\}`\) : undefined\} \/>/);
  assert.equal((done.match(/navigate\(/g) ?? []).length, 1, 'solo el círculo navega al detalle');
  assert.doesNotMatch(src, /Escuchar mi canción/);
  assert.doesNotMatch(src, /DonePlayer|Reproducir|Sonando…/);
});

test('«Crear otra» no depende de que exista songId', () => {
  assert.match(done, /Crear otra/);
  assert.doesNotMatch(done, /state\.songId &&/);
});
