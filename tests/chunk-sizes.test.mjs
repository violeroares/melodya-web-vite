// Control de tamaño de chunks (scripts/check-chunk-sizes.mjs): límite de 900.000 bytes por chunk JS sin minificar.
// No genera ningún build: usa carpetas temporales propias con archivos de relleno. Ejecutar: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CHUNK_LIMIT_BYTES, ESBUILD_TEMP_FILE_THRESHOLD, findOversized, measureChunks, report } from '../scripts/check-chunk-sizes.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-chunk-sizes.mjs');

/** Salida de build falsa en una carpeta temporal NUEVA: { 'assets/x.js': bytes }. */
function fakeBuild(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melodya-chunks-test-'));
  fs.mkdirSync(path.join(dir, 'assets'));
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'assets', name), Buffer.alloc(bytes, 97));
  return dir;
}
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });
const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('el límite es 900.000 bytes y queda por debajo del umbral de 1 MiB de esbuild', () => {
  assert.equal(CHUNK_LIMIT_BYTES, 900_000);
  assert.equal(ESBUILD_TEMP_FILE_THRESHOLD, 1_048_576);
  assert.ok(CHUNK_LIMIT_BYTES < ESBUILD_TEMP_FILE_THRESHOLD);
});

test('measureChunks: solo .js de assets, de mayor a menor', () => {
  const dir = fakeBuild({ 'a-1.js': 10, 'b-2.js': 300, 'c-3.css': 999, 'd-4.js': 20 });
  try {
    assert.deepEqual(measureChunks(dir), [{ file: 'b-2.js', bytes: 300 }, { file: 'd-4.js', bytes: 20 }, { file: 'a-1.js', bytes: 10 }]);
  } finally { cleanup(dir); }
});

test('findOversized: supera solo si es ESTRICTAMENTE mayor al límite', () => {
  const chunks = [{ file: 'x.js', bytes: 900_001 }, { file: 'y.js', bytes: 900_000 }, { file: 'z.js', bytes: 5 }];
  assert.deepEqual(findOversized(chunks).map((c) => c.file), ['x.js']);
  assert.deepEqual(findOversized(chunks, 4).map((c) => c.file), ['x.js', 'y.js', 'z.js']);
});

test('report: nombra y dimensiona cada chunk que supera el límite; avisa si además pasa de 1 MiB', () => {
  const r = report([{ file: 'index-abc.js', bytes: 1_122_348 }, { file: 'routes-def.js', bytes: 950_000 }, { file: 'ok-1.js', bytes: 100 }]);
  assert.equal(r.ok, false);
  assert.match(r.text, /ERROR: 2 chunk\(s\) superan 900\.000 bytes/);
  assert.match(r.text, /index-abc\.js: 1\.122\.348 bytes/);
  assert.match(r.text, /esbuild usará un archivo temporal/);
  assert.match(r.text, /routes-def\.js: 950\.000 bytes/);
  assert.equal(report([{ file: 'ok-1.js', bytes: 100 }]).ok, true);
});

test('CLI: termina con error (1) e informa el chunk cuando se supera el límite', () => {
  const dir = fakeBuild({ 'big-1.js': 900_001, 'small-2.js': 10 });
  try {
    const r = run(['--dir', dir]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /big-1\.js: 900\.001 bytes/);
  } finally { cleanup(dir); }
});

test('CLI: termina bien (0) cuando todos los chunks están dentro del límite, y NO modifica los archivos', () => {
  const dir = fakeBuild({ 'a-1.js': 900_000, 'b-2.js': 100 });
  try {
    const before = fs.readdirSync(path.join(dir, 'assets')).map((f) => [f, fs.statSync(path.join(dir, 'assets', f)).size, fs.statSync(path.join(dir, 'assets', f)).mtimeMs]);
    const r = run(['--dir', dir]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /OK: ningún chunk supera el límite/);
    const after = fs.readdirSync(path.join(dir, 'assets')).map((f) => [f, fs.statSync(path.join(dir, 'assets', f)).size, fs.statSync(path.join(dir, 'assets', f)).mtimeMs]);
    assert.deepEqual(after, before, 'la medición no toca los archivos generados');
  } finally { cleanup(dir); }
});

test('CLI: carpeta inexistente o argumento inválido → error de uso (2), nunca un falso OK', () => {
  assert.equal(run(['--dir', path.join(os.tmpdir(), 'melodya-no-existe-xyz')]).status, 2);
  assert.equal(run(['--limit', 'abc']).status, 2);
  assert.equal(run(['--otra-cosa']).status, 2);
});

test('--limit permite endurecer el control', () => {
  const dir = fakeBuild({ 'a-1.js': 1000 });
  try {
    assert.equal(run(['--dir', dir, '--limit', '999']).status, 1);
    assert.equal(run(['--dir', dir, '--limit', '1000']).status, 0);
  } finally { cleanup(dir); }
});
