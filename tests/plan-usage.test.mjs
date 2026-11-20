// Resumen de consumo del plan («13 / 15» con barra): lógica pura sobre GET /users/me/usage → meters + garantías estáticas del componente.
// Ejecutar: node --test "tests/*.test.mjs"  (Node 24 carga .ts directamente).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { usageMeterLines, usagePeriodText } = await import('../src/lib/capabilities.ts');
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

const PERIOD = { kind: 'calendar', start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z', resetsAt: '2026-12-01T00:00:00.000Z' };
const meter = (over) => ({
  key: 'SONGS_PER_PERIOD', name: 'Canciones por período', unit: 'canciones', status: 'AVAILABLE', included: true, limit: 15, used: 13, remaining: 2, enforced: true,
  periodStart: PERIOD.start, periodEnd: PERIOD.end, resetsAt: PERIOD.resetsAt, ...over,
});
const usage = (...meters) => ({ period: PERIOD, meters });

test('límite mayor que cero: «consumido / total», porcentaje de la barra y cuánto queda, con la fecha de renovación', () => {
  const [l] = usageMeterLines(usage(meter({})));
  assert.deepEqual([l.key, l.name, l.state, l.value, l.percent], ['SONGS_PER_PERIOD', 'Canciones por período', 'bar', '13 / 15', 87]);
  assert.match(l.detail, /Te quedan 2 canciones en este período\./);
  assert.match(l.detail, /Se renueva el 01\/12\/2026\./);
});

test('queda una sola unidad: singular', () => {
  const [l] = usageMeterLines(usage(meter({ used: 14, remaining: 1 })));
  assert.match(l.detail, /Te queda 1 disponible en este período./);
  assert.equal(l.value, '14 / 15');
});

test('consumo igual al límite: barra completa e indica que se alcanzó el límite', () => {
  const [l] = usageMeterLines(usage(meter({ status: 'REACHED', used: 15, remaining: 0 })));
  assert.deepEqual([l.state, l.percent, l.value], ['reached', 100, '15 / 15']);
  assert.match(l.detail, /Alcanzaste el límite de tu plan/);
});

test('exceso (baja de plan): la barra no pasa de 100 y sigue alcanzado', () => {
  const [l] = usageMeterLines(usage(meter({ status: 'REACHED', used: 45, limit: 40, remaining: 0 })));
  assert.deepEqual([l.state, l.percent, l.value], ['reached', 100, '45 / 40']);
});

test('límite cero o capacidad ausente: «No incluido», sin barra ni detalle', () => {
  const [l] = usageMeterLines(usage(meter({ key: 'DOWNLOADS_PER_PERIOD', name: 'Descargas por período', unit: 'descargas', status: 'NOT_INCLUDED', included: false, limit: 0, used: 0, remaining: null })));
  assert.deepEqual([l.state, l.value, l.percent, l.detail], ['not-included', 'No incluido', 0, '']);
});

test('capacidad ilimitada: «Ilimitado», sin barra', () => {
  const [l] = usageMeterLines(usage(meter({ status: 'UNLIMITED', limit: null, remaining: null, used: 7 })));
  assert.deepEqual([l.state, l.value, l.detail], ['unlimited', 'Ilimitado', '']);
});

test('Free, Creator y Pro: cada plan muestra sus propios límites (la lista es dinámica, sin claves fijas)', () => {
  const dl = (limit, used) => meter({ key: 'DOWNLOADS_PER_PERIOD', name: 'Descargas por período', unit: 'descargas', limit, used, remaining: limit - used, status: limit === 0 ? 'NOT_INCLUDED' : 'AVAILABLE' });
  const free = usageMeterLines(usage(meter({ limit: 15, used: 13 }), dl(0, 0)));
  const creator = usageMeterLines(usage(meter({ limit: 40, used: 13, remaining: 27 }), dl(20, 13)));
  const pro = usageMeterLines(usage(meter({ limit: 100, used: 13, remaining: 87 }), dl(60, 13)));
  assert.deepEqual(free.map((l) => l.value), ['13 / 15', 'No incluido']);
  assert.deepEqual(creator.map((l) => l.value), ['13 / 40', '13 / 20']);
  assert.deepEqual(pro.map((l) => l.value), ['13 / 100', '13 / 60']);
  // Una capacidad nueva con límite aparece sola, sin tocar la interfaz.
  const extra = usageMeterLines(usage(meter({ key: 'ALGO_NUEVO', name: 'Algo nuevo', unit: 'cosas', limit: 3, used: 1, remaining: 2 })));
  assert.deepEqual([extra[0].key, extra[0].value], ['ALGO_NUEVO', '1 / 3']);
});

test('sin medidores, con un backend anterior o con un estado desconocido no se muestra ni se inventa nada', () => {
  assert.deepEqual(usageMeterLines(undefined), []);
  assert.deepEqual(usageMeterLines({ period: PERIOD }), []);
  assert.deepEqual(usageMeterLines(usage(meter({ status: 'OTRO' }))), []);
  assert.deepEqual(usageMeterLines(usage(meter({ status: 'AVAILABLE', limit: null }))), []);
  assert.equal(usagePeriodText({ period: PERIOD }), '');
});

test('período: el mes calendario del plan base se muestra en UTC; una suscripción muestra su propia ventana', () => {
  assert.equal(usagePeriodText(usage(meter({}))), 'Período actual: 01/11/2026 al 01/12/2026');
  const sub = { period: { kind: 'subscription', start: '2026-11-10T15:00:00.000Z', end: '2026-12-10T15:00:00.000Z', resetsAt: '2026-12-10T15:00:00.000Z' }, meters: [meter({ resetsAt: '2026-12-10T15:00:00.000Z' })] };
  assert.equal(usagePeriodText(sub), 'Período actual: 10/11/2026 al 10/12/2026');
  assert.match(usageMeterLines(sub)[0].detail, /Se renueva el 10\/12\/2026\./);
});

test('el resumen de uso usa los datos del servidor, va debajo del resumen del plan y no toca el saldo de fichas', () => {
  const comp = read('../src/features/billing/PlanUsage.tsx');
  assert.match(comp, /useUsage\(\)/);
  assert.match(comp, /usageMeterLines\(usage\)/);
  assert.match(comp, /<Progress/);
  assert.doesNotMatch(comp, /SONGS_PER_PERIOD|DOWNLOADS_PER_PERIOD|creditsBalance|useCredits/, 'sin capacidades fijas ni saldo de fichas');
  assert.match(read('../src/features/billing/CurrentPlanCard.tsx'), /<PlanUsage/);
  assert.match(read('../src/features/billing/SubscriptionCard.tsx'), /<PlanUsage/);
  const view = read('../src/features/billing/PricingView.tsx');
  assert.match(view, /creditsQuery\.data\?\.balance/, 'el saldo de fichas sigue como estaba');
});
