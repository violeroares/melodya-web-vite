/**
 * MELODYA WEB (Vite) — Contrato ÚNICO de URLs públicas y compartibles.
 *
 * Todo enlace que la web genera para compartir sale de acá (no se incrusta el dominio de producción en componentes):
 *  • Canción:        {origen}/songs/:id
 *  • Perfil público: {origen}/user/:id
 *  • Radio:          {origen}/community?radio=<sort>[&genre=<g>]
 *  • Recuperación:   {origen}/reset-password#token=…   (formato recomendado; ver extractResetToken)
 *
 * Origen: VITE_PUBLIC_ORIGIN si está definido (producción: https://app.melodya.com.ar); si no, el origen actual
 * (desarrollo local: http://localhost:3100). Este mismo contrato de paths es el que se declararía en Android App Links
 * (assetlinks.json + intent-filter) e iOS Universal Links (apple-app-site-association); ver docs/MOBILE-LINKS.md.
 */

type EnvBag = Record<string, string | undefined>;

function readPublicOriginEnv(): string {
  const viteEnv = (import.meta as unknown as { env?: EnvBag }).env;
  const nodeEnv = (globalThis as unknown as { process?: { env?: EnvBag } }).process?.env;
  return (viteEnv?.VITE_PUBLIC_ORIGIN ?? nodeEnv?.VITE_PUBLIC_ORIGIN ?? '').trim();
}

/** Origen público (sin barra final). */
export function publicOrigin(): string {
  const fromEnv = readPublicOriginEnv().replace(/\/+$/, '');
  if (fromEnv) return fromEnv;
  return typeof window !== 'undefined' ? window.location.origin : '';
}

export const songPath = (id: string) => `/songs/${encodeURIComponent(id)}`;
export const userPath = (id: string) => `/user/${encodeURIComponent(id)}`;

export const songUrl = (id: string) => `${publicOrigin()}${songPath(id)}`;
export const userUrl = (id: string) => `${publicOrigin()}${userPath(id)}`;

export function radioUrl(sort: string, genre?: string | null): string {
  const base = `${publicOrigin()}/community?radio=${encodeURIComponent(sort)}`;
  return genre ? `${base}&genre=${encodeURIComponent(genre)}` : base;
}

export const RESET_PASSWORD_PATH = '/reset-password';

/**
 * Token de restablecimiento. Formatos aceptados:
 *  1. `/reset-password#token=…`  ← recomendado: el fragmento no viaja al servidor ni en el Referer.
 *  2. `/reset-password?token=…`    ← compatibilidad con enlaces en query.
 * (El enlace con `/#/reset-password?token=…` que emite hoy el backend se convierte al formato 1 en
 *  `migrateLegacyResetLink`, antes de montar el router.)
 */
export function extractResetToken(query: URLSearchParams, hash: string = typeof window !== 'undefined' ? window.location.hash : ''): string {
  const fromQuery = query.get('token');
  if (fromQuery) return fromQuery;
  const frag = hash.replace(/^#/, '');
  if (!frag) return '';
  return new URLSearchParams(frag.includes('=') ? frag : '').get('token') ?? '';
}

/**
 * ÚNICA compatibilidad con el esquema `/#/…`: el backend (que no se modifica en esta etapa) arma el correo de
 * recuperación como `${WEB_URL}/#/reset-password?token=…`. Si la página abre con ese fragmento, se reescribe a
 * `/reset-password#token=…` (replaceState, sin recargar). No hay ningún otro router por hash: cuando el backend emita
 * el enlace limpio, este shim se elimina. Devuelve true si migró algo.
 */
export function migrateLegacyResetLink(loc: Pick<Location, 'hash' | 'pathname'> = window.location): boolean {
  const m = /^#\/reset-password\?(.+)$/.exec(loc.hash);
  if (!m || (loc.pathname !== '/' && loc.pathname !== '')) return false;
  const token = new URLSearchParams(m[1]).get('token');
  if (!token) return false;
  window.history.replaceState(window.history.state, '', `${RESET_PASSWORD_PATH}#token=${encodeURIComponent(token)}`);
  return true;
}
