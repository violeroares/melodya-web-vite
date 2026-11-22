// Landing pública: cuándo se muestra y qué oculta el AppShell. Lógica pura + garantías estáticas sobre el código fuente
// (no hay jsdom ni testing-library en este repositorio).
// Ejecutar: node --test tests/public-landing.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { isPublicLanding } = await import('../src/lib/public-landing.ts');
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const guest = { path: '/', user: null, status: 'guest', sessionRecovering: false };

test('la raíz de un invitado confirmado es la landing pública', () => {
  assert.equal(isPublicLanding(guest), true);
});

test('con sesión (usuario validado) la raíz es el HomeView, no la landing', () => {
  assert.equal(isPublicLanding({ ...guest, user: { id: 'u1' }, status: 'authenticated' }), false);
});

test('mientras la sesión se resuelve (idle / loading) no es la landing', () => {
  assert.equal(isPublicLanding({ ...guest, status: 'idle' }), false);
  assert.equal(isPublicLanding({ ...guest, status: 'loading' }), false);
});

test('una sesión guardada en recuperación no es un invitado', () => {
  assert.equal(isPublicLanding({ ...guest, sessionRecovering: true }), false);
  assert.equal(isPublicLanding({ path: '/', user: null, status: 'guest' }), true);
});

test('el resto de las rutas, públicas o privadas, conserva el shell completo', () => {
  for (const path of ['/login', '/register', '/forgot-password', '/reset-password', '/community', '/plans', '/songs/abc', '/user/u1', '/create', '/library', '/profile', '/notifications', '/otra-cosa']) {
    assert.equal(isPublicLanding({ ...guest, path }), false, path);
  }
});

test('AppShell oculta la navegación sólo con la landing pública y la ruta «/» usa el mismo predicado', () => {
  const shell = code('../src/components/layout/AppShell.tsx');
  for (const piece of ['{!publicLanding && <Sidebar', '{!publicLanding && <AnnouncementBar />}', '{!publicLanding && <Header />}', '{!publicLanding && <BottomNav />}', '{!publicLanding && <CommandPalette />}', 'withFooter && !publicLanding']) {
    assert.ok(shell.includes(piece), `falta: ${piece}`);
  }
  assert.ok(shell.includes('<PlayerBar withBottomNav={!publicLanding} />') && !shell.includes('!publicLanding && <PlayerBar'), 'el reproductor sigue montado (se escuchan canciones de la comunidad)');
  assert.ok(shell.includes("!publicLanding && '@container'"), 'sin @container en la landing: la contención de layout rompería position:fixed (pin del hero, botón de sonido)');
  assert.match(code('../src/routes.tsx'), /isPublicLanding\(/);
});

test('la landing no escribe precios ni planes a mano y no arranca el audio sola', () => {
  const pricing = code('../src/features/landing/LandingPricing.tsx');
  assert.match(pricing, /usePublicPlans\(\)/);
  assert.match(pricing, /priceView\(/);
  assert.doesNotMatch(pricing, /\$\s?\d|9\.99|19\.99/);
  const view = code('../src/features/landing/LandingView.tsx');
  assert.match(view, /preload="none"/);
  assert.doesNotMatch(view, /autoPlay/, 'el audio de fondo no se reproduce automáticamente');
  assert.doesNotMatch(view, /href="#(solucion|features|planes|top)"/, 'las anclas #x chocarían con el router por hash');
});

test('el servidor de producción sirve el video y el audio de la landing con tipo correcto y peticiones por rango (206)', () => {
  const server = read('../server/server.mjs');
  assert.match(server, /'\.mp4': 'video\/mp4'/);
  assert.match(server, /'\.mp3': 'audio\/mpeg'/);
  assert.match(server, /writeHead\(206/);
  assert.match(server, /'accept-ranges': 'bytes'/);
});
