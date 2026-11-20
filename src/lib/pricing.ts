/**
 * MELODYA WEB — Precio de un plan o pack con su promoción (E8). Lógica pura, sin React ni dependencias de la aplicación.
 *
 * El backend es la fuente de verdad: `pricing` (GET /plans y /plans/credit-packages) trae el precio final, el descuento, el tachado y la
 * promoción aplicada, calculados por la MISMA cotización que usa la orden. Acá NO se calcula ningún precio ni porcentaje de una
 * promoción: solo se elige qué mostrar y cómo. El importe que se envía en el checkout (`expectedFinalPriceCents`) únicamente permite al
 * servidor detectar desfasajes (409 PRICE_CHANGED); nunca fija el cobro.
 */

export interface Pricing {
  currency: string;
  listPriceCents: number;
  discountCents: number;
  finalPriceCents: number;
  /** Precio de lista a mostrar tachado cuando hay una promoción; null si no la hay. */
  strikeThroughCents: number | null;
  promotion: { code: string; name: string; description: string | null; startsAt: string; endsAt: string | null } | null;
}

export interface PriceSource {
  priceCents: number;
  previousPriceCents: number | null;
  pricing?: Pricing;
}

export interface PriceView {
  /** Lo que se cobra hoy (la fuente es siempre el servidor). */
  finalCents: number;
  /** Importe tachado: el de lista si hay promoción; si no, el «precio anterior» manual del catálogo (C10 pendiente). */
  strikeCents: number | null;
  /** Lo que ahorra el usuario, solo con promoción (viene del servidor, no se calcula). */
  savingsCents: number | null;
  promotion: { name: string; description: string | null; endsAt: string | null } | null;
}

export function priceView(item: PriceSource): PriceView {
  const p = item.pricing;
  if (p && p.promotion && p.discountCents > 0) {
    return {
      finalCents: p.finalPriceCents,
      strikeCents: p.strikeThroughCents ?? p.listPriceCents,
      savingsCents: p.discountCents,
      promotion: { name: p.promotion.name, description: p.promotion.description, endsAt: p.promotion.endsAt },
    };
  }
  const previous = item.previousPriceCents != null && item.previousPriceCents > item.priceCents ? item.previousPriceCents : null;
  return { finalCents: p ? p.finalPriceCents : item.priceCents, strikeCents: previous, savingsCents: null, promotion: null };
}

/** «hasta el 30 de noviembre». Las promociones sin fin no muestran fecha. */
export function promotionEndsText(endsAt: string | null | undefined, locale = 'es-AR'): string | null {
  if (!endsAt) return null;
  const d = new Date(endsAt);
  if (Number.isNaN(d.getTime())) return null;
  return `hasta el ${d.toLocaleDateString(locale, { day: 'numeric', month: 'long' })}`;
}

/** Reloj del servidor estimado: la hora que informó + el tiempo transcurrido desde que llegó la respuesta. */
export function serverNowMs(serverTime: string | undefined, receivedAtMs: number | undefined, nowMs: number): number {
  const server = serverTime ? Date.parse(serverTime) : NaN;
  if (Number.isNaN(server) || receivedAtMs === undefined) return nowMs;
  return server + (nowMs - receivedAtMs);
}

/**
 * Cuándo vence la primera promoción que se está mostrando (ms desde ahora, según el reloj del servidor), para volver a pedir el precio
 * justo después y que el catálogo no siga mostrando una oferta terminada. null = ninguna vence.
 */
export function msUntilNextPromotionEnd(items: PriceSource[], serverNow: number): number | null {
  let best: number | null = null;
  for (const item of items) {
    const end = item.pricing?.promotion?.endsAt ? Date.parse(item.pricing.promotion.endsAt) : NaN;
    if (Number.isNaN(end) || end <= serverNow) continue;
    const ms = end - serverNow;
    if (best === null || ms < best) best = ms;
  }
  return best;
}

/** 409 PRICE_CHANGED del checkout: la cotización nueva que informa el servidor, o null si el error es otro. */
export function priceChanged(err: unknown): { finalPriceCents: number; listPriceCents?: number; discountCents?: number } | null {
  const e = err as { status?: unknown; details?: unknown } | null;
  if (!e || typeof e !== 'object' || e.status !== 409) return null;
  const d = e.details as { code?: string; finalPriceCents?: number; listPriceCents?: number; discountCents?: number } | undefined;
  if (!d || d.code !== 'PRICE_CHANGED' || typeof d.finalPriceCents !== 'number') return null;
  return { finalPriceCents: d.finalPriceCents, listPriceCents: d.listPriceCents, discountCents: d.discountCents };
}
