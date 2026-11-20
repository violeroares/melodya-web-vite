/**
 * Motivo de una generación fallida, tal como lo informa el backend (`error` de GET /generations/:id y del evento
 * `generation:failed`). Todos los campos son opcionales: el backend más antiguo solo enviaba `code`/`message`.
 */
export interface GenerationFailure {
  code?: string;
  /** Para usuarios no administradores equivale a `userMessage`; en respuestas antiguas puede ser texto técnico. */
  message?: string;
  reasonCode?: string;
  userMessage?: string;
}

export const GENERIC_FAILURE_MESSAGE = 'No pudimos generar tu canción. Podés volver a intentarlo en unos minutos.';

/**
 * Texto para mostrar al usuario. Usa únicamente `userMessage` (texto público del backend); jamás `message`, que en
 * respuestas antiguas puede traer el texto crudo del proveedor. Sin `userMessage` válido, mensaje general.
 */
export function generationFailureMessage(error?: GenerationFailure | null): string {
  const text = typeof error?.userMessage === 'string' ? error.userMessage.trim() : '';
  return text || GENERIC_FAILURE_MESSAGE;
}
