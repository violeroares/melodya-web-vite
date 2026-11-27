// Restauración desde el bfcache al volver de Melodya Store. Ejecutar: node --test "tests/page-restore.test.mjs"
import './_helpers/register-ts-resolve.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { QueryClient } from '@tanstack/query-core';

const { onPageRestored } = await import('../src/lib/page-restore.ts');
const { refreshCommercialState } = await import('../src/lib/commercial-state.ts');
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

/** Destino de eventos mínimo: permite emitir `pageshow` como lo haría el navegador. */
function fakeWindow() {
  const listeners = new Set();
  return {
    addEventListener: (type, fn) => { assert.equal(type, 'pageshow'); listeners.add(fn); },
    removeEventListener: (type, fn) => { assert.equal(type, 'pageshow'); listeners.delete(fn); },
    emit: (persisted) => { for (const fn of [...listeners]) fn({ persisted }); },
    count: () => listeners.size,
  };
}

test('con restauración desde el bfcache (persisted = true) se ejecuta el aviso', () => {
  const win = fakeWindow();
  let calls = 0;
  onPageRestored(() => { calls += 1; }, win);
  win.emit(true);
  assert.equal(calls, 1);
  win.emit(true); // otra ida y vuelta a Store
  assert.equal(calls, 2);
});

test('sin restauración (carga normal o recarga: persisted = false/undefined) no se ejecuta nada', () => {
  const win = fakeWindow();
  let calls = 0;
  onPageRestored(() => { calls += 1; }, win);
  win.emit(false);
  win.emit(undefined);
  assert.equal(calls, 0);
});

test('la función devuelta quita el aviso (al desmontar no queda nada escuchando) y sin window no falla', () => {
  const win = fakeWindow();
  let calls = 0;
  const off = onPageRestored(() => { calls += 1; }, win);
  assert.equal(win.count(), 1);
  off();
  assert.equal(win.count(), 0);
  win.emit(true);
  assert.equal(calls, 0);
  assert.doesNotThrow(() => onPageRestored(() => {}, undefined)());
});

test('escenario pack/Creator/Pro: el botón queda «abriendo», se restaura la página y puede elegirse otra vez (y repetirse)', () => {
  const win = fakeWindow();
  for (const product of ['pack-123456', 'plan-creator-1', 'plan-pro-0001']) {
    let opening = null; // equivalente a openingStoreFor / busy
    onPageRestored(() => { opening = null; }, win);
    opening = product; // clic: setOpeningStoreFor(id) y navega a Store
    win.emit(true); // vuelve con «atrás» sin comprar
    assert.equal(opening, null, `${product}: el botón se libera`);
    opening = product; // se puede elegir de nuevo
    assert.equal(opening, product);
  }
});

test('regreso tras una compra aprobada: el estado comercial se vuelve a leer (perfil + saldo/consumo/movimientos) con el mismo mecanismo', async () => {
  const qc = new QueryClient();
  qc.setQueryData(['usage'], { plan: 'FREE' });
  qc.setQueryData(['credits'], { balance: 20 });
  let loadMe = 0;
  const win = fakeWindow();
  const done = [];
  onPageRestored(() => done.push(refreshCommercialState(qc, async () => { loadMe += 1; })), win);
  win.emit(true);
  await Promise.all(done);
  assert.equal(loadMe, 1);
  for (const key of ['usage', 'credits']) assert.equal(qc.getQueryState([key]).isInvalidated, true, `${key} invalidado`);
});

test('sin solicitudes redundantes: la reconexión del socket que llega mientras se refresca por la restauración se junta en una pasada extra, nunca en paralelo', async () => {
  const qc = new QueryClient();
  let inFlight = 0, maxParallel = 0, loadMe = 0;
  const load = async () => { loadMe += 1; inFlight += 1; maxParallel = Math.max(maxParallel, inFlight); await new Promise((r) => setTimeout(r, 15)); inFlight -= 1; };
  const a = refreshCommercialState(qc, load); // restauración (pageshow)
  const b = refreshCommercialState(qc, load); // reconexión del socket (onConnect)
  const c = refreshCommercialState(qc, load); // otro aviso en vuelo
  await Promise.all([a, b, c]);
  assert.equal(maxParallel, 1);
  assert.equal(loadMe, 2, 'una pasada y UNA más para no quedarse con datos anteriores a la reconexión');
});

test('cableado: PricingView y OpenStoreButton liberan el botón al restaurar y conservan el bloqueo contra doble clic; AppShell refresca notificaciones y estado comercial', () => {
  const pricing = read('../src/features/billing/PricingView.tsx');
  const button = read('../src/features/billing/OpenStoreButton.tsx');
  const hook = read('../src/hooks/use-page-restore.ts');
  const shell = read('../src/components/layout/AppShell.tsx');
  assert.match(pricing, /usePageRestore\(\(\) => setOpeningStoreFor\(null\)\)/);
  assert.match(button, /usePageRestore\(\(\) => setBusy\(false\)\)/);
  // La protección contra doble clic sigue: el botón del producto abierto queda deshabilitado y no se libera al navegar.
  assert.match(pricing, /disabled=\{busy\}/);
  assert.match(pricing, /disabled=\{busy\} busy=\{busy\}/);
  assert.match(button, /disabled=\{busy\}/);
  assert.match(pricing, /setOpeningStoreFor\(productId\);\s*try \{\s*await openStore\(next, product\);\s*\} catch \(err\) \{\s*setOpeningStoreFor\(null\);/);
  assert.match(hook, /invalidateQueries\(\{ queryKey: \['notifications'\] \}\)/);
  assert.match(hook, /refreshCommercialState\(qc/);
  assert.match(shell, /useRefreshOnPageRestore\(\);/);
  // Ningún otro punto abre Store sin pasar por estos dos componentes.
  const src = (f) => fs.readFileSync(f, 'utf8');
  const callers = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (/\.(tsx?|jsx?)$/.test(e.name) && /\bopenStore\(/.test(src(p))) callers.push(e.name);
    }
  })(new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  assert.deepEqual(callers.sort(), ['OpenStoreButton.tsx', 'PricingView.tsx', 'store-link.ts']);
});
