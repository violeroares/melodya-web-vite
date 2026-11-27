// «Empezar de cero» (CreatorWizard): confirmación previa + animación del agujero negro al confirmar; cancelar no reinicia nada.
// No hay jsdom en este repositorio: el flujo se asegura sobre el código fuente (sin comentarios).
// Ejecutar: node --test tests/creator-restart-confirmation.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const W = code('../src/features/creator/CreatorWizard.tsx');
const S = code('../src/features/creator/SolarSystem.tsx');

/** El cuerpo de `restart` (hasta su cierre). */
const restartBody = () => {
  const i = W.indexOf('const restart = (animate = false) => {');
  assert.ok(i > 0, 'restart(animate = false) existe');
  return W.slice(i, W.indexOf('\n  };', i));
};

test('el botón «Empezar de cero» abre la confirmación y no reinicia directamente', () => {
  assert.match(W, /onClick=\{\(\) => \(recoveryActive \? setDiscardRecoveryOpen\(true\) : setRestartConfirm\(true\)\)\}/);
  // Las únicas llamadas restart() sin animación son de otros flujos que no son el botón «Empezar de cero»:
  //  • onDiscard del aviso de recuperación con el editor vacío (no hay nada que perder);
  //  • «Descartar y empezar de cero» de un candidato de recuperación (tiene su propia confirmación).
  const direct = W.match(/restart\(\)/g) ?? [];
  assert.equal(direct.length, 2, 'sólo esas dos llamadas restart() sin animación');
  assert.match(W, /onDiscard=\{\(\) => restart\(\)\}/);
  assert.match(W, /dismissCandidate\(dismissConfirm\); setDismissConfirm\(null\); restart\(\);/);
});

test('el diálogo de confirmación: título, texto y acción «Empezar de cero»', () => {
  const dlg = W.slice(W.indexOf('<ConfirmDialog\n        open={restartConfirm}'));
  assert.match(dlg, /open=\{restartConfirm\}/);
  assert.match(dlg, /title="¿Empezar de cero\?"/);
  assert.match(dlg, /actionLabel="Empezar de cero"/);
});

test('CONFIRMAR: cierra el diálogo y reinicia con la animación (restart(true))', () => {
  assert.match(W, /onConfirm=\{\(\) => \{ setRestartConfirm\(false\); restart\(true\); \}\}/);
});

test('CANCELAR: el diálogo sólo cambia su estado abierto; nada llama a restart ni vacía la canción', () => {
  assert.match(W, /onOpenChange=\{setRestartConfirm\}/, 'cancelar / Escape / clic afuera = onOpenChange(false)');
  const confirmLine = W.match(/onConfirm=\{[^\n]*restart\(true\)[^\n]*\}/g) ?? [];
  assert.equal(confirmLine.length, 1, 'restart(true) sólo se alcanza por onConfirm del diálogo normal');
  assert.doesNotMatch(W.slice(W.indexOf('open={restartConfirm}'), W.indexOf('onConfirm=')), /restart|setNormalSong/);
});

test('con una recuperación en curso, «Empezar de cero» pasa por su propio aviso y también reinicia con la animación al confirmar', () => {
  assert.match(W, /<AlertDialogAction onClick=\{\(\) => \{ setDiscardRecoveryOpen\(false\); restart\(true\); \}\}>Empezar de cero<\/AlertDialogAction>/);
  assert.match(W, /<AlertDialogCancel>Volver<\/AlertDialogCancel>/, 'el aviso de recuperación tiene cancelar sin reinicio');
});

test('restart(animate): anima sólo si se pide y el sistema lo permite, y SIEMPRE vacía la canción y el borrador', () => {
  const body = restartBody();
  assert.match(body, /if \(animate && collapseRef\.current\?\.\(\)\)/, 'la animación depende de animate y de que el sistema solar la acepte');
  assert.match(body, /setRestarting\(true\)/);
  assert.match(body, /setNormalSong\(emptySong\)/);
  assert.match(body, /setPendingPlanets\(\[\]\)/);
  assert.match(body, /clearDraft\(/);
  assert.match(body, /if \(recoveryActive\) rec\.end\('DISMISSED'\)/);
  // La animación se pide ANTES de vaciar: usa el sistema de antes.
  assert.ok(body.indexOf('collapseRef.current') < body.indexOf('setNormalSong(emptySong)'));
});

test('el cartel «Empezá por Composición» espera a que el sistema renazca', () => {
  assert.match(W, /empty && !restarting && !versionPending && !recoveryActive/);
  assert.match(W, /window\.setTimeout\(\(\) => setRestarting\(false\), 950\)/);
});

test('SolarSystem: registra la animación, no anima con reduced-motion y se da de baja al desmontar', () => {
  assert.match(W, /registerCollapse=\{registerCollapse\}/);
  assert.match(S, /registerCollapse\?: \(collapse: \(\(\) => boolean\) \| null\) => void/);
  assert.match(S, /prefers-reduced-motion: reduce\)'\)\.matches\) return false/, 'con reduced-motion devuelve false: se reinicia sin animación');
  assert.match(S, /return \(\) => registerCollapse\(null\)/);
});

test('«Otra versión» (hasSource) no muestra «Empezar de cero»', () => {
  assert.match(W, /\{!hasSource && !empty && \(/);
});
