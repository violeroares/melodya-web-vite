/**
 * MELODYA WEB — Solicitudes de generación pendientes (idempotencia del cliente).
 *
 * Problema que resuelve: `POST /generations` puede quedar con resultado INCIERTO (timeout, corte de red, 5xx, recarga o cierre del
 * navegador justo después de enviar). Si el cliente genera otro `clientRequestId` en cada clic, el reintento puede duplicar la
 * generación y el cobro. Reglas de este módulo:
 *
 *  1. UN `clientRequestId` por intención de generación (por contexto: canción nueva, otra versión o remix de una canción).
 *  2. Escritura ANTES de enviar (write-ahead): se guarda el id, el cuerpo EXACTO enviado y su huella. Sobrevive a recargas.
 *  3. Mientras haya un resultado sin resolver NO se permite enviar otro cuerpo ni otro id en ese contexto: primero se resuelve
 *     el anterior reenviando el MISMO cuerpo con la MISMA clave (idempotente en el servidor).
 *  4. Solo se descarta la solicitud cuando el resultado es definitivo: aceptada (2xx) o rechazada sin efectos (4xx). NUNCA por tiempo.
 *  5. Un solo envío en vuelo por contexto (protege el doble clic).
 *  6. Aislada por cuenta: la clave y el registro llevan el `userId`.
 *
 * Esto es una mitigación del cliente; la protección atómica contra duplicados vive en el backend (etapas siguientes).
 * Lógica pura: el almacenamiento y el generador de ids se inyectan (se prueba con `node --test`).
 */

import type { StorageLike } from './draft-store';

export const PENDING_VERSION = 1;
export const PENDING_PREFIX = 'melodya.pending.v1';

/** A qué endpoint va el cuerpo guardado (E4: «Editar y reintentar» usa `POST /generations/:id/retry`; el id viaja en la intención `retry.<id>`). */
export type PendingEndpoint = 'POST /generations' | 'POST /generations/:id/retry';

export interface PendingRecord {
  v: typeof PENDING_VERSION;
  userId: string;
  /** Contexto de la intención (ver `intentKey`). */
  intent: string;
  clientRequestId: string;
  endpoint: PendingEndpoint;
  /** Cuerpo EXACTO enviado (JSON, ya con `clientRequestId`). Se reenvía sin modificaciones. */
  body: string;
  /** Huella (SHA-256) del cuerpo sin `clientRequestId`, con `inputs` ordenados. Para comparar intenciones y, más adelante, con el servidor. */
  bodyHash: string;
  createdAt: string;
  attempts: number;
  lastAttemptAt: string | null;
}

export type SendOutcome = 'ACCEPTED' | 'REJECTED' | 'UNCERTAIN';

export type SendResult<T> =
  | { kind: 'ACCEPTED'; value: T; record: PendingRecord }
  | { kind: 'REJECTED'; error: unknown }
  /** No se sabe si el servidor la procesó: se conserva la solicitud para resolverla con el mismo cuerpo y la misma clave. */
  | { kind: 'UNCERTAIN'; error: unknown; record: PendingRecord }
  /** Hay un resultado anterior sin resolver y el cuerpo actual es distinto: no se envió nada. */
  | { kind: 'BLOCKED'; record: PendingRecord }
  /** Ya hay un envío en curso en este contexto. */
  | { kind: 'IN_FLIGHT' };

/**
 * Identifica la intención: canción nueva, otra versión de una canción, remix de una canción (con su modalidad) o el reintento de una
 * generación fallida (E4: un reintento por generación; su pedido pendiente no se mezcla con el de una canción nueva).
 */
export function intentKey(args: { versionOfId?: string | null; remixSongId?: string | null; remixMode?: string | null; retryOfId?: string | null }): string {
  if (args.retryOfId) return `retry.${encodeURIComponent(args.retryOfId)}`;
  if (args.versionOfId) return `version.${encodeURIComponent(args.versionOfId)}`;
  if (args.remixSongId) return `remix.${encodeURIComponent(args.remixSongId)}.${args.remixMode ?? 'PROMPT_REUSE'}`;
  return 'new';
}

/** Id de la generación fallida de una intención `retry.<id>` (o `null` si la intención no es un reintento). */
export function retryTargetOf(intent: string): string | null {
  return intent.startsWith('retry.') ? decodeURIComponent(intent.slice('retry.'.length)) : null;
}

