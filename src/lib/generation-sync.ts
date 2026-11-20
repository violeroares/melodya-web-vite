/**
 * Lógica pura de sincronización de generaciones con la caché (sin React, sin DOM): qué consultas hay que refrescar
 * cuando una generación termina y cuándo el sondeo de reconciliación tiene algo nuevo que invalidar.
 * Vive aparte de hooks/index.ts para poder probarse con el runner nativo de Node (tests/generation-sync.test.mjs).
 */

export interface GenerationCompletedPayload {
  generationId: string;
  songId: string | null;
  versionId?: string | null;
  versionNumber?: number;
  versionIds?: string[];
  /** Solo lo trae la finalización de una PORTADA (cover.handler.js); la de música trae versionNumber/versionIds. */
  coverFileId?: string | null;
}

export type QueryKeyPrefix = readonly unknown[];

/** La portada completa con `coverFileId` y sin versión nueva: no crea versiones ni escribe letras. */
export function isCoverCompletion(p: GenerationCompletedPayload): boolean {
  return p.coverFileId != null && p.versionNumber === undefined && p.versionIds === undefined;
}

/**
 * Prefijos de caché a invalidar al completarse una generación.
 *  • `['song', songId]` y no `['song']`: solo cambia ESA canción (el prefijo corto refrescaba también las tarjetas
 *    ["song", otroId, "done"] de "Seguí creando", sus comentarios, etc.). Sin songId se conserva el prefijo amplio.
 *  • Una portada solo cambia la canción y los listados: no toca proyectos ni letras (música sí: puede guardar una letra de
 *    Melodya — lyrics.handler.js — y la canción entra a su proyecto).
 */
export function completionQueryKeys(p: GenerationCompletedPayload): QueryKeyPrefix[] {
  const keys: QueryKeyPrefix[] = [['songs'], p.songId ? ['song', p.songId] : ['song'], ['generations']];
  if (!isCoverCompletion(p)) keys.push(['projects'], ['lyrics']);
  return keys;
}

/**
 * Una finalización llega por hasta tres caminos (socket, sondeo de GenerationStatus, reconciliación). `firstTime` devuelve
 * true solo la primera vez que ve un generationId: las demás señales de la misma generación no repiten las peticiones.
 */
export function createCompletionGate(max = 100) {
  const seen = new Set<string>();
  return {
    firstTime(generationId: string): boolean {
      if (seen.has(generationId)) return false;
      seen.add(generationId);
      if (seen.size > max) seen.delete(seen.values().next().value as string);
      return true;
    },
  };
}

/** Lo mínimo que se usa de QueryClient para invalidar (permite probar sin React Query). */
export interface QueryInvalidator {
  invalidateQueries(filters: { queryKey: readonly unknown[] }): unknown;
}

/** Lo mínimo adicional para la recuperación: inspeccionar las consultas afectadas y volver a pedir solo las que fallaron. */
export interface QueryRecovery {
  getQueryCache(): {
    findAll(filters: { queryKey: readonly unknown[] }): Array<{ queryHash: string; state: { status: string }; isActive(): boolean }>;
  };
  refetchQueries(filters: {
    queryKey: readonly unknown[];
    type?: 'active';
    predicate?: (query: { queryHash: string; state: { status: string } }) => boolean;
  }): unknown;
}

/** Espera de la única recuperación tras un refresco fallido. */
export const RECOVERY_DELAY_MS = 5_000;

export interface ApplyCompletedOptions {
  /** Compuerta por generationId (por defecto la compartida de la app). */
  gate?: { firstTime(generationId: string): boolean };
  /** Programa la recuperación (por defecto setTimeout); se inyecta en los tests. */
  schedule?: (fn: () => void, ms: number) => void;
}

const completionGate = createCompletionGate();

const canRecover = (qc: QueryInvalidator): qc is QueryInvalidator & QueryRecovery =>
  typeof (qc as Partial<QueryRecovery>).getQueryCache === 'function' && typeof (qc as Partial<QueryRecovery>).refetchQueries === 'function';

const isErrored = (q: { state: { status: string } }) => q.state.status === 'error';

