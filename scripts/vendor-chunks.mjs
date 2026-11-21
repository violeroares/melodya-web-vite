/**
 * División del bundle por librerías (la usa `vite.config.ts` como `build.rollupOptions.output.manualChunks`).
 *
 * Sin esto, `index` (react-dom + react-router + axios) y `routes` (estructura de la app) superaban 1 MiB antes de minificar. Además de ser
 * demasiado grandes, en Windows esbuild pasa por un archivo temporal cuando recibe un chunk de más de 1 MiB y el bloqueo de ese archivo hace
 * fallar el build.
 *
 * Reglas:
 *  • Cada grupo se identifica por el NOMBRE EXACTO del paquete (nunca por subcadena: `react` no debe atrapar `react-hook-form` ni
 *    `react-remove-scroll`).
 *  • Solo se agrupan librerías que ya cargan al inicio. Las de pantallas puntuales (recharts, react-day-picker, embla, react-hook-form,
 *    vaul, input-otp, react-resizable-panels…) NO se tocan: siguen en la carga diferida de su pantalla.
 *  • El tamaño máximo de cada chunk lo controla `npm run check:chunks` (scripts/check-chunk-sizes.mjs).
 *
 * Es un módulo puro (sin Vite ni Rollup) para poder probarlo con `node --test` (tests/vendor-chunks.test.mjs).
 */

/** @type {ReadonlyArray<readonly [string, RegExp]>} */
export const VENDOR_GROUPS = [
  ['vendor-react', /^(react|react-dom|scheduler)$/],
  ['vendor-router', /^(react-router|react-router-dom)$/],
  ['vendor-http', /^axios$/],
  ['vendor-query', /^@tanstack\/(query-core|react-query)$/],
  [
    'vendor-ui',
    /^(@radix-ui\/[^/]+|@floating-ui\/[^/]+|react-remove-scroll|react-remove-scroll-bar|react-style-singleton|use-sidecar|use-callback-ref|aria-hidden|get-nonce|detect-node-es|tslib|cmdk)$/,
  ],
  ['vendor-utils', /^(tailwind-merge|clsx|class-variance-authority|zustand)$/],
];

/** Nombre del paquete npm al que pertenece un módulo (último `node_modules/` de la ruta), o null si no es de node_modules. */
export function packageOf(id) {
  const path = String(id).replace(/\\/g, '/');
  const marker = 'node_modules/';
  const at = path.lastIndexOf(marker);
  if (at === -1) return null;
  const parts = path.slice(at + marker.length).split('/');
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

/** `manualChunks` de Rollup: nombre del chunk vendor al que va el módulo, o undefined (Rollup decide, como siempre). */
export function vendorChunkOf(id) {
  const pkg = packageOf(id);
  if (!pkg) return undefined;
  for (const [chunk, packages] of VENDOR_GROUPS) if (packages.test(pkg)) return chunk;
  return undefined;
}
