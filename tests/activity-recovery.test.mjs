// Mi actividad: acciones de recuperación de las generaciones (Recuperar, Remix no disponible, título heredado). Dependen de la pantalla de Mi actividad.
// Ejecutar: node --test "tests/*.test.mjs"
import './_helpers/register-ts-resolve.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const R = await import('../src/features/creator/recovery-model.ts');

const root = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const gen = (over = {}) => ({ id: 'g1', status: 'FAILED', generationTypes: ['MUSIC'], createdAt: '2026-11-11T12:00:00.000Z', retriedBy: null, ...over });
const blockedGen = (over = {}) => gen({ retry: { allowed: false, reason: 'REMIX_ORIGIN_BLOCKED', requiresEdit: false }, ...over });

test('Mi actividad: ofrece «Recuperar» solo según canRecoverFromHistory y navega al creador con el id', () => {
  const p = read('src/features/activity/ActivityHistory.tsx');
  assert.match(p, /canRecoverFromHistory\(g\)/);
  assert.match(p, /\/create\?recover=\$\{g\.id\}/);
  assert.match(p, /Ya se volvió a intentar/);
});

test('bloqueo · Mi actividad: «Remix no disponible» en lugar de «Recuperar»; el historial y los movimientos quedan', () => {
  const a = read('src/features/activity/ActivityHistory.tsx');
  assert.match(a, /Remix no disponible/);
  assert.match(a, /remixBlocked = g\.status === 'FAILED' && isRemixBlocked\(g\)/);
  assert.match(a, /canRecoverFromHistory\(g\)/);
  assert.match(a, /No se completó/, 'la fila y su estado se conservan');
});

test('Mi actividad · un Remix bloqueado no muestra el título heredado; el resto de las generaciones sigue mostrando el suyo', () => {
  assert.equal(R.activityTitleOf(blockedGen({ requestedTitle: 'Luces de Neón' })), null);
  assert.equal(R.activityTitleOf(blockedGen({ requestedTitle: 'Luces de Neón', song: { title: 'Otro' } })), null);
  assert.equal(R.activityTitleOf(gen({ requestedTitle: 'Mi canción' })), 'Mi canción');
  assert.equal(R.activityTitleOf(gen({ requestedTitle: 'Viejo', song: { title: 'Nombre actual' } })), 'Nombre actual');
  assert.equal(R.activityTitleOf(gen({ requestedTitle: null })), null);
  const a = read('src/features/activity/ActivityHistory.tsx');
  assert.match(a, /const title = activityTitleOf\(g\)/);
  assert.ok(!/g\.requestedTitle/.test(a), 'la fila no lee el título guardado directamente');
});
