/**
 * MELODYA WEB — Estado comercial del usuario (plan, fichas, cuotas, movimientos): UN solo mecanismo de actualización.
 *
 * El servidor es la autoridad: cuando el estado comercial cambia (una compra, un upgrade, un cambio programado, una cancelación, una reanudación, o un
 * proceso del backend como la renovación o el vencimiento) la web NO calcula nada: vuelve a pedir el perfil (`loadMe`, de donde salen el plan, la
 * suscripción y las capacidades) e invalida las consultas que dependen del usuario. Los catálogos (planes y packs) no cambian con la compra y no se invalidan.
 *
 * Lógica pura (sin imports de la app): se prueba con node --test.
 */
import type { QueryClient } from '@tanstack/react-query';

/** Consultas que dependen del estado comercial del usuario: consumo del período (cuotas), saldo y movimientos de fichas. */
export const COMMERCIAL_QUERY_KEYS: ReadonlyArray<readonly string[]> = [['usage'], ['credits'], ['transactions']];

type Invalidator = Pick<QueryClient, 'invalidateQueries'>;

let running: Promise<void> | null = null;
let again = false;

/**
 * Vuelve a hidratar el estado comercial: invalida las consultas comerciales y recarga el perfil (`loadMe`).
 * Sin consultas redundantes: si ya hay una actualización en curso no se lanza otra en paralelo; una llamada que llega MIENTRAS corre (por ejemplo un aviso
 * del servidor posterior al inicio de la consulta en vuelo) pide UNA pasada más al terminar, para no quedarse con datos anteriores a ese cambio.
 */
export function refreshCommercialState(qc: Invalidator, loadMe: () => Promise<unknown>): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        for (const queryKey of COMMERCIAL_QUERY_KEYS) void qc.invalidateQueries({ queryKey: [...queryKey] });
        await loadMe();
      } while (again);
    } catch {
      /* loadMe informa su resultado y no lanza; si algo inesperado falla, la próxima acción del usuario vuelve a hidratar. */
    } finally {
      running = null;
    }
  })();
  return running;
}

/** Aviso `billing:state-changed` del servidor (el backend cambió la suscripción del usuario). Solo lo mínimo para saber si el perfil ya está al día. */
export interface BillingStateEvent {
  reason: string;
  status: 'ACTIVE' | 'PAST_DUE' | 'EXPIRED';
  planCode: string | null;
  currentPeriodEnd: string | null;
}

interface UserWithSubscription {
  subscription?: { status: string; plan?: { code: string } | null; currentPeriodEnd: string } | null;
}

const sameInstant = (a: string | null | undefined, b: string | null | undefined) => Boolean(a && b) && new Date(a as string).getTime() === new Date(b as string).getTime();

/**
 * ¿El perfil ya cargado coincide con lo que anuncia el aviso? Entonces no hace falta volver a pedir nada (típico: la propia acción del usuario ya lo hidrató).
 * La entrada en la gracia (PAST_DUE) siempre se hidrata: GET /users/me no la expone como suscripción vigente.
 */
export function isCommercialStateCurrent(user: UserWithSubscription | null | undefined, evt: BillingStateEvent): boolean {
  if (!user) return true; // sin perfil (invitado o sesión sin hidratar) no hay nada que actualizar: al hidratar llega el estado vigente
  const sub = user.subscription ?? null;
  if (evt.status === 'ACTIVE') return Boolean(sub) && sub!.status === 'ACTIVE' && sub!.plan?.code === evt.planCode && sameInstant(sub!.currentPeriodEnd, evt.currentPeriodEnd);
  if (evt.status === 'EXPIRED') return sub === null;
  return false;
}
