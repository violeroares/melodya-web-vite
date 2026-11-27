/**
 * Entrada a Melodya Store con la sesión que el usuario ya tiene en Web (sin volver a pedir usuario y contraseña, y sin tokens en la URL).
 *
 *  1. Se pide al backend un código de UN solo uso (`POST /auth/store-code`, con la sesión habitual; vale 60 s).
 *  2. Se abre Store con `/auth/callback?code=…`: el SERVIDOR de Store canjea el código y guarda la sesión en cookies httpOnly.
 *
 * El mismo mecanismo lo usan Android e iOS (mismo login del backend). `VITE_STORE_URL` es el origen de Store.
 */
import { postData } from './api/client';

/* Vite expone VITE_* en import.meta.env; bajo node (pruebas) se lee de process.env (mismo criterio que lib/api/client.ts). */
function configuredStoreUrl(): string | undefined {
  const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_STORE_URL;
  const nodeEnv = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env?.VITE_STORE_URL;
  return viteEnv ?? nodeEnv;
}

export function storeBaseUrl(raw: string | undefined | null = configuredStoreUrl()): string | null {
  const value = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
  if (!value) return null;
  try {
    const url = new URL(value);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    return url.protocol === 'https:' || (url.protocol === 'http:' && local) ? url.origin : null;
  } catch {
    return null;
  }
}

/** Destino interno de Store permitido (nunca una URL externa). */
const SAFE_NEXT = /^\/[A-Za-z0-9/_-]*(#[A-Za-z0-9_-]+)?$/;

/**
 * Qué hace el botón «Comprar» de un PAQUETE de fichas. Los paquetes se pagan SOLO en Store (Mercado Pago): nunca se hace una compra simulada sin querer.
 *  • sin sesión → pedir que ingrese;  • Store no configurada → avisar (no se compra nada);  • Store configurada → abrir Store con la sesión.
 */
export type PackBuyMode = 'login' | 'store-not-configured' | 'open-store';
export function packBuyMode({ loggedIn, storeUrl = configuredStoreUrl() }: { loggedIn: boolean; storeUrl?: string | null }): PackBuyMode {
  if (!loggedIn) return 'login';
  return storeBaseUrl(storeUrl) ? 'open-store' : 'store-not-configured';
}

/** Producto que el usuario eligió en Web y que Store abre directamente (plan o paquete de fichas). Es solo una intención: Store la valida y el backend decide si se puede comprar. */
export type StoreProduct = { kind: 'plan' | 'pack'; id: string };
const PRODUCT_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Parámetro de la entrada a Store para el producto elegido (`plan=<id>` / `pack=<id>`), o null si el id no tiene formato válido. */
export function storeProductParam(product: StoreProduct | null | undefined): [string, string] | null {
  if (!product || !['plan', 'pack'].includes(product.kind) || typeof product.id !== 'string' || !PRODUCT_ID.test(product.id)) return null;
  return [product.kind, product.id];
}

export async function buildStoreUrl(next = '/store', product?: StoreProduct | null): Promise<string> {
  const base = storeBaseUrl();
  if (!base) throw new Error('La tienda todavía no está configurada (VITE_STORE_URL).');
  const { code } = await postData<{ code: string; expiresAt: string }>('/auth/store-code', {});
  const params = new URLSearchParams({ code });
  if (SAFE_NEXT.test(next) && !next.startsWith('//')) params.set('next', next);
  const chosen = storeProductParam(product); // C5: el producto elegido viaja hasta Store (el canje de la sesión no cambia)
  if (chosen) params.set(chosen[0], chosen[1]);
  return `${base}/auth/callback?${params.toString()}`;
}

/** Abre Store en esta pestaña con la sesión actual (y, si se indica, con el producto elegido). */
export async function openStore(next = '/store', product?: StoreProduct | null): Promise<void> {
  window.location.assign(await buildStoreUrl(next, product));
}
