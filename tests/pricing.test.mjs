// Precio promocional en la web (E8): qué se muestra, cuándo se vuelve a pedir el catálogo y cómo se trata el 409 PRICE_CHANGED.
// Ejecutar: node --test "tests/*.test.mjs"  (sin dependencias nuevas; Node 24 carga .ts directamente).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const P = await import('../src/lib/pricing.ts');
const { priceView, promotionEndsText, serverNowMs, msUntilNextPromotionEnd, priceChanged } = P;

const promo = { code: 'BF-2026', name: 'Black Friday', description: null, startsAt: '2026-11-27T00:00:00Z', endsAt: '2026-11-30T02:59:00Z' };
const plan = { priceCents: 1499, previousPriceCents: null };
const withPromo = (over = {}) => ({ ...plan, pricing: { currency: 'USD', listPriceCents: 1499, discountCents: 300, finalPriceCents: 1199, strikeThroughCents: 1499, promotion: promo, ...over } });

test('con promoción: el precio final, el tachado y el ahorro vienen del servidor (la web no calcula nada)', () => {
  const v = priceView(withPromo());
  assert.deepEqual([v.finalCents, v.strikeCents, v.savingsCents], [1199, 1499, 300]);
  assert.deepEqual([v.promotion.name, v.promotion.endsAt], ['Black Friday', promo.endsAt]);
  // Si el servidor dijera otro importe, ese es el que se muestra: no hay cálculo propio.
  assert.equal(priceView(withPromo({ finalPriceCents: 1000, discountCents: 499 })).finalCents, 1000);
});

test('sin promoción rige el comportamiento de siempre: el «precio anterior» manual se tacha solo si es mayor', () => {
  assert.deepEqual(priceView({ priceCents: 1999, previousPriceCents: 2499 }), { finalCents: 1999, strikeCents: 2499, savingsCents: null, promotion: null });
  assert.equal(priceView({ priceCents: 1999, previousPriceCents: 1999 }).strikeCents, null);
  assert.equal(priceView({ priceCents: 1999, previousPriceCents: 500 }).strikeCents, null);
  assert.equal(priceView({ priceCents: 1999, previousPriceCents: null }).strikeCents, null);
  const noPromoPricing = priceView({ ...plan, pricing: { currency: 'USD', listPriceCents: 1499, discountCents: 0, finalPriceCents: 1499, strikeThroughCents: null, promotion: null } });
  assert.deepEqual([noPromoPricing.finalCents, noPromoPricing.promotion], [1499, null]);
});

test('con promoción, el tachado es el precio de lista aunque el catálogo tenga un «precio anterior» manual', () => {
  const v = priceView({ priceCents: 1499, previousPriceCents: 2999, pricing: withPromo().pricing });
  assert.equal(v.strikeCents, 1499);
});

test('vigencia: «hasta el …» solo si la promoción termina', () => {
  assert.match(promotionEndsText('2026-11-30T12:00:00Z'), /^hasta el 30 de noviembre$/);
  assert.equal(promotionEndsText(null), null);
  assert.equal(promotionEndsText('no es una fecha'), null);
});

test('el vencimiento se mide con el reloj del servidor, no con el del navegador', () => {
  const received = 1_000_000;
  // El navegador está 10 minutos adelantado: la hora del servidor manda.
  assert.equal(serverNowMs('2026-11-29T12:00:00Z', received, received + 5000), Date.parse('2026-11-29T12:00:00Z') + 5000);
  assert.equal(serverNowMs(undefined, received, 777), 777, 'sin hora del servidor se usa la local');
  assert.equal(serverNowMs('basura', received, 777), 777);
  const now = Date.parse('2026-11-30T02:00:00Z');
  const items = [withPromo(), { priceCents: 1, previousPriceCents: null }, withPromo({ promotion: { ...promo, endsAt: '2026-12-05T00:00:00Z' } })];
  assert.equal(msUntilNextPromotionEnd(items, now), 59 * 60_000, 'la que vence primero');
  assert.equal(msUntilNextPromotionEnd(items, Date.parse('2026-12-31T00:00:00Z')), null, 'todas terminadas');
  assert.equal(msUntilNextPromotionEnd([{ priceCents: 1, previousPriceCents: null }], now), null);
  assert.equal(msUntilNextPromotionEnd([withPromo({ promotion: { ...promo, endsAt: null } })], now), null, 'sin fin no hay nada que esperar');
});

test('PRICE_CHANGED se reconoce solo en un 409 con ese código y trae la cotización nueva', () => {
  const err = { status: 409, details: { code: 'PRICE_CHANGED', finalPriceCents: 1499, listPriceCents: 1499, discountCents: 0 } };
  assert.deepEqual(priceChanged(err), { finalPriceCents: 1499, listPriceCents: 1499, discountCents: 0 });
  assert.equal(priceChanged({ status: 409, details: { code: 'SUBSCRIPTION_ALREADY_ACTIVE' } }), null);
  assert.equal(priceChanged({ status: 422, details: err.details }), null);
  assert.equal(priceChanged(null), null);
  assert.equal(priceChanged(new Error('x')), null);
});

/* ── La integración en las pantallas: el checkout no fija el importe y nada de la promoción se calcula acá ── */
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const pricingView = read('../src/features/billing/PricingView.tsx');
const bannersSrc = read('../src/components/banners/index.tsx');
const apiSrc = read('../src/lib/api/index.ts');

test('el checkout envía el importe visto SOLO como expectedFinalPriceCents (para detectar desfasajes), y ante PRICE_CHANGED vuelve a pedir el catálogo', () => {
  assert.match(pricingView, /expectedFinalPriceCents: p\.expectedFinalCents/);
  assert.match(pricingView, /expectedFinalCents: priceView\((pack|plan)\)\.finalCents/g);
  assert.match(pricingView, /if \(priceChanged\(err\)\)/);
  assert.match(pricingView, /invalidateQueries\(\{ queryKey: \['plans'\] \}\)/);
  assert.match(apiSrc, /expectedFinalPriceCents\?: number/);
});

test('las tarjetas toman precio, tachado y ahorro de priceView (servidor) y no recalculan el porcentaje de una promoción', () => {
  assert.match(pricingView, /const view = priceView\(pack\)/);
  assert.match(pricingView, /const view = priceView\(plan\)/);
  // el único porcentaje que queda es el del «precio anterior» manual y solo cuando NO hay promoción
  assert.equal((pricingView.match(/!view\.promotion && hasPrevious/g) || []).length, 2);
  assert.match(pricingView, /ahorrás \{formatPriceCents\(view\.savingsCents!/);
});

test('el catálogo se vuelve a pedir cuando vence la promoción que se muestra (con el reloj del servidor) y la clave incluye al usuario', () => {
  assert.match(pricingView, /msUntilNextPromotionEnd\(\[\.\.\.plans, \.\.\.packs\], serverNowMs\(/);
  assert.match(pricingView, /queryKey: \['plans', priceScope\]/);
  assert.match(pricingView, /queryKey: \['credit-packages', priceScope\]/);
});

test('el banner solo nombra la campaña y su vencimiento: no muestra ni calcula precios', () => {
  assert.match(bannersSrc, /function BannerPromoChip/);
  const chip = bannersSrc.slice(bannersSrc.indexOf('function BannerPromoChip'), bannersSrc.indexOf('export function useBanners'));
  assert.doesNotMatch(chip, /priceCents|discount|%/i);
  assert.equal((bannersSrc.match(/<BannerPromoChip /g) || []).length, 3, 'hero, slider y promo');
});
