// src/stores/auth.ts REAL (con dobles de API/cliente/router, ver tests/_helpers): cambiar la contraseña renueva la sesión de ESTE dispositivo
// (guarda los tokens nuevos y avisa a Socket.IO para reconectar); si el backend no la renueva (cliente sin refresh vigente) la sesión local
// se cierra. Ejecutar: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./_helpers/auth-store-loader.mjs', import.meta.url);

// El store agenda un refresh proactivo (timer largo): se des-referencia para que el proceso de prueba pueda terminar.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  const t = realSetTimeout(fn, ms, ...args);
  t?.unref?.();
  return t;
};

const memory = new Map();
const events = [];
globalThis.localStorage = {
  getItem: (k) => (memory.has(k) ? memory.get(k) : null),
  setItem: (k, v) => { memory.set(k, String(v)); },
  removeItem: (k) => { memory.delete(k); },
};
globalThis.window = {
  location: { origin: 'http://localhost:3000' },
  dispatchEvent: (e) => { events.push(e.type); return true; },
};

const { shared } = await import('./_helpers/stubs/auth-store-doubles.mjs');
const { useAuthStore, SESSION_RENEWED_EVENT } = await import('../src/stores/auth.ts');
const STORAGE_KEY = 'melodya.session';

function startSession() {
  memory.set(STORAGE_KEY, JSON.stringify({ accessToken: 'access-viejo', refreshToken: 'refresh-viejo', accessExpiresAt: Date.now() + 600000, expiresAt: Date.now() + 86400000 }));
  useAuthStore.setState({ user: { id: 'u1' }, accessToken: 'access-viejo', status: 'authenticated' });
}

test.beforeEach(() => {
  memory.clear();
  events.length = 0;
  Object.assign(shared, { calls: [], navigations: [], changeResult: null, resets: 0 });
});

test('envía el refresh token del dispositivo y, si el backend renueva la sesión, guarda los tokens nuevos y avisa para reconectar el socket', async () => {
  startSession();
  shared.changeResult = { ok: true, sessionRenewed: true, accessToken: 'access-nuevo', refreshToken: 'refresh-nuevo' };

  const out = await useAuthStore.getState().changePassword('Vieja-123', 'Nueva-123');

  assert.deepEqual(out, { sessionRenewed: true });
  assert.deepEqual(shared.calls[0].body, { currentPassword: 'Vieja-123', newPassword: 'Nueva-123', refreshToken: 'refresh-viejo' });
  const stored = JSON.parse(memory.get(STORAGE_KEY));
  assert.equal(stored.accessToken, 'access-nuevo');
  assert.equal(stored.refreshToken, 'refresh-nuevo');
  assert.equal(useAuthStore.getState().accessToken, 'access-nuevo');
  assert.equal(useAuthStore.getState().status, 'authenticated');
  assert.ok(events.includes(SESSION_RENEWED_EVENT), 'avisa a useRealtime para reconectar Socket.IO con el token nuevo');
  assert.deepEqual(shared.navigations, []);
});

test('si el backend NO renueva la sesión (sessionRenewed: false) cierra la sesión local y manda a ingresar', async () => {
  startSession();
  shared.changeResult = { ok: true, sessionRenewed: false };

  const out = await useAuthStore.getState().changePassword('Vieja-123', 'Nueva-123');

  assert.deepEqual(out, { sessionRenewed: false });
  assert.equal(memory.get(STORAGE_KEY), undefined, 'los tokens viejos (ya revocados) se descartan');
  assert.equal(useAuthStore.getState().status, 'guest');
  assert.equal(useAuthStore.getState().accessToken, null);
  assert.deepEqual(shared.navigations, ['/login']);
  assert.ok(!events.includes(SESSION_RENEWED_EVENT));
});

test('sin sesión guardada igual cambia la contraseña sin refresh token y termina cerrando la sesión local', async () => {
  shared.changeResult = { ok: true, sessionRenewed: false };
  await useAuthStore.getState().changePassword('Vieja-123', 'Nueva-123');
  assert.equal(shared.calls[0].body.refreshToken, undefined);
  assert.equal(useAuthStore.getState().status, 'guest');
});
