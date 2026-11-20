/**
 * MELODYA WEB — Estado local de la recuperación de generaciones fallidas (E4).
 *
 * Qué guarda (solo en este dispositivo, aislado por cuenta como los borradores: la clave y el registro llevan el `userId`):
 *  • `handled`: generaciones FAILED que el usuario ya atendió (recuperó, descartó el aviso o ya reintentó). El aviso del creador no vuelve a
 *    ofrecerlas. DESCARTAR NO BORRA NADA del historial: la generación sigue existiendo en el servidor y en Perfil → Actividad.
 *  • `active`: la ÚNICA recuperación en curso. La composición recuperada vive en el espacio de composición de siempre (el borrador de «canción
 *    nueva»); esto solo recuerda de qué generación viene, qué destino eligió el usuario y si ya decidió sobre la letra retenida.
 *
 * Lógica pura: el almacenamiento se inyecta (se prueba con `node --test`). Cerrar sesión NO lo borra.
 */

import type { StorageLike } from './draft-store';

export const RECOVERY_VERSION = 1;
export const RECOVERY_PREFIX = 'melodya.recovery.v1';
/** Tope de generaciones «atendidas» que se recuerdan (las más viejas se olvidan; el aviso solo mira la más reciente). */
export const MAX_HANDLED = 100;

export type HandledState = 'DISMISSED' | 'RECOVERED' | 'SENT';
export type DestinationChoice = 'SAME' | 'NEW_SONG' | 'OTHER_ORIGIN';
export type OriginMode = 'COVER' | 'PROMPT_REUSE';

export interface OtherOrigin { songId: string; versionId: string | null; mode: OriginMode }

export interface RecoverySession {
  generationId: string;
  /** La composición todavía no se cargó en el editor (hay que leerla del servidor). Falso una vez aplicada. */
  needsApply: boolean;
  /** `null` = sin decidir. Con el destino no disponible se exige una decisión explícita; nunca se elige sola. */
  destination: DestinationChoice | null;
  otherOrigin: OtherOrigin | null;
  /** Decisión sobre una letra retenida por procedencia incierta (nunca se reutiliza sola). */
  heldDecision: 'KEEP' | 'DROP' | null;
  regenerateLyrics: boolean;
  /**
   * Desvinculada: la composición se conserva (con sus advertencias) pero se envía como una generación INDEPENDIENTE (`POST /generations`),
   * sin `retryOf`. El único reintento de la fallida queda sin usar. La sesión sigue abierta.
   */
  detached: boolean;
  startedAt: string;
}

export interface RecoveryRecord {
  v: typeof RECOVERY_VERSION;
  userId: string;
  handled: Record<string, { state: HandledState; at: string }>;
  active: RecoverySession | null;
}

export const recoveryKey = (userId: string): string => `${RECOVERY_PREFIX}.${encodeURIComponent(userId)}`;

const empty = (userId: string): RecoveryRecord => ({ v: RECOVERY_VERSION, userId, handled: {}, active: null });

/** Lee el registro de ESTA cuenta. Corrupto, de otra cuenta o de un formato desconocido ⇒ vacío (sin tocar lo guardado). */
export function readRecovery(storage: StorageLike | null, userId: string | null | undefined): RecoveryRecord {
  if (!userId) return empty('');
  try {
    const raw = storage?.getItem(recoveryKey(userId));
    if (!raw) return empty(userId);
    const rec = JSON.parse(raw) as Partial<RecoveryRecord> | null;
    if (!rec || rec.v !== RECOVERY_VERSION || rec.userId !== userId || typeof rec.handled !== 'object' || rec.handled === null) return empty(userId);
    const active = rec.active && typeof rec.active === 'object' && typeof rec.active.generationId === 'string'
      ? ({ ...(rec.active as RecoverySession), detached: (rec.active as Partial<RecoverySession>).detached === true })
      : null;
    return { v: RECOVERY_VERSION, userId, handled: rec.handled as RecoveryRecord['handled'], active };
  } catch {
    return empty(userId);
  }
}

function writeRecovery(storage: StorageLike | null, rec: RecoveryRecord): RecoveryRecord {
  if (!storage || !rec.userId) return rec;
  const entries = Object.entries(rec.handled);
  if (entries.length > MAX_HANDLED) {
    const keep = entries.sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, MAX_HANDLED);
    rec = { ...rec, handled: Object.fromEntries(keep) };
  }
  try { storage.setItem(recoveryKey(rec.userId), JSON.stringify(rec)); } catch { /* sin almacenamiento: el estado vive solo en memoria */ }
  return rec;
}

/** Marca una generación como atendida: el aviso del creador no la vuelve a ofrecer. NO borra ni modifica nada en el servidor. */
export function markHandled(storage: StorageLike | null, userId: string, generationId: string, state: HandledState, now: Date = new Date()): RecoveryRecord {
  const rec = readRecovery(storage, userId);
  return writeRecovery(storage, { ...rec, handled: { ...rec.handled, [generationId]: { state, at: now.toISOString() } } });
}

/** Empieza (o reemplaza) la ÚNICA recuperación activa y deja la generación como «recuperada». */
export function startSession(storage: StorageLike | null, userId: string, generationId: string, now: Date = new Date()): RecoveryRecord {
  const rec = readRecovery(storage, userId);
  const session: RecoverySession = {
    generationId, needsApply: true, destination: null, otherOrigin: null, heldDecision: null, regenerateLyrics: false, detached: false, startedAt: now.toISOString(),
  };
  return writeRecovery(storage, { ...rec, handled: { ...rec.handled, [generationId]: { state: 'RECOVERED', at: now.toISOString() } }, active: session });
}

export function updateSession(storage: StorageLike | null, userId: string, patch: Partial<Omit<RecoverySession, 'generationId' | 'startedAt'>>): RecoveryRecord {
  const rec = readRecovery(storage, userId);
  if (!rec.active) return rec;
  return writeRecovery(storage, { ...rec, active: { ...rec.active, ...patch } });
}

/** Termina la recuperación activa. `outcome` deja constancia de cómo terminó (reintentada, descartada…). */
export function endSession(storage: StorageLike | null, userId: string, outcome: HandledState, now: Date = new Date()): RecoveryRecord {
  const rec = readRecovery(storage, userId);
  const id = rec.active?.generationId;
  return writeRecovery(storage, { ...rec, active: null, handled: id ? { ...rec.handled, [id]: { state: outcome, at: now.toISOString() } } : rec.handled });
}
