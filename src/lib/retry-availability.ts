/**
 * ¿Está disponible el reintento enlazado (`POST /generations/:id/retry`)?
 *
 * El backend lo apaga con `generation.retry_enabled` (por defecto APAGADO) y hoy NO expone ese estado en ningún endpoint de lectura: la
 * recuperación de la composición (`GET /generations/:id/recovery`) funciona siempre, pero el reintento responde
 * `404 GENERATION_RETRY_DISABLED` si está apagado. Para no seguir ofreciendo una acción que ya sabemos que va a fallar, la primera vez que
 * el servidor lo informa se recuerda durante la sesión del navegador y la interfaz pasa a ofrecer, con una explicación, crear la canción
 * nueva (un `POST /generations` normal, decisión explícita del usuario).
 *
 * Solo memoria del módulo: al recargar se vuelve a descubrir (una sola respuesta 404 sin cobro ni efecto).
 */
let disabled = false;
const listeners = new Set<() => void>();

export const isRetryAvailable = (): boolean => !disabled;

export function markRetryDisabled(): void {
  if (disabled) return;
  disabled = true;
  listeners.forEach((l) => l());
}

/** Solo pruebas. */
export function resetRetryAvailability(): void {
  disabled = false;
  listeners.forEach((l) => l());
}

export function subscribeRetryAvailability(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
