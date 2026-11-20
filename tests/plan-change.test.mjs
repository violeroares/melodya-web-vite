// Plan efectivo (Free es el plan BASE), cambios de plan programados, reanudación y capacidades del plan (web): lógica pura + garantías estáticas.
// Ejecutar: node --test "tests/*.test.mjs"  (Node 24 carga .ts directamente).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const S = await import('../src/lib/subscription.ts');
const { planRole, planTitle, planCtaLabel, changeDialogCopy, scheduledChangeView, changeScheduledNotice, resumeNotice, planCapabilityLines, upgradeDialogCopy, upgradeConfirmLabel, upgradeAppliedNotice, upgradeQuoteErrorMessage } = S;
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

const FREE = { id: 'p_free', isDefault: true, priceCents: 0 };
const CREATOR = { id: 'p_cr', isDefault: false, priceCents: 999 };
const PRO = { id: 'p_pro', isDefault: false, priceCents: 1999 };
const BASE = { id: 'p_free', isDefault: true };
const sub = (plan, over = {}) => ({ status: 'ACTIVE', plan, pendingPlan: null, ...over });

test('usuario Free: Free es su plan actual (no contratable) y Creator y Pro se pueden contratar', () => {
  const ctx = { effectivePlan: BASE, subscription: null };
  assert.equal(planRole(FREE, ctx), 'base-current');
  assert.equal(planRole(CREATOR, ctx), 'subscribe');
  assert.equal(planRole(PRO, ctx), 'subscribe');
  assert.equal(planCtaLabel('base-current', 'Free'), null, 'Free no tiene botón de compra');
  assert.equal(planCtaLabel('subscribe', 'Creator'), 'Suscribirme');
});

test('usuario sin sesión: Free es el plan base y los pagos se contratan', () => {
  assert.equal(planRole(FREE, {}), 'base');
  assert.equal(planRole(PRO, {}), 'subscribe');
});

test('usuario Creator: Creator es el actual, Pro es un upgrade y Free queda como plan base (no es su plan)', () => {
  const ctx = { effectivePlan: { id: 'p_cr', isDefault: false }, subscription: sub(CREATOR) };
  assert.equal(planRole(CREATOR, ctx), 'current');
  assert.equal(planRole(PRO, ctx), 'upgrade');
  assert.equal(planRole(FREE, ctx), 'base');
  assert.equal(planCtaLabel('upgrade', 'Pro'), 'Comprar Pro ahora', 'el upgrade se compra y se activa ya');
});

test('usuario Pro: Pro es el actual y Creator es un downgrade', () => {
  const ctx = { effectivePlan: { id: 'p_pro', isDefault: false }, subscription: sub(PRO) };
  assert.equal(planRole(PRO, ctx), 'current');
  assert.equal(planRole(CREATOR, ctx), 'downgrade');
  assert.equal(planCtaLabel('downgrade', 'Creator'), 'Cambiar a Creator');
});

test('cambio programado: el plan destino figura como «programado», nunca como el actual', () => {
  const ctx = { effectivePlan: { id: 'p_cr', isDefault: false }, subscription: sub(CREATOR, { pendingPlan: { id: 'p_pro' } }) };
  assert.equal(planRole(PRO, ctx), 'scheduled');
  assert.equal(planRole(CREATOR, ctx), 'current');
});

test('una suscripción terminada no cuenta: se vuelve a poder contratar', () => {
  const ctx = { effectivePlan: BASE, subscription: sub(CREATOR, { status: 'EXPIRED' }) };
  assert.equal(planRole(CREATOR, ctx), 'subscribe');
});

test('títulos: «Tu plan Free», «Tu plan Creator», «Tu plan Pro»', () => {
  assert.equal(planTitle({ name: 'Free' }), 'Tu plan Free');
  assert.equal(planTitle({ name: 'Creator' }), 'Tu plan Creator');
  assert.equal(planTitle({ name: 'Pro' }), 'Tu plan Pro');
  assert.equal(planTitle(null), 'Tu plan');
});

test('confirmación del downgrade programado: qué rige hoy, qué regirá y desde cuándo; sin cobro ahora; se puede deshacer', () => {
  const down = changeDialogCopy('DOWNGRADE', 'Pro', 'Creator', '03/12/2026');
  assert.equal(down.title, '¿Cambiar a Creator?');
  assert.match(down.points[0], /Hoy seguís con Pro.*hasta el 03\/12\/2026/);
  assert.match(down.points[1], /Desde el 03\/12\/2026.*pasa a Creator/);
  assert.match(down.points.join(' '), /No se cobra nada ahora/);
  assert.match(down.points.join(' '), /deshacerlo antes/);
});

