/**
 * Qué se limpia en este dispositivo cuando el servidor bloquea una recuperación de Remix (el origen ya no está autorizado). Lógica pura sobre un
 * almacenamiento inyectado: se prueba con `node --test`.
 *
 * Reglas:
 *  • Si la composición recuperada YA se había cargado (el usuario la estaba editando), ese borrador —el espacio de «canción nueva», que es el de la
 *    recuperación— se descarta, junto con el pedido de reintento pendiente de esa generación (`retry.<id>`), que solo existe por ella.
 *  • Si el bloqueo llega ANTES de cargarla, no se toca nada: el borrador anterior del usuario (independiente de la recuperación) se conserva.
 *  • Nunca se tocan borradores de otras cuentas ni de otros contextos, ni otros pedidos pendientes, ni el borrador heredado, ni nada del servidor.
 */

import { clearDraft, type DraftContext, type StorageLike } from '../../lib/draft-store';
import { intentKey } from '../../lib/pending-request';

export interface BlockCleanupArgs {
  storage: StorageLike | null;
  userId: string | null | undefined;
  /** El contexto de borrador donde vive la composición recuperada (el de «canción nueva»). */
  draft: DraftContext;
  /** El almacén de pedidos pendientes del creador (se usa SU instancia: también guarda una copia en memoria). */
  pending: { discard: (userId: string, intent: string) => void };
  /** La recuperación que se bloquea (la sesión activa), o `null` si ya no hay una. */
  session: { generationId: string; needsApply: boolean } | null;
}

export function discardBlockedRecovery(args: BlockCleanupArgs): { discardedDraft: boolean } {
  const { session, userId } = args;
  const discardedDraft = Boolean(session && userId && !session.needsApply);
  if (discardedDraft && session && userId) {
    clearDraft(args.storage, userId, args.draft);
    args.pending.discard(userId, intentKey({ retryOfId: session.generationId }));
  }
  return { discardedDraft };
}
