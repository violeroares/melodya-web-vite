// Estado comercial centralizado: invalidación de ['usage'] y demás consultas del usuario tras una acción, sin consultas redundantes, y aviso del servidor.
// Ejecutar: node --test "tests/*.test.mjs"  (Node 24 carga .ts directamente). Usa el QueryClient REAL de @tanstack/query-core.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { QueryClient, QueryObserver } from '@tanstack/query-core';

const { refreshCommercialState, isCommercialStateCurrent, COMMERCIAL_QUERY_KEYS } = await import('../src/lib/commercial-state.ts');
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 0));

const FREE_USAGE = { meters: [{ key: 'DOWNLOADS_PER_PERIOD', status: 'NOT_INCLUDED' }, { key: 'SONGS_PER_PERIOD', status: 'AVAILABLE', limit: 15, used: 0 }] };
const CREATOR_USAGE = { meters: [{ key: 'DOWNLOADS_PER_PERIOD', status: 'AVAILABLE', limit: 20, used: 0 }, { key: 'SONGS_PER_PERIOD', status: 'AVAILABLE', limit: 40, used: 0 }] };
const PRO_USAGE = { meters: [{ key: 'DOWNLOADS_PER_PERIOD', status: 'AVAILABLE', limit: 60, used: 0 }, { key: 'SONGS_PER_PERIOD', status: 'AVAILABLE', limit: 100, used: 0 }] };

test('la causa corregida: tras la compra se invalida el consumo [usage] (antes quedaba con los datos de Free), junto con saldo y movimientos, y se recarga el perfil', async () => {
  const qc = new QueryClient();
  qc.setQueryData(['usage'], FREE_USAGE);
  qc.setQueryData(['credits'], { balance: 20 });
  qc.setQueryData(['transactions', 'all'], { items: [] });
  qc.setQueryData(['plans', 'u1'], { items: [] });
  qc.setQueryData(['credit-packages', 'u1'], { items: [] });
  let loads = 0;
  await refreshCommercialState(qc, async () => { loads += 1; });
  for (const key of [['usage'], ['credits'], ['transactions', 'all']]) assert.equal(qc.getQueryState(key).isInvalidated, true, `${key.join('/')} debe quedar invalidada`);
  assert.equal(loads, 1, 'el perfil se vuelve a pedir una sola vez');
  assert.equal(qc.getQueryState(['plans', 'u1']).isInvalidated, false, 'los catálogos no cambian con la compra: no se invalidan');
  assert.equal(qc.getQueryState(['credit-packages', 'u1']).isInvalidated, false);
  assert.deepEqual(COMMERCIAL_QUERY_KEYS.map((k) => k.join('/')), ['usage', 'credits', 'transactions']);
});

test('Free → Creator → Pro: una consulta viva de consumo pasa a los límites nuevos con UNA sola consulta por cambio (sin recargar ni consultas repetidas)', async () => {
  const qc = new QueryClient();
  const server = { usage: FREE_USAGE };
  let usageCalls = 0;
  const observer = new QueryObserver(qc, { queryKey: ['usage'], queryFn: async () => { usageCalls += 1; return server.usage; }, staleTime: 30_000 });
  const unsubscribe = observer.subscribe(() => {});
  await tick(); await tick();
  assert.equal(observer.getCurrentResult().data.meters[0].status, 'NOT_INCLUDED');
  assert.equal(usageCalls, 1);

  server.usage = CREATOR_USAGE; // el servidor ya devuelve el plan nuevo
  await refreshCommercialState(qc, async () => {});
  await tick(); await tick();
  assert.deepEqual([observer.getCurrentResult().data.meters[0].limit, observer.getCurrentResult().data.meters[1].limit], [20, 40], 'descargas 0 / 20 y canciones 0 / 40');
  assert.equal(usageCalls, 2, 'una sola consulta adicional');

  server.usage = PRO_USAGE; // upgrade inmediato
  await refreshCommercialState(qc, async () => {});
  await tick(); await tick();
  assert.deepEqual([observer.getCurrentResult().data.meters[0].limit, observer.getCurrentResult().data.meters[1].limit], [60, 100]);
  assert.equal(usageCalls, 3);
  unsubscribe();
});

test('sin consultas redundantes: llamadas simultáneas se agrupan (la que llega durante la actualización pide UNA pasada más, nunca una por llamada) y no hay bucles', async () => {
  const qc = new QueryClient();
  let loads = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const loadMe = async () => { loads += 1; if (loads === 1) await gate; };
  const first = refreshCommercialState(qc, loadMe);
  const burst = [refreshCommercialState(qc, loadMe), refreshCommercialState(qc, loadMe), refreshCommercialState(qc, loadMe)];
  release();
  await Promise.all([first, ...burst]);
  assert.equal(loads, 2, 'una pasada en curso + UNA más para lo que llegó mientras tanto');
  await refreshCommercialState(qc, loadMe); // y después sigue funcionando normalmente
  assert.equal(loads, 3);
});