const money = (cents, currency) => `${currency} ${(cents / 100).toFixed(2)}`;
const QUOTE = { currency: 'USD', fromPlan: { name: 'Creator' }, toPlan: { name: 'Pro' }, listPriceCents: 1999, creditAppliedCents: 399, finalPriceCents: 1600, monthlyCredits: 1200, nextRenewalAt: '2026-12-03T21:46:47.709Z' };

test('confirmación del upgrade inmediato: importe proporcional del servidor, activación inmediata, período nuevo y próxima renovación', () => {
  const c = upgradeDialogCopy(QUOTE, money);
  assert.equal(c.title, '¿Comprar Pro ahora?');
  assert.deepEqual(c.rows.map((r) => [r.label, r.value, Boolean(r.strong)]), [
    ['Precio de Pro', 'USD 19.99', false],
    ['Crédito por tu Creator sin usar', '−USD 3.99', false],
    ['Pagás ahora', 'USD 16.00', true],
  ]);
  const text = c.points.join(' ');
  assert.match(text, /Pro se activa de inmediato/);
  assert.match(text, /nuevo período mensual hoy/);
  assert.match(text, /1\.200 fichas de Pro/);
  assert.match(text, /fichas permanentes se conservan/);
  assert.match(text, /Próxima renovación: 03\/12\/2026/);
  assert.doesNotMatch(text, /No se cobra nada ahora/, 'el upgrade SÍ se cobra ahora');
  assert.equal(upgradeConfirmLabel('Pro'), 'Comprar Pro ahora');
  // sin crédito (sin evidencia de pago) no hay fila de crédito
  assert.equal(upgradeDialogCopy({ ...QUOTE, creditAppliedCents: 0, finalPriceCents: 1999 }, money).rows.length, 2);
});

test('upgrade aplicado: se anuncia el plan activo y la próxima renovación (nunca un cambio programado)', () => {
  const n = upgradeAppliedNotice({ plan: { name: 'Pro' }, currentPeriodEnd: '2026-12-03T21:46:47.709Z' }, 1200, 'Pro');
  assert.equal(n.title, '¡Pro activo!');
  assert.match(n.description, /Sumaste 1\.200 fichas de tu plan Pro/);
  assert.match(n.description, /Próxima renovación: 03\/12\/2026/);
  assert.doesNotMatch(`${n.title} ${n.description}`, /programad|Seguís con/i);
  assert.equal(upgradeAppliedNotice(null, 1200, 'Pro').title, '¡Pro activo!');
});

test('mensajes de la cotización: pago pendiente, renovación en curso, otros motivos y fallo de red', () => {
  const err = (reason) => ({ status: 409, details: { code: 'UPGRADE_NOT_AVAILABLE', reason } });
  assert.match(upgradeQuoteErrorMessage(err('PAYMENT_PENDING')), /pago pendiente/);
  assert.match(upgradeQuoteErrorMessage(err('PERIOD_ENDED')), /renovando/);
  assert.match(upgradeQuoteErrorMessage(err('SAME_PLAN')), /Por ahora no podés mejorar/);
  assert.match(upgradeQuoteErrorMessage(new Error('red')), /No pudimos cotizar/);
});

