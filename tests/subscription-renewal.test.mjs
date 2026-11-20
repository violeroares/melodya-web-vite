// Cancelación de la renovación de la suscripción (web): estado, fecha, texto del diálogo, resultado y errores del servidor.
// Ejecutar: node --test "tests/*.test.mjs"  (sin dependencias nuevas; Node 24 carga .ts directamente).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const S = await import('../src/lib/subscription.ts');
const { renewalState, formatDateDMY, canceledNotice, cancelDialogCopy, cancelOutcome, cancelRejection, cancelErrorMessage } = S;

const NOW = Date.parse('2026-11-10T12:00:00Z');
const sub = (over = {}) => ({ id: 'sub_1', status: 'ACTIVE', currentPeriodEnd: '2026-12-03T21:46:47.709Z', cancelAtPeriodEnd: false, canceledAt: null, ...over });
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

test('fecha DD/MM/AAAA con ceros (es-AR) y vacío si no hay fecha válida', () => {
  assert.equal(formatDateDMY('2026-12-03T15:00:00Z'), '03/12/2026');
  assert.equal(formatDateDMY('2026-01-05T15:00:00Z'), '05/01/2026');
  assert.equal(formatDateDMY(null), '');
  assert.equal(formatDateDMY('no-es-fecha'), '');
});

test('suscripción activa y renovable: se puede cancelar y muestra la fecha de fin del período', () => {
  const st = renewalState(sub(), NOW);
  assert.deepEqual([st.kind, st.canCancel, st.endsOn], ['renews', true, '03/12/2026']);
});

test('renovación cancelada: sigue activa hasta la fecha, NO se ofrece cancelar de nuevo y el aviso lleva la fecha', () => {
  const st = renewalState(sub({ cancelAtPeriodEnd: true, canceledAt: '2026-11-05T10:00:00Z' }), NOW);
  assert.deepEqual([st.kind, st.canCancel, st.endsOn], ['canceled', false, '03/12/2026']);
  assert.equal(canceledNotice(st.endsOn), 'Renovación cancelada. Tu plan seguirá activo hasta el 03/12/2026');
});

test('terminada (vencida, cancelada por el servidor o período cumplido): no admite cancelación', () => {
  assert.equal(renewalState(sub({ status: 'EXPIRED' }), NOW).kind, 'ended');
  assert.equal(renewalState(sub({ status: 'CANCELED' }), NOW).canCancel, false);
  assert.equal(renewalState(sub({ currentPeriodEnd: '2026-11-09T00:00:00Z' }), NOW).kind, 'ended');
});

test('el diálogo explica: deja de renovarse, conserva beneficios hasta la fecha, sin reembolso y puede seguir usando Melodya', () => {
  const { title, points } = cancelDialogCopy('Creator', '03/12/2026');
  assert.match(title, /¿Cancelar la renovación\?/);
  assert.equal(points.length, 4);
  const text = points.join(' ');
  assert.match(text, /Creator dejará de renovarse/);
  assert.match(text, /beneficios del plan hasta el 03\/12\/2026/);
  assert.match(text, /No se realiza un reembolso/);
  assert.match(text, /seguir usando Melodya con normalidad hasta el 03\/12\/2026/);
});

test('la respuesta del servidor decide el resultado: cancelada ahora o ya registrada, con la fecha del período vigente', () => {
  const s = sub({ cancelAtPeriodEnd: true });
  assert.deepEqual(cancelOutcome({ subscription: s, alreadyRequested: false }), { kind: 'canceled', endsOn: '03/12/2026' });
  assert.deepEqual(cancelOutcome({ subscription: s, alreadyRequested: true }), { kind: 'already', endsOn: '03/12/2026' });
});

test('errores del backend: no cancelable, cambió en simultáneo, no encontrada; los de red o sesión usan el mensaje general', () => {
  const conflict = (code) => ({ status: 409, details: { code } });
  assert.equal(cancelRejection(conflict('SUBSCRIPTION_NOT_CANCELABLE')), 'NOT_CANCELABLE');
  assert.equal(cancelRejection(conflict('SUBSCRIPTION_CHANGED')), 'CHANGED');
  assert.equal(cancelRejection(conflict('OTRO')), null);
  assert.equal(cancelRejection({ status: 500 }), null);
  assert.equal(cancelRejection(null), null);
  const fb = 'mensaje general';
  assert.match(cancelErrorMessage(conflict('SUBSCRIPTION_NOT_CANCELABLE'), fb), /ya terminó y no admite cancelación/);
  assert.match(cancelErrorMessage(conflict('SUBSCRIPTION_CHANGED'), fb), /cambió mientras se procesaba/);
  assert.match(cancelErrorMessage({ status: 404 }, fb), /No encontramos esa suscripción/);
  assert.equal(cancelErrorMessage({ status: 401 }, fb), fb, 'sesión vencida: lo resuelve el mensaje general (y el cliente de API)');
  assert.equal(cancelErrorMessage(new Error('Network Error'), fb), fb, 'red: mensaje general');
});