test('un fallo inesperado de la recarga no queda colgado ni bloquea la siguiente actualización', async () => {
  const qc = new QueryClient();
  await refreshCommercialState(qc, async () => { throw new Error('red'); });
  let loads = 0;
  await refreshCommercialState(qc, async () => { loads += 1; });
  assert.equal(loads, 1);
});

const sub = (over = {}) => ({ status: 'ACTIVE', plan: { code: 'pro' }, currentPeriodEnd: '2026-12-19T10:00:00.000Z', ...over });
const evt = (over = {}) => ({ reason: 'RENEWED', status: 'ACTIVE', planCode: 'pro', currentPeriodEnd: '2026-12-19T10:00:00.000Z', ...over });

test('aviso del servidor: si el perfil ya coincide no se pide nada; si el plan, el estado o el fin del período difieren, se vuelve a hidratar', () => {
  assert.equal(isCommercialStateCurrent({ subscription: sub() }, evt()), true, 'la propia acción del usuario ya lo cargó');
  assert.equal(isCommercialStateCurrent({ subscription: sub({ currentPeriodEnd: '2026-11-19T10:00:00.000Z' }) }, evt()), false, 'renovación: el fin del período avanzó');
  assert.equal(isCommercialStateCurrent({ subscription: sub({ plan: { code: 'creator' } }) }, evt({ reason: 'PLAN_CHANGED' })), false, 'cambio programado que se hizo efectivo');
  assert.equal(isCommercialStateCurrent({ subscription: null }, evt({ reason: 'RECOVERED' })), false);
  assert.equal(isCommercialStateCurrent({ subscription: null }, evt({ status: 'EXPIRED', reason: 'EXPIRED', planCode: 'pro' })), true, 'vencida y el perfil ya no tiene suscripción');
  assert.equal(isCommercialStateCurrent({ subscription: sub() }, evt({ status: 'EXPIRED', reason: 'CANCELED' })), false, 'el perfil todavía muestra la suscripción');
  assert.equal(isCommercialStateCurrent({ subscription: sub() }, evt({ status: 'PAST_DUE', reason: 'PAST_DUE' })), false, 'la gracia siempre se hidrata');
  assert.equal(isCommercialStateCurrent(null, evt()), true, 'sin perfil no hay nada que actualizar');
});

for (const [name, root] of [['esta web', '..']]) {
  test(`${name}: las acciones comerciales usan el mecanismo central y la escucha del socket recupera el estado (aviso y reconexión)`, () => {
    const pricing = read(`${root}/src/features/billing/PricingView.tsx`);
    const card = read(`${root}/src/features/billing/SubscriptionCard.tsx`);
    const hooks = read(`${root}/src/hooks/index.ts`);
    // checkout (compra, upgrade, downgrade programado) y reanudar: el mecanismo central, no invalidaciones sueltas
    assert.match(pricing, /useRefreshCommercialState\(\)/);
    assert.equal((pricing.match(/void refreshCommercial\(\)/g) || []).length, 3, 'checkout, reanudar (éxito) y reanudar (error)');
    assert.doesNotMatch(pricing, /invalidateQueries\(\{ queryKey: \['credits'\] \}\)|invalidateQueries\(\{ queryKey: \['transactions'\] \}\)|getState\(\)\.loadMe\(\)/);
    // cancelar y reanudar desde la tarjeta
    assert.match(card, /useRefreshCommercialState\(\)/);
    assert.doesNotMatch(card, /getState\(\)\.loadMe\(\)/);
    // aviso del servidor y reconexión
    assert.match(hooks, /socket\.on\('billing:state-changed', onBilling as never\)/);
    assert.match(hooks, /if \(!isCommercialStateCurrent\(useAuthStore\.getState\(\)\.user, payload\)\) refreshFromServer\(\)/);
    assert.match(hooks, /socket\.on\('connect', onConnect as never\)/);
    assert.match(hooks, /if \(hadConnection && !deliberateReconnect && !disposed\) refreshFromServer\(\)/);
    assert.match(hooks, /deliberateReconnect = true/);
    // no hay un efecto global observando el store
    assert.doesNotMatch(read(`${root}/src/hooks/use-commercial-state.ts`), /useEffect|subscribe\(/);
  });
}
