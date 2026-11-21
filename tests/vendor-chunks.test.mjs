// División del bundle por librerías (scripts/vendor-chunks.mjs): cada paquete va a su grupo por NOMBRE EXACTO.
// Ejecutar: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { VENDOR_GROUPS, packageOf, vendorChunkOf } from '../scripts/vendor-chunks.mjs';

const nm = (pkg, file = 'index.js') => `C:/repo/melodya.web-vite/node_modules/${pkg}/${file}`;

test('packageOf: nombre del paquete (con scope, con barras de Windows y con node_modules anidados)', () => {
  assert.equal(packageOf(nm('react-dom', 'cjs/react-dom.production.js')), 'react-dom');
  assert.equal(packageOf(nm('@radix-ui/react-dialog', 'dist/index.mjs')), '@radix-ui/react-dialog');
  assert.equal(packageOf('C:\\repo\\node_modules\\axios\\lib\\axios.js'), 'axios');
  assert.equal(packageOf('/r/node_modules/.pnpm/x@1/node_modules/react/index.js'), 'react', 'se usa el ÚLTIMO node_modules');
  assert.equal(packageOf('C:/repo/melodya.web-vite/src/main.tsx'), null, 'el código propio no es de node_modules');
  assert.equal(packageOf('\0commonjsHelpers.js'), null, 'los módulos virtuales no se agrupan');
});

test('cada librería aprobada va a su grupo', () => {
  const expected = {
    react: 'vendor-react',
    'react-dom': 'vendor-react',
    scheduler: 'vendor-react',
    'react-router': 'vendor-router',
    'react-router-dom': 'vendor-router',
    axios: 'vendor-http',
    '@tanstack/query-core': 'vendor-query',
    '@tanstack/react-query': 'vendor-query',
    '@radix-ui/react-dialog': 'vendor-ui',
    '@radix-ui/react-primitive': 'vendor-ui',
    '@floating-ui/dom': 'vendor-ui',
    '@floating-ui/react-dom': 'vendor-ui',
    'react-remove-scroll': 'vendor-ui',
    'react-remove-scroll-bar': 'vendor-ui',
    'react-style-singleton': 'vendor-ui',
    'use-sidecar': 'vendor-ui',
    'use-callback-ref': 'vendor-ui',
    'aria-hidden': 'vendor-ui',
    cmdk: 'vendor-ui',
    'tailwind-merge': 'vendor-utils',
    clsx: 'vendor-utils',
    'class-variance-authority': 'vendor-utils',
    zustand: 'vendor-utils',
  };
  for (const [pkg, chunk] of Object.entries(expected)) assert.equal(vendorChunkOf(nm(pkg)), chunk, pkg);
});

test('la coincidencia es por nombre exacto: `react` no atrapa paquetes que solo empiezan igual', () => {
  for (const pkg of ['react-hook-form', 'react-day-picker', 'react-resizable-panels', 'react-is', 'react-smooth', 'react-transition-group', 'reactflow']) {
    assert.equal(vendorChunkOf(nm(pkg)), undefined, `${pkg} debe seguir a cargo de Rollup`);
  }
  assert.equal(vendorChunkOf(nm('@tanstack/react-table')), undefined);
});

test('las librerías de pantallas puntuales y el código propio NO se agrupan (siguen en la carga diferida)', () => {
  for (const pkg of ['recharts', 'embla-carousel-react', 'input-otp', 'vaul', 'sonner', 'lucide-react', 'socket.io-client', 'react-hook-form']) {
    assert.equal(vendorChunkOf(nm(pkg)), undefined, pkg);
  }
  assert.equal(vendorChunkOf('C:/repo/melodya.web-vite/src/features/library/VoicesTab.tsx'), undefined);
  assert.equal(vendorChunkOf('C:/repo/melodya.web-vite/server/og.mjs'), undefined);
});

test('hay exactamente los 6 grupos aprobados, sin nombres repetidos y sin solaparse', () => {
  assert.deepEqual(VENDOR_GROUPS.map(([name]) => name), ['vendor-react', 'vendor-router', 'vendor-http', 'vendor-query', 'vendor-ui', 'vendor-utils']);
  for (const pkg of ['react', 'react-router-dom', 'axios', '@tanstack/query-core', '@radix-ui/react-menu', 'zustand', 'tslib']) {
    const hits = VENDOR_GROUPS.filter(([, re]) => re.test(pkg));
    assert.equal(hits.length, 1, `${pkg} debe pertenecer a un solo grupo`);
  }
});