export const pendingKey = (userId: string, intent: string): string => `${PENDING_PREFIX}.${encodeURIComponent(userId)}.${intent}`;

/* ───────────── Huella ───────────── */

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** JSON canónico del cuerpo SIN `clientRequestId` y con `inputs` ordenados por `field`: dos cuerpos equivalentes dan la misma huella. */
export function canonicalBody(body: Record<string, unknown>): string {
  const rest: Record<string, unknown> = { ...body };
  delete rest.clientRequestId;
  const inputs = Array.isArray(rest.inputs)
    ? [...(rest.inputs as Array<{ field?: string }>)].sort((a, b) => String(a?.field ?? '').localeCompare(String(b?.field ?? '')))
    : rest.inputs;
  return canonical({ ...rest, ...(inputs !== undefined ? { inputs } : {}) });
}

export async function fingerprint(body: Record<string, unknown>): Promise<string> {
  const text = canonicalBody(body);
  const subtle = typeof globalThis.crypto !== 'undefined' ? globalThis.crypto.subtle : undefined;
  if (subtle) {
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
    return `sha256:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  }
  // Sin SubtleCrypto (contexto no seguro): huella simple, suficiente para comparar cuerpos locales.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `fnv:${h.toString(16)}:${text.length}`;
}

/* ───────────── Clasificación del resultado de un envío ───────────── */

interface ErrorLike { status?: unknown; code?: unknown; details?: unknown }

/**
 * Conflictos 409 con un código propio: el servidor los responde ANTES de crear o cobrar nada (rechazo definitivo). Un 409 sin código propio
 * (p. ej. una carrera de la misma clave) sigue siendo incierto.
 */
const DEFINITIVE_409 = new Set(['RETRY_ALREADY_EXISTS', 'GENERATION_NOT_RETRYABLE', 'TARGET_UNAVAILABLE', 'REMIX_ORIGIN_UNAVAILABLE']);

/**
 * ¿Quedó la solicitud rechazada SIN efectos, o no se sabe? Solo los rechazos claros del servidor son definitivos.
 * Cualquier otra cosa (sin respuesta, timeout, 5xx, 408/409/429, error desconocido) es INCIERTA y la solicitud se conserva.
 * Se reconoce por forma (`status`/`code`), sin depender de la clase `ApiError`.
 */
export function classifyError(err: unknown): Exclude<SendOutcome, 'ACCEPTED'> {
  const e = (err && typeof err === 'object' ? err : {}) as ErrorLike;
  const status = typeof e.status === 'number' ? e.status : null;
  const code = typeof e.code === 'string' ? e.code : '';
  if (status === null || status === 0) return 'UNCERTAIN'; // NETWORK / TIMEOUT / error desconocido: pudo llegar
  if (status === 503 && code === 'GENERATION_PAUSED') return 'REJECTED'; // pausa operativa: se corta antes de cualquier efecto
  const detailsCode = e.details && typeof e.details === 'object' ? (e.details as { code?: unknown }).code : undefined;
  if (status === 409 && typeof detailsCode === 'string' && DEFINITIVE_409.has(detailsCode)) return 'REJECTED';
  if (status === 401) return 'REJECTED'; // la autenticación falla antes de llegar al caso de uso
  if (status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429) return 'REJECTED';
  return 'UNCERTAIN';
}

/* ───────────── Almacén ───────────── */

export interface PendingStoreDeps {
  storage: StorageLike | null;
  newId?: () => string;
  now?: () => Date;
}

const defaultId = (): string => (typeof crypto !== 'undefined' && 'randomUUID' in crypto
  ? crypto.randomUUID()
  : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`);

export function createPendingStore(deps: PendingStoreDeps) {
  const { storage } = deps;
  const newId = deps.newId ?? defaultId;
  const now = deps.now ?? (() => new Date());
  // Respaldo en memoria si el almacenamiento falla: la clave sigue estable dentro de la sesión aunque no sobreviva a una recarga.
  const memory = new Map<string, PendingRecord>();
  const inflight = new Set<string>();

  const keyOf = (userId: string, intent: string) => pendingKey(userId, intent);

  function load(userId: string | null | undefined, intent: string): PendingRecord | null {
    if (!userId) return null;
    const key = keyOf(userId, intent);
    try {
      const raw = storage?.getItem(key);
      if (raw) {
        const rec = JSON.parse(raw) as Partial<PendingRecord> | null;
        if (rec && rec.v === PENDING_VERSION && rec.userId === userId && rec.intent === intent
          && typeof rec.clientRequestId === 'string' && typeof rec.body === 'string' && typeof rec.bodyHash === 'string') {
          return rec as PendingRecord;
        }
      }
    } catch { /* corrupto o sin almacenamiento: se mira la memoria */ }
    return memory.get(key) ?? null;
  }

  function save(rec: PendingRecord): void {
    const key = keyOf(rec.userId, rec.intent);
    memory.set(key, rec);
    try { storage?.setItem(key, JSON.stringify(rec)); } catch { /* queda solo en memoria */ }
  }

  function remove(userId: string, intent: string): void {
    const key = keyOf(userId, intent);
    memory.delete(key);
    try { storage?.removeItem(key); } catch { /* noop */ }
  }

  /** Descarte MANUAL (decisión explícita del usuario). Nunca se llama por tiempo. */
  function discard(userId: string, intent: string): void {
    remove(userId, intent);
  }

  /** Un solo envío por contexto: el cerrojo se toma de forma SÍNCRONA, antes de cualquier espera. */
  async function locked<T>(userId: string, intent: string, fn: () => Promise<SendResult<T>>): Promise<SendResult<T>> {
    const lock = keyOf(userId, intent);
    if (inflight.has(lock)) return { kind: 'IN_FLIGHT' };
    inflight.add(lock);
    try {
      return await fn();
    } finally {
      inflight.delete(lock);
    }
  }

  async function attempt<T>(rec: PendingRecord, send: (body: Record<string, unknown>) => Promise<T>): Promise<SendResult<T>> {
    const current: PendingRecord = { ...rec, attempts: rec.attempts + 1, lastAttemptAt: now().toISOString() };
    save(current); // write-ahead: queda registrado ANTES de salir el pedido
    try {
      const value = await send(JSON.parse(current.body) as Record<string, unknown>); // el cuerpo guardado, sin modificar
      remove(rec.userId, rec.intent);
      return { kind: 'ACCEPTED', value, record: current };
    } catch (error) {
      if (classifyError(error) === 'REJECTED') {
        remove(rec.userId, rec.intent);
        return { kind: 'REJECTED', error };
      }
      return { kind: 'UNCERTAIN', error, record: current };
    }
  }

  /**
   * Envía una intención nueva. Si ya hay una pendiente en el contexto:
   *   • mismo cuerpo → se reenvía la guardada (misma clave, mismo cuerpo);
   *   • otro cuerpo  → BLOCKED: no se envía nada hasta resolver la anterior.
   */
  function submit<T>(args: { userId: string | null | undefined; intent: string; body: Record<string, unknown>; send: (body: Record<string, unknown>) => Promise<T>; endpoint?: PendingEndpoint }): Promise<SendResult<T>> {
    const { userId, intent, body, send } = args;
    const endpoint: PendingEndpoint = args.endpoint ?? 'POST /generations';
    if (!userId) return Promise.reject(new Error('pending-request: no hay cuenta identificada'));
    return locked(userId, intent, async () => {
      const hash = await fingerprint(body);
      const existing = load(userId, intent);
      if (existing) {
        if (existing.bodyHash !== hash) return { kind: 'BLOCKED', record: existing };
        return attempt(existing, send);
      }
      const clientRequestId = newId();
      const rec: PendingRecord = {
        v: PENDING_VERSION, userId, intent, clientRequestId, endpoint,
        body: JSON.stringify({ ...body, clientRequestId }), bodyHash: hash,
        createdAt: now().toISOString(), attempts: 0, lastAttemptAt: null,
      };
      return attempt(rec, send);
    });
  }

  /** Resuelve la pendiente reenviando exactamente lo guardado (acción explícita del usuario o recuperación tras recargar). */
  async function resolve<T>(args: { userId: string | null | undefined; intent: string; send: (body: Record<string, unknown>) => Promise<T> }): Promise<SendResult<T> | { kind: 'NONE' }> {
    const { userId, intent, send } = args;
    if (!userId) return { kind: 'NONE' };
    let none = false;
    const res = await locked<T>(userId, intent, async () => {
      const existing = load(userId, intent);
      if (!existing) { none = true; return { kind: 'IN_FLIGHT' }; }
      return attempt(existing, send);
    });
    return none ? { kind: 'NONE' } : res;
  }

  return { load, submit, resolve, discard };
}

export type PendingStore = ReturnType<typeof createPendingStore>;
