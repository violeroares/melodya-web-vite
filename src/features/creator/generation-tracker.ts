/**
 * MELODYA WEB — Seguimiento REST de UNA generación (un ciclo del poller).
 *
 * Lógica pura (sin React ni red propia): `GenerationStatus` la ejecuta dentro de `startPoller` (un ciclo en vuelo, backoff, pausa con la pestaña
 * oculta, espera ante 429). Aquí solo se decide qué hacer con cada respuesta; los estados de la generación NO se modifican:
 *  • cada respuesta actualiza el progreso;
 *  • COMPLETED → se avisa UNA vez y el seguimiento termina;
 *  • FAILED / CANCELED → se avisa UNA vez y el seguimiento termina;
 *  • cualquier otro estado (PENDING, PROCESSING…) → sigue.
 * Un error se propaga al poller (que aplica backoff / Retry-After); nunca se interpreta como que la generación terminó.
 */
export interface TrackedGeneration {
  status: string;
}

export interface GenerationTrackerDeps<G extends TrackedGeneration> {
  fetchGeneration: () => Promise<G>;
  /** false cuando el componente se desmontó o cambió de generación: la respuesta tardía se descarta. */
  isCurrent: () => boolean;
  onUpdate: (generation: G) => void;
  onCompleted: (generation: G) => void;
  onUnsuccessful: (generation: G) => void;
}

export function createGenerationTracker<G extends TrackedGeneration>(deps: GenerationTrackerDeps<G>): () => Promise<'stop' | void> {
  let finished = false; // estado terminal ya procesado: ni un ciclo tardío ni el regreso a la pestaña lo repiten
  return async () => {
    if (finished) return 'stop';
    const current = await deps.fetchGeneration();
    if (!deps.isCurrent()) return 'stop';
    deps.onUpdate(current);
    if (current.status === 'COMPLETED') {
      finished = true;
      deps.onCompleted(current);
      return 'stop';
    }
    if (current.status === 'FAILED' || current.status === 'CANCELED') {
      finished = true;
      deps.onUnsuccessful(current);
      return 'stop';
    }
  };
}
