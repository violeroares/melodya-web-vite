/**
 * MELODYA WEB — Moderación de comentarios: lo que el cliente necesita saber.
 *
 * La DECISIÓN es exclusivamente del backend (la web no clasifica ni filtra nada). Si la moderación está encendida, el backend valida el
 * texto antes de guardarlo y responde:
 *  • 201            → publicado (también cuando la moderación falló técnicamente: fail-open; la web no distingue ni muestra nada).
 *  • 422 COMMENT_REJECTED → NO se guardó. Hay que conservar el texto en el editor y mostrar un mensaje breve para que el usuario lo corrija.
 *  • cualquier otro error → el flujo de siempre (toast con el mensaje amable).
 * Con la moderación apagada nada cambia: la respuesta es idéntica a la de siempre.
 *
 * Este archivo es IDÉNTICO en melodya_web (Next.js) y melodya.web-vite (Vite): cualquier cambio se aplica en ambos.
 */

/** Código estable del rechazo por moderación (HTTP 422). */
export const COMMENT_REJECTED_CODE = 'COMMENT_REJECTED';

/** Mismo texto que envía el backend; solo se usa si por algún motivo la respuesta no trae mensaje. */
export const COMMENT_REJECTED_FALLBACK = 'Tu comentario no cumple las normas de la comunidad. Modificalo y volvé a enviarlo.';

/** Espera mínima antes de mostrar «Revisando tu comentario…» (si la validación es instantánea no parpadea ningún texto). */
export const COMMENT_CHECKING_DELAY_MS = 700;

export type CommentSubmitFailure =
  /** El backend rechazó el contenido: el texto se conserva y se muestra `message` junto al editor. */
  | { kind: 'rejected'; message: string }
  /** Cualquier otra falla: se informa con el mensaje amable de siempre (toast). */
  | { kind: 'error'; message: string };

const codeOf = (err: unknown): unknown => (err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined);

/** ¿La moderación rechazó el comentario? (rechazo válido del modelo; nunca una falla técnica). */
export function isCommentRejected(err: unknown): boolean {
  return codeOf(err) === COMMENT_REJECTED_CODE;
}

/** Clasifica el error de publicar un comentario o una respuesta. `toMessage` es el traductor de errores de la web (toUserMessage). */
export function classifyCommentFailure(err: unknown, toMessage: (e: unknown) => string): CommentSubmitFailure {
  if (isCommentRejected(err)) {
    const raw = (err as { message?: unknown }).message;
    return { kind: 'rejected', message: typeof raw === 'string' && raw.trim() ? raw.trim() : COMMENT_REJECTED_FALLBACK };
  }
  return { kind: 'error', message: toMessage(err) };
}

/** Enviar (botón o Enter) solo con texto y sin otro envío en curso: evita duplicados mientras se valida. */
export function canSubmitComment(draft: string, pending: boolean): boolean {
  return draft.trim().length > 0 && !pending;
}
