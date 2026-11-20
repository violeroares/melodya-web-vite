/**
 * Textos del seguimiento de pedidos sin confirmar (E1). Viven aparte para poder probarlos: lo que dicen sobre cobros y reintegros
 * tiene que ser exacto.
 *
 *  • Un reintegro automático SOLO se promete cuando la generación terminó en FAILED (lo dice la pantalla de esa generación).
 *  • Un resultado incierto NO promete reintegro: el pedido pudo haberse aceptado y su cobro es legítimo; se resuelve confirmándolo.
 */

/** Mensaje del resultado incierto (no sabemos si el servidor aceptó el pedido). */
export const UNCERTAIN_SUBMIT_TEXT =
  'No pudimos confirmar si tu pedido llegó: puede que ya se haya aceptado. Confirmalo desde el estudio. Se reenvía el mismo pedido, así que no se cobra una segunda vez.';

export const UNCERTAIN_TITLE = 'Todavía no confirmamos tu pedido';
export const UNCERTAIN_ACTION = 'Ir a confirmar el pedido';

export const DISCARD_TITLE = '¿Descartar el pedido sin confirmar?';
export const DISCARD_DESCRIPTION =
  'Descartar solo borra el seguimiento de este pedido en este dispositivo. NO cancela una generación que ya se haya aceptado y NO devuelve las fichas. Si el pedido llegó, la canción se va a crear igual y las fichas ya están cobradas; si después empezás otra generación, podría cobrarse una segunda vez. Antes de descartar, revisá tu actividad por si ya aparece.';