test('PricingView: el upgrade usa la cotización del servidor como importe esperado y ante PRICE_CHANGED vuelve a cotizar sin cobrar; el downgrade sigue programado', () => {
  const view = read('../src/features/billing/PricingView.tsx');
  assert.match(view, /billingApi\.upgradeQuote\(upgradePlan!\.id\)/);
  assert.match(view, /expectedFinalCents: isUpgrade && quote \? quote\.finalPriceCents : priceView\(target\)\.finalCents/);
  assert.match(view, /p\.kind === 'PLAN' && p\.upgrade && priceChanged\(err\)/);
  assert.match(view, /upgradeQuoteQuery\.refetch\(\)/);
  assert.match(view, /upgradeConfirmLabel\(changeTarget\.plan\.name\) : 'Programar el cambio'/);
  assert.match(view, /changeDialogCopy\('DOWNGRADE'/);
  assert.match(view, /p\.kind === 'PLAN' && p\.upgrade\) \{[\s\S]*upgradeAppliedNotice/);
});

test('cambio programado visible: plan vigente, cambio futuro, fecha y qué pasará ese día', () => {
  const v = scheduledChangeView({ kind: 'UPGRADE', toPlan: { name: 'Pro' }, effectiveAt: '2026-12-03T21:46:47.709Z' }, 'Creator');
  assert.equal(v.current, 'Plan vigente: Creator');
  assert.equal(v.future, 'Desde el 03/12/2026: Pro');
  assert.match(v.what, /pasa a Pro/);
  assert.match(v.what, /conservás Creator/);
  assert.equal(scheduledChangeView(null, 'Creator'), null);
});

test('cancelación visible: vuelve a Free y el contenido se conserva', () => {
  const v = scheduledChangeView({ kind: 'CANCELLATION', toPlan: { name: 'Free' }, effectiveAt: '2026-12-03T21:46:47.709Z' }, 'Pro');
  assert.equal(v.future, 'Desde el 03/12/2026: Free');
  assert.match(v.what, /volvés al plan Free/);
  assert.match(v.what, /Conservás tus canciones/);
  assert.match(scheduledChangeView({ kind: 'CANCELLATION', toPlan: null, effectiveAt: '2026-12-03T00:00:00Z' }, 'Pro').future, /: Free$/);
});

test('avisos: el cambio queda PROGRAMADO (no aplicado) y reanudar informa lo que deshizo', () => {
  const n = changeScheduledNotice({ kind: 'DOWNGRADE', effectiveAt: '2026-12-03T21:46:47.709Z', fromPlan: { name: 'Pro' }, toPlan: { name: 'Creator' }, alreadyScheduled: false });
  assert.equal(n.title, 'Cambio de plan programado');
  assert.match(n.description, /Seguís con Pro hasta el 03\/12\/2026.*pasás a Creator/);
  assert.equal(changeScheduledNotice({ kind: 'DOWNGRADE', effectiveAt: '2026-12-03T21:46:47.709Z', fromPlan: { name: 'Pro' }, toPlan: { name: 'Creator' }, alreadyScheduled: true }).title, 'El cambio ya estaba programado');
  assert.equal(resumeNotice({ resumed: 'CANCELLATION' }).title, 'Renovación reactivada');
  assert.equal(resumeNotice({ resumed: 'PLAN_CHANGE' }).title, 'Cambio de plan deshecho');
  assert.equal(resumeNotice({ alreadyActive: true, resumed: null }).title, 'No había nada para deshacer');
});

test('capacidades y límites: Free (15 canciones, sin descargas ni asistente de letras), Creator y Pro según el servidor; lo que falta no está incluido', () => {
  const free = planCapabilityLines({
    SONGS_PER_PERIOD: { enabled: true, limit: 15 }, DOWNLOADS_PER_PERIOD: { enabled: true, limit: 0 }, DOWNLOAD_AUDIO: { enabled: false },
    COVER_ART: { enabled: true }, LYRICS_AI: { enabled: false },
  });
  const by = (lines) => Object.fromEntries(lines.map((l) => [l.key, l]));
  const f = by(free);
  assert.deepEqual([f.SONGS_PER_PERIOD.included, f.SONGS_PER_PERIOD.detail], [true, '15']);
  assert.equal(f.DOWNLOADS_PER_PERIOD.included, false);
  assert.equal(f.COVER_ART.included, true);
  assert.equal(f.LYRICS_AI.included, false);
  assert.equal(f.VOICE_CLONING.included, false, 'sin fila = no incluida');

  const pro = by(planCapabilityLines({
    SONGS_PER_PERIOD: { enabled: true, limit: 100 }, DOWNLOADS_PER_PERIOD: { enabled: true, limit: 60 }, DOWNLOAD_AUDIO: { enabled: true },
    VOICE_CLONING: { enabled: true }, AUDIO_REFERENCE: { enabled: true },
  }));
  assert.deepEqual([pro.SONGS_PER_PERIOD.detail, pro.DOWNLOADS_PER_PERIOD.detail], ['100', '60']);
  assert.deepEqual([pro.VOICE_CLONING.included, pro.AUDIO_REFERENCE.included], [true, true]);
  assert.equal(planCapabilityLines(null).every((l) => !l.included), true, 'sin datos nada se presenta como incluido');
});

test('la web no calcula ni inventa nada: usa el plan efectivo y el cambio programado del servidor, y reanuda con el endpoint existente', () => {
  const pricing = read('../src/features/billing/PricingView.tsx');
  assert.match(pricing, /user\?\.effectivePlan/);
  assert.match(pricing, /billingApi\.resumeSubscription/);
  assert.match(pricing, /res\?\.change/);
  const card = read('../src/features/billing/SubscriptionCard.tsx');
  assert.match(card, /scheduledChangeView\(subscription\.scheduledChange/);
  assert.match(card, /Reactivar renovación/);
  const api = read('../src/lib/api/index.ts');
  assert.match(api, /\/billing\/subscriptions\/\$\{encodeURIComponent\(subscriptionId\)\}\/resume/);
  assert.match(api, /\/billing\/mock-checkout/);
  assert.doesNotMatch(api, /\/store|checkout\/session/i, 'no se inventa un contrato con el Store');
});

test('LYRICS_AI solo bloquea el asistente de letras, no la creación de canciones a partir de una idea', () => {
  const model = read('../src/features/creator/song-model.ts');
  assert.doesNotMatch(model, /locks\.lyricsAi/);
});