test('el cliente de API llama al endpoint del backend con el id de la suscripción', () => {
  const api = read('../src/lib/api/index.ts');
  assert.match(api, /cancelRenewal: \(subscriptionId: string\)/);
  assert.match(api, /postData<[^>]*>\(`\/billing\/subscriptions\/\$\{encodeURIComponent\(subscriptionId\)\}\/cancel`, \{\}\)/);
});

test('componente: diálogo del Design System (sin alert/confirm nativos), estado de procesamiento, respuesta real del servidor y sin botón cuando ya está cancelada', () => {
  const c = read('../src/features/billing/SubscriptionCard.tsx');
  assert.doesNotMatch(c, /window\.(alert|confirm)|\balert\(|\bconfirm\(/);
  assert.match(c, /AlertDialog/);
  assert.match(c, /Cancelar renovación/);
  assert.match(c, /cancel\.isPending/);
  assert.match(c, /Cancelando…/);
  assert.match(c, /billingApi\.cancelRenewal\(subscription\.id\)/);
  assert.match(c, /\.\.\.res\.subscription/, 'actualiza con lo que respondió el servidor');
  assert.match(c, /useRefreshCommercialState()/, 'y refresca el estado comercial (perfil, consumo, saldo y movimientos) por el mecanismo central');
  assert.match(c, /\{state\.canCancel && \(/, 'la acción solo existe si la renovación se puede cancelar');
  assert.match(c, /canceledNotice\(state\.endsOn\)/);
  assert.match(c, /Conservás los beneficios de tu plan hasta el/);
  assert.match(c, /if \(!cancel\.isPending\) cancel\.mutate\(\)/, 'un segundo clic no repite la operación');
});

test('PricingView muestra la tarjeta solo con sesión y suscripción, y «Vence» en lugar de «Renueva» si la renovación está cancelada', () => {
  const v = read('../src/features/billing/PricingView.tsx');
  assert.match(v, /isLoggedIn && subscription && \(\s*<SubscriptionCard subscription=\{subscription\}/);
  assert.match(v, /renewalCanceled \? 'Vence' : 'Renueva'/);
});

test('precio y periodicidad: salen de lo que informa el servidor, con o sin renovación cancelada; sin datos no se inventa nada', () => {
  const { planPriceParts } = S;
  assert.deepEqual(planPriceParts({ priceCents: 999, currency: 'USD', periodDays: 30 }), { cents: 999, currency: 'USD', period: 'mes' });
  assert.deepEqual(planPriceParts({ priceCents: 999, currency: 'USD', periodDays: 7 }), { cents: 999, currency: 'USD', period: '7 días' });
  assert.deepEqual(planPriceParts({ priceCents: 0, currency: 'USD', periodDays: 30 }), { cents: 0, currency: 'USD', period: 'mes' }, 'un precio en cero es un dato válido');
  assert.deepEqual(planPriceParts({ priceCents: 999, currency: 'USD' }), { cents: 999, currency: 'USD', period: null }, 'sin periodicidad: solo el precio');
  assert.equal(planPriceParts({ priceCents: 999, periodDays: 30 }), null, 'sin moneda no se asume ninguna');
  assert.equal(planPriceParts({ currency: 'USD', periodDays: 30 }), null, 'sin precio no se muestra nada');
  assert.equal(planPriceParts({ id: 'p', code: 'creator', name: 'Creator' }), null, 'plan reducido de un servidor anterior');
  assert.equal(planPriceParts(null), null);
  // El renglón del precio no depende del estado de la renovación: se ve igual con la renovación activa que con la cancelada.
  const c = read('../src/features/billing/SubscriptionCard.tsx');
  assert.match(c, /planPriceParts\(plan\)/);
  assert.doesNotMatch(c, /plan\.currency \|\| 'USD'/, 'no se inventa la moneda');
  const priceLine = c.indexOf('{price ?');
  assert.ok(priceLine > c.indexOf('<p className="text-sm text-muted-foreground">') && priceLine < c.indexOf("state.kind === 'renews' && ("), 'el precio está antes de los bloques por estado');
});
