/**
 * Mi actividad: una sola línea de tiempo con movimientos de fichas (CreditTransaction) y generaciones (Generation).
 * Funciones puras (testeadas en tests/activity-timeline.test.mjs). Las dos identidades se mantienen separadas: una fila de movimiento
 * es un movimiento y solo se le «pega» la generación a la que hace referencia (`referenceType='Generation'` + `referenceId`); las acciones
 * de recuperación pertenecen a la generación.
 *
 * Paginación combinada. Cada fuente (movimientos por tipo, generaciones) pagina por su cuenta y de más reciente a más antigua. Para
 * mezclarlas sin saltos cronológicos, sin huecos y sin repetidos solo se muestran las filas que NO son más viejas que el borde de cada
 * fuente que todavía tiene páginas por cargar (el más viejo de lo cargado de esa fuente). Todo lo cargado, visible o no, sirve para
 * relacionar filas: por eso una acción de recuperación no desaparece al pedir más páginas.
 */

export interface TxLike {
  id: string;
  type: string;
  createdAt: string;
  referenceType?: string | null;
  referenceId?: string | null;
}

export interface GenLike {
  id: string;
  createdAt: string;
  creditsCost?: number;
}

export type TimelineEntry<T extends TxLike, G extends GenLike> =
  /** Un movimiento real; `generation` es la generación a la que hace referencia, si ya se cargó. */
  | { kind: 'tx'; key: string; at: number; tx: T; generation: G | null; refundEvidence: boolean }
  /** Una generación sin ningún movimiento de fichas que la represente. */
  | { kind: 'generation'; key: string; at: number; generation: G };

export interface TimelineSource<I extends { id: string; createdAt: string }> {
  id: string;
  items: readonly I[];
  /** Quedan páginas por cargar de esta fuente. */
  hasMore: boolean;
}

/**
 * Diferencia tolerada entre la hora de una generación y la de su débito (se crean en la misma operación, pero no hay garantía de que
 * compartan el instante). Las filas dentro de este margen del borde de una fuente esperan a la siguiente página.
 */
export const BOUNDARY_MARGIN_MS = 5_000;

const time = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};

/** Une páginas ya cargadas sin repetir ids (el desplazamiento del offset puede traer de nuevo una fila ya mostrada). Conserva el orden. */
export function dedupe<I extends { id: string }>(items: readonly I[]): I[] {
  const seen = new Set<string>();
  const out: I[] = [];
  for (const it of items) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    out.push(it);
  }
  return out;
}

export interface Window {
  /** Borde: solo se muestra lo que no es más viejo. `null` = sin borde (ya está todo cargado). */
  cutoff: number | null;
  /** Fuentes que definen el borde: la siguiente página se pide a estas. */
  binding: string[];
}

export function visibleWindow(sources: ReadonlyArray<TimelineSource<{ id: string; createdAt: string }>>): Window {
  let cutoff: number | null = null;
  let binding: string[] = [];
  for (const s of sources) {
    if (!s.hasMore) continue;
    // Con páginas pendientes y nada cargado no se puede mostrar nada más viejo que «ahora»: la fuente define el borde por completo.
    // El borde nunca supera lo más nuevo que se cargó de esa fuente: si toda una página cae dentro del margen (p. ej. varias filas creadas en el
    // mismo instante), igual se muestra lo más nuevo en lugar de dejar la lista vacía hasta pedir más.
    const times = s.items.map((i) => time(i.createdAt));
    const oldest = s.items.length === 0 ? Number.POSITIVE_INFINITY : Math.min(Math.max(...times), Math.min(...times) + BOUNDARY_MARGIN_MS);
    if (cutoff === null || oldest > cutoff) { cutoff = oldest; binding = [s.id]; } else if (oldest === cutoff) binding.push(s.id);
  }
  return { cutoff, binding };
}

export function buildTimeline<T extends TxLike, G extends GenLike>(args: {
  tx: ReadonlyArray<TimelineSource<T>>;
  generations: TimelineSource<G> | null;
}): { entries: Array<TimelineEntry<T, G>>; hasMore: boolean; binding: string[] } {
  const txItems = dedupe(args.tx.flatMap((s) => s.items));
  const genItems = args.generations ? dedupe(args.generations.items) : [];
  const sources = [...args.tx, ...(args.generations ? [args.generations] : [])] as Array<TimelineSource<{ id: string; createdAt: string }>>;
  const { cutoff, binding } = visibleWindow(sources);
  const inWindow = (iso: string) => cutoff === null || time(iso) >= cutoff;

  // Lo cargado (visible o no) sirve para relacionar.
  const genById = new Map(genItems.map((g) => [g.id, g]));
  const generationOf = (t: T): G | null => (t.referenceType === 'Generation' && t.referenceId ? genById.get(t.referenceId) ?? null : null);
  const representedBy = new Set<string>();
  const refunded = new Set<string>();
  for (const t of txItems) {
    if (t.referenceType !== 'Generation' || !t.referenceId) continue;
    representedBy.add(t.referenceId);
    if (t.type === 'GENERATION_REFUND') refunded.add(t.referenceId);
  }

  // Una generación sin movimiento solo se muestra como fila propia si el historial de fichas ya cubre su hora (con el margen): si no, su
  // débito podría estar en una página que todavía no se cargó y se mostraría repetida hasta cargarla.
  const ledgerCovers = (at: number) => args.tx.every((s) => {
    if (!s.hasMore) return true;
    if (s.items.length === 0) return false;
    return at >= Math.min(...s.items.map((i) => time(i.createdAt))) + BOUNDARY_MARGIN_MS;
  });
  type Row = { at: number; entry: TimelineEntry<T, G> };
  const rows: Row[] = [];
  for (const t of txItems) {
    const generation = generationOf(t);
    rows.push({
      at: time(t.createdAt),
      entry: {
        kind: 'tx', key: `tx:${t.id}`, at: time(t.createdAt), tx: t, generation,
        // Solo hay evidencia si el reintegro de ESA generación está cargado: nunca se supone.
        refundEvidence: Boolean(generation) && refunded.has(generation!.id),
      },
    });
  }
  for (const g of genItems) {
    if (representedBy.has(g.id) || !ledgerCovers(time(g.createdAt))) continue; // ya representada por sus movimientos, o su débito podría no haberse cargado aún
    rows.push({ at: time(g.createdAt), entry: { kind: 'generation', key: `gen:${g.id}`, at: time(g.createdAt), generation: g } });
  }
  let visible = rows.filter((r) => inWindow(new Date(r.at).toISOString()));
  // Nunca una primera vista vacía si ya hay algo cargado (p. ej. filas que difieren por unos milisegundos y quedan justo bajo el borde):
  // se muestra lo más nuevo que haya.
  if (visible.length === 0 && rows.length > 0) {
    const newest = Math.max(...rows.map((r) => r.at));
    visible = rows.filter((r) => r.at >= newest);
  }
  const entries: Array<TimelineEntry<T, G>> = visible.map((r) => r.entry);
  entries.sort((a, b) => b.at - a.at || (a.kind === b.kind ? 0 : a.kind === 'tx' ? -1 : 1) || (a.key < b.key ? -1 : 1));
  return { entries, hasMore: sources.some((s) => s.hasMore), binding };
}
