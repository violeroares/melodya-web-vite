#!/usr/bin/env node
/**
 * Control de tamaño de los chunks JavaScript del build.
 *
 *   npm run check:chunks                      → genera un build SIN minificar en una carpeta temporal propia (con el `target` de producción),
 *                                               mide cada .js y borra solo esa carpeta temporal al terminar.
 *   npm run check:chunks -- --dir <carpeta>   → mide un build ya generado (debe estar sin minificar: `vite build --minify false`).
 *   npm run check:chunks -- --limit 800000    → otro límite en bytes (por defecto 900.000).
 *
 * Por qué sin minificar: esbuild recibe cada chunk SIN minificar y, desde 1 MiB (1.048.576 bytes), lo pasa por un archivo temporal cuyo
 * bloqueo hace fallar el build en Windows. El límite de 900.000 deja margen sobre ese umbral.
 *
 * Informa el nombre y el tamaño de los chunks que superan el límite y termina con código 1. No modifica los archivos medidos ni `dist/`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CHUNK_LIMIT_BYTES = 900_000;
export const ESBUILD_TEMP_FILE_THRESHOLD = 1024 * 1024;

/** Archivos .js de `<dir>/assets` con su tamaño en bytes, de mayor a menor. */
export function measureChunks(dir) {
  const assets = path.join(dir, 'assets');
  if (!fs.existsSync(assets)) throw new Error(`No existe ${assets}: ¿es la salida de un build de Vite?`);
  return fs
    .readdirSync(assets)
    .filter((f) => f.endsWith('.js'))
    .map((file) => ({ file, bytes: fs.statSync(path.join(assets, file)).size }))
    .sort((a, b) => b.bytes - a.bytes || a.file.localeCompare(b.file));
}

/** Los chunks que superan el límite (estrictamente mayores). */
export function findOversized(chunks, limit = CHUNK_LIMIT_BYTES) {
  return chunks.filter((c) => c.bytes > limit);
}

const fmt = (n) => n.toLocaleString('es-AR');

/** Texto del informe y si es válido. Función pura: la prueba automática la usa sin generar ningún build. */
export function report(chunks, limit = CHUNK_LIMIT_BYTES) {
  const over = findOversized(chunks, limit);
  const total = chunks.reduce((s, c) => s + c.bytes, 0);
  const lines = [`Chunks JS sin minificar: ${chunks.length} archivos, ${fmt(total)} bytes en total. Límite por chunk: ${fmt(limit)} bytes.`];
  for (const c of chunks.slice(0, 12)) {
    const pct = ((c.bytes / limit) * 100).toFixed(0).padStart(3);
    lines.push(`  ${fmt(c.bytes).padStart(10)} B  ${pct}% del límite  ${c.file}${c.bytes > limit ? '   <-- SUPERA EL LÍMITE' : ''}`);
  }
  if (chunks.length > 12) lines.push(`  … y ${chunks.length - 12} chunks más pequeños.`);
  if (over.length) {
    lines.push('', `ERROR: ${over.length} chunk(s) superan ${fmt(limit)} bytes:`);
    for (const c of over) {
      const note = c.bytes > ESBUILD_TEMP_FILE_THRESHOLD ? ' (además supera 1 MiB: esbuild usará un archivo temporal)' : '';
      lines.push(`  - ${c.file}: ${fmt(c.bytes)} bytes (+${fmt(c.bytes - limit)} sobre el límite)${note}`);
    }
  } else {
    lines.push('', 'OK: ningún chunk supera el límite.');
  }
  return { ok: over.length === 0, text: lines.join('\n') };
}

function parseArgs(argv) {
  const args = { dir: null, limit: CHUNK_LIMIT_BYTES };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') args.dir = argv[++i];
    else if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else throw new Error(`Argumento desconocido: ${argv[i]}`);
  }
  if (!Number.isInteger(args.limit) || args.limit <= 0) throw new Error('--limit debe ser un entero positivo (bytes)');
  return args;
}

function main() {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  let dir = null;
  let tempDir = null;
  try {
    const args = parseArgs(process.argv.slice(2));
    dir = args.dir;
    if (!dir) {
      // Carpeta propia y nueva (nunca `dist/` ni una carpeta existente): se borra al terminar solo ella.
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'melodya-vite-chunks-'));
      dir = tempDir;
      const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
      console.log(`Generando build sin minificar en ${tempDir} …`);
      const r = spawnSync(process.execPath, [vite, 'build', '--minify', 'false', '--outDir', tempDir, '--emptyOutDir'], { cwd: root, encoding: 'utf8' });
      if (r.status !== 0) {
        console.error(r.stdout, r.stderr);
        throw new Error(`El build sin minificar falló (código ${r.status}).`);
      }
    }
    const { ok, text } = report(measureChunks(dir), args.limit);
    console.log(text);
    process.exitCode = ok ? 0 : 1;
  } catch (err) {
    console.error(`check:chunks: ${err.message}`);
    process.exitCode = 2;
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
