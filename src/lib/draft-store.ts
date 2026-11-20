/**
 * MELODYA WEB — Borradores locales del creador (contrato «DraftV1»).
 *
 * El borrador es lo que el usuario armó y TODAVÍA no envió. Vive solo en este dispositivo (no hay sincronización con el backend) y
 * está aislado por cuenta:
 *   • la clave de almacenamiento incluye el `userId`;
 *   • el registro guardado también lleva el `userId`, y al leer se exige que coincida con la sesión (un registro que no es de esta
 *     cuenta se trata como inexistente, nunca se muestra);
 *   • cerrar sesión NO borra borradores: quedan guardados y solo reaparecen cuando entra la misma cuenta.
 *
 * Lógica pura (sin React ni acceso directo a `window`): el almacenamiento se inyecta, así se prueba con `node --test`.
 *
 * BORRADOR LEGADO (`melodya.creator.solar.v1`): el formato anterior no guardaba de quién era, así que no se puede atribuir a ninguna
 * cuenta. Este módulo NUNCA lo lee, NUNCA lo escribe y NUNCA lo borra: queda intacto en el navegador, inaccesible para la interfaz.
 * Cómo recuperarlo a mano: docs/borradores-locales.md.
 */

export const DRAFT_VERSION = 1;
export const DRAFT_PREFIX = 'melodya.draft.v1';
/** Clave del formato anterior (sin dueño). Solo se documenta aquí: ningún código la toca. */
export const LEGACY_DRAFT_KEY = 'melodya.creator.solar.v1';

export type RemixModeLike = 'COVER' | 'PROMPT_REUSE';

/** Un borrador por contexto. Los remixes guardan la versión de origen de forma explícita (nunca «la vigente»). */
export type DraftContext =
  | { kind: 'NEW' }
  | { kind: 'VERSION'; songId: string }
  | { kind: 'REMIX'; songId: string; versionId: string; mode: RemixModeLike }
  | { kind: 'RETRY'; retryOf: string };

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface Draft {
  v: typeof DRAFT_VERSION;
  userId: string;
  context: DraftContext;
  updatedAt: string;
  /** Estado del editor; su forma la define y sanea cada cliente (en la web, `parseSong`). */
  state: unknown;
}

const part = (s: string): string => encodeURIComponent(s);

/** Identificador estable del contexto (parte de la clave). `null` si el contexto está incompleto. */
export function contextKey(ctx: DraftContext): string | null {
  switch (ctx.kind) {
    case 'NEW':
      return 'new';
    case 'VERSION':
      return ctx.songId ? `version.${part(ctx.songId)}` : null;
    case 'REMIX':
      return ctx.songId && ctx.versionId && ctx.mode ? `remix.${part(ctx.songId)}.${part(ctx.versionId)}.${ctx.mode}` : null;
    case 'RETRY':
      return ctx.retryOf ? `retry.${part(ctx.retryOf)}` : null;
    default:
      return null;
  }
}

/** Clave de almacenamiento del borrador. `null` sin cuenta identificada o con contexto incompleto: en ese caso no se lee ni se escribe. */
export function draftKey(userId: string | null | undefined, ctx: DraftContext): string | null {
  const ctxPart = contextKey(ctx);
  if (!userId || !ctxPart) return null;
  return `${DRAFT_PREFIX}.${part(userId)}.${ctxPart}`;
}

/**
 * Lee el borrador de ESTA cuenta y contexto. Devuelve `null` si no existe, está corrupto, es de otra cuenta o tiene un formato más
 * nuevo que este cliente (en todos esos casos NO se modifica lo guardado).
 */
export function readDraft(storage: StorageLike | null, userId: string | null | undefined, ctx: DraftContext): Draft | null {
  const key = draftKey(userId, ctx);
  if (!storage || !key) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Draft> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.v !== DRAFT_VERSION) return null; // formato desconocido: puede haberlo escrito un cliente más nuevo; no se toca
    if (parsed.userId !== userId) return null; // el contenido manda: aunque la clave coincida, un registro ajeno no se muestra
    if (contextKey(parsed.context as DraftContext) !== contextKey(ctx)) return null;
    if (typeof parsed.updatedAt !== 'string') return null;
    return parsed as Draft;
  } catch {
    return null; // almacenamiento no disponible o JSON corrupto
  }
}

/** Guarda el borrador de esta cuenta y contexto. `false` si no se pudo (sin cuenta, contexto incompleto o almacenamiento no disponible). */
export function writeDraft(storage: StorageLike | null, userId: string | null | undefined, ctx: DraftContext, state: unknown, now: Date = new Date()): boolean {
  const key = draftKey(userId, ctx);
  if (!storage || !key || !userId) return false;
  const draft: Draft = { v: DRAFT_VERSION, userId, context: ctx, updatedAt: now.toISOString(), state };
  try {
    storage.setItem(key, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

/** Borra SOLO el borrador de esta cuenta y contexto (al enviarse, al empezar de cero). Nunca toca el de otras cuentas ni el legado. */
export function clearDraft(storage: StorageLike | null, userId: string | null | undefined, ctx: DraftContext): void {
  const key = draftKey(userId, ctx);
  if (!storage || !key) return;
  try {
    storage.removeItem(key);
  } catch {
    /* sin almacenamiento: nada que borrar */
  }
}

/** Almacenamiento del navegador, o `null` si no existe o está bloqueado (modo privado, cookies bloqueadas). */
export function browserStorage(): StorageLike | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    return null;
  }
}