/**
 * Refresca la caché cuando una generación termina. Se llama desde el socket, desde el sondeo de GenerationStatus y desde la
 * reconciliación: la compuerta deja pasar solo la primera señal de CADA generación (por generationId), así que la misma
 * finalización no se repite y dos generaciones distintas nunca se confunden.
 *
 * Se mantiene el valor por defecto de TanStack Query (`cancelRefetch: true`): si ya hay un pedido en vuelo para esa
 * consulta (p. ej. por OTRA generación que terminó medio segundo antes), se cancela y se repite, para que el resultado
 * incluya también esta finalización. Con `cancelRefetch: false` el segundo evento se uniría a un pedido que pudo haber leído
 * la base antes del commit de la segunda generación y dejaría la lista desactualizada. Los duplicados de una misma
 * generación ya los absorbe la compuerta, así que `false` no aportaría nada.
 *
 * RECUPERACIÓN (una sola vez por generación): `invalidateQueries` no rechaza si el pedido falla, y como la compuerta descarta
 * las señales siguientes de esa generación, una consulta ACTIVA que agotó sus reintentos quedaba con el dato viejo hasta
 * remontarse u otra invalidación (ni el tiempo, ni el foco, ni volver la red la refrescan). Por eso, cuando terminan las
 * invalidaciones, si alguna consulta activa de ESTA generación quedó en error, se programa UNA recuperación a los
 * RECOVERY_DELAY_MS: vuelve a pedir solo las que fallaron en ese momento (instantánea de `queryHash` tomada al terminar las
 * invalidaciones) y que SIGAN en error (las que se recuperaron por otra vía no se tocan; tampoco una consulta que se monta
 * y falla después por su cuenta) y no se programa nada más: sin bucles, sin reintentos ilimitados y sin sondeos permanentes.
 */
export function applyGenerationCompleted(
  qc: QueryInvalidator,
  payload: GenerationCompletedPayload,
  options: ApplyCompletedOptions = {},
): boolean {
  const gate = options.gate ?? completionGate;
  if (!gate.firstTime(payload.generationId)) return false;
  const keys = completionQueryKeys(payload);
  const pending = keys.map((queryKey) => qc.invalidateQueries({ queryKey }));
  if (canRecover(qc)) {
    const schedule = options.schedule ?? ((fn: () => void, ms: number) => void setTimeout(fn, ms));
    void Promise.allSettled(pending).then(() => {
      // Instantánea: solo las consultas activas de ESTA generación que fallaron como resultado de las invalidaciones.
      const failedHashes = new Set<string>();
      for (const queryKey of keys) {
        for (const q of qc.getQueryCache().findAll({ queryKey })) {
          if (q.isActive() && isErrored(q)) failedHashes.add(q.queryHash);
        }
      }
      if (failedHashes.size === 0) return;
      schedule(() => {
        for (const queryKey of keys) {
          void qc.refetchQueries({ queryKey, type: 'active', predicate: (q) => failedHashes.has(q.queryHash) && isErrored(q) });
        }
      }, RECOVERY_DELAY_MS);
    });
  }
  return true;
}

interface SignatureItem {
  id: string;
  status: string;
  songId?: string | null;
  jobs?: Array<{ task: string; status: string }> | null;
}

const isActive = (status: string) => status === 'PENDING' || status === 'PROCESSING';

/** Ids de las generaciones en curso de un listado. */
export function activeGenerationIds(items: SignatureItem[]): Set<string> {
  return new Set(items.filter((g) => isActive(g.status)).map((g) => g.id));
}

/**
 * Generaciones que estaban en curso en el ciclo anterior y ahora figuran terminadas en el listado. Sirve para reconciliar lo
 * que el socket no entregó (conexión caída, pestaña dormida): una completada refresca canciones/proyectos/letras como si
 * hubiera llegado el evento (la compuerta evita repetirlo si el evento sí llegó) y una fallida/cancelada refresca los créditos
 * (reintegro). Las que ya no aparecen en la página consultada no se asumen terminadas.
 */
export function settledSince(previousActive: ReadonlySet<string>, items: SignatureItem[]) {
  const completed: Array<{ generationId: string; songId: string | null }> = [];
  const unsuccessful: string[] = [];
  for (const g of items) {
    if (!previousActive.has(g.id)) continue;
    if (g.status === 'COMPLETED') completed.push({ generationId: g.id, songId: g.songId ?? null });
    else if (g.status === 'FAILED' || g.status === 'CANCELED') unsuccessful.push(g.id);
  }
  return { completed, unsuccessful };
}

/**
 * Huella de las generaciones en curso (id, estado y estado de cada job). La reconciliación invalida ['generations'] solo
 * cuando la huella cambia: con el mismo estado que en el ciclo anterior ya está todo pintado y repetir el pedido no aporta.
 */
export function activeGenerationSignature(items: SignatureItem[]): string {
  return items
    .filter((g) => isActive(g.status))
    .map((g) => `${g.id}:${g.status}:${(g.jobs ?? []).map((j) => `${j.task}=${j.status}`).join(',')}`)
    .sort()
    .join('|');
}
