/**
 * MELODYA WEB — Traducción de errores API a mensajes humanos (es-AR).
 * Nunca mostrar errores técnicos crudos.
 */
import { ApiError } from './api/client';
import { capabilityDenial, capabilityDenialMessage, limitExceeded, limitExceededMessage } from './capabilities';
import { priceChanged } from './pricing';

const FRIENDLY_BY_CODE: Record<string, string> = {
  INSUFFICIENT_CREDITS: 'No te alcanzan las fichas para esta generación. Podés sumar más desde Planes y fichas.',
  VOICE_CONSENT_REQUIRED: 'Primero aceptá la autorización de uso de voz en tu perfil.',
  CANNOT_CANCEL: 'La generación ya está en proceso y no puede cancelarse.',
  RATE_LIMITED: 'Estás yendo muy rápido. Esperá unos segundos y volvé a intentar.',
  COMMENT_REJECTED: 'Tu comentario no cumple las normas de la comunidad. Modificalo y volvé a enviarlo.',
  EMAIL_TAKEN: 'Ese email ya está registrado. Probá iniciar sesión.',
  INVALID_SAMPLE: 'La muestra seleccionada ya no está disponible.',
  INVALID_LYRIC: 'La letra seleccionada ya no está disponible.',
  INVALID_LYRIC_PERSONA: 'El letrista seleccionado ya no está disponible.',
  INVALID_VERSION: 'La versión no pertenece a esta canción.',
  PHRASE_NOT_READY: 'La frase de verificación todavía no está lista. Intentá en unos segundos.',
  NETWORK: 'No pudimos conectar con Melodya. Revisá tu conexión.',
  TIMEOUT: 'La conexión tardó demasiado. Intentá de nuevo.',
};

const TECHNICAL_PATTERNS = [/axios/i, /network error/i, /request failed/i, /\bECONN/i, /json/i, /internal server/i];

export function toUserMessage(err: unknown, fallback = 'Algo salió mal. Intentá de nuevo en unos segundos.'): string {
  if (err instanceof ApiError) {
    // 403 CAPABILITY_NOT_IN_PLAN: la función no está en el plan; se informa qué plan la incluye.
    const denial = capabilityDenial(err);
    if (denial) return capabilityDenialMessage(denial);
    // 403 LIMIT_EXCEEDED: cupo del período agotado; se informa cuándo se renueva.
    const limit = limitExceeded(err);
    if (limit) return limitExceededMessage(limit);
    // 409 PRICE_CHANGED: el precio cambió (terminó la promoción o se agotó el cupo) entre que lo viste y que confirmaste.
    if (priceChanged(err)) return 'El precio cambió mientras mirabas. Ya lo actualizamos: revisá el importe y volvé a confirmar.';
    const friendly = FRIENDLY_BY_CODE[err.code];
    if (friendly) return friendly;
    if (err.message && !TECHNICAL_PATTERNS.some((p) => p.test(err.message))) {
      return err.message;
    }
    if (err.status === 401) return 'Tu sesión expiró. Iniciá sesión de nuevo.';
    if (err.status === 403) return 'No tenés permisos para esta acción.';
    if (err.status === 404) return 'Lo que buscás ya no está disponible.';
    if (err.status === 409) return 'Hay un conflicto con los datos. Refrescá e intentá de nuevo.';
    if (err.status === 422) {
      const details = err.details as Array<{ message?: string }> | undefined;
      if (details?.length && details[0]?.message) return details[0].message;
      return 'Revisá los datos ingresados.';
    }
    if (err.status === 429) return FRIENDLY_BY_CODE.RATE_LIMITED;
    if (err.status >= 500) return 'Melodya tuvo un problema de nuestro lado. Ya estamos en ello.';
    return fallback;
  }
  if (err instanceof Error && !TECHNICAL_PATTERNS.some((p) => p.test(err.message))) {
    return err.message;
  }
  return fallback;
}
