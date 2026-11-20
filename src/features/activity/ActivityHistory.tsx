
/**
 * Mi actividad (Perfil): el historial de fichas de siempre —mismo diseño, filtros, importes, saldos, fechas e iconos— con las generaciones
 * integradas. La lógica de combinación vive en `timeline.ts`; acá solo se cargan las fuentes y se dibuja.
 *
 *  • Cada fila de movimiento es un movimiento real (débito, reintegro, compra…). Si hace referencia a una generación ya cargada, la fila
 *    muestra además lo que le pasó a ESA generación y sus acciones (ver canción, recuperar, «ya se volvió a intentar»).
 *  • Una generación sin movimiento que la represente (p. ej. una fallida sin cobro) aparece como fila propia, sin importe ni saldo.
 *  • «Fichas devueltas» solo se afirma si el reintegro de esa generación está cargado en la lista.
 */

import React from 'react';
import { useInfiniteQuery, type UseInfiniteQueryResult, type InfiniteData } from '@tanstack/react-query';
import { CheckCircle2, Loader2, Music4, RefreshCw, Settings2, ShoppingBag, Sparkles, XCircle, Zap } from 'lucide-react';
import { billingApi, generationApi } from '@/lib/api';
import { navigate } from '@/lib/router';
import { formatRelative } from '@/hooks';
import { cn } from '@/lib/utils';
import type { CreditTransaction, Generation, Paginated } from '@/types';
import { EmptyState, ErrorState, LoadingRows } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { describeTransaction } from '../billing/transaction-label';
import { generationLabels } from '../profile/generation-label';
import { activityTitleOf, canRecoverFromHistory, isRemixBlocked } from '../creator/recovery-model';
import { buildTimeline, type TimelineEntry, type TimelineSource } from './timeline';

/** Entero con separador es-AR (1000 → 1.000). */
const fmtInt = (n: number) => n.toLocaleString('es-AR');

/* ── Icono y color por type real (el texto del movimiento sale de describeTransaction) ── */
const TX_ICON: Record<CreditTransaction['type'], typeof Zap> = {
  WELCOME_GRANT: Sparkles,
  PLAN_GRANT: Zap,
  PACKAGE_PURCHASE: ShoppingBag,
  ADMIN_ADJUSTMENT: Settings2,
  GENERATION_DEBIT: Music4,
  GENERATION_REFUND: RefreshCw,
};

/* Mismo color por tipo que los círculos de «Materiales» de Crear: círculo de color con el ícono oscuro adentro. */
const TX_TONE: Record<CreditTransaction['type'], string> = {
  WELCOME_GRANT: 'bg-accent-soft',
  PLAN_GRANT: 'bg-element-style',
  PACKAGE_PURCHASE: 'bg-element-idea',
  ADMIN_ADJUSTMENT: 'bg-element-sound',
  GENERATION_DEBIT: 'bg-element-lyrics',
  GENERATION_REFUND: 'bg-orbit-0',
};

type TxFilterKey = 'todas' | 'compras' | 'generaciones' | 'devoluciones';
const TX_FILTERS: Array<{ key: TxFilterKey; label: string; types: Array<CreditTransaction['type'] | null>; withGenerations: boolean }> = [
  { key: 'todas', label: 'Todas', types: [null], withGenerations: true },
  { key: 'compras', label: 'Compras', types: ['PACKAGE_PURCHASE', 'PLAN_GRANT'], withGenerations: false }, // la API filtra por un solo type: una fuente por cada uno
  { key: 'generaciones', label: 'Generaciones', types: ['GENERATION_DEBIT'], withGenerations: true },
  { key: 'devoluciones', label: 'Devoluciones', types: ['GENERATION_REFUND'], withGenerations: false },
];

const PAGE_SIZE = 10;

type Source<T> = UseInfiniteQueryResult<InfiniteData<{ items: T[]; page: number; pages: number }>>;

const pagesOf = <T,>(q: Source<T>): T[] => q.data?.pages.flatMap((p) => p.items) ?? [];
const hasMoreOf = <T,>(q: Source<T>): boolean => {
  const last = q.data?.pages[q.data.pages.length - 1];
  return Boolean(last && last.page < last.pages);
};

function useTxSource(filter: TxFilterKey, index: number) {
  const type = TX_FILTERS.find((f) => f.key === filter)?.types[index];
  return useInfiniteQuery({
    // El prefijo ['transactions'] lo invalida una compra (Planes y fichas).
    queryKey: ['transactions', 'activity', filter, index],
    queryFn: async ({ pageParam }) => {
      const res: Paginated<CreditTransaction> = await billingApi.transactions({ page: pageParam, pageSize: PAGE_SIZE, ...(type ? { type } : {}) });
      return { items: res.items, page: res.pagination.page, pages: res.pagination.pages };
    },
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page < last.pages ? last.page + 1 : undefined),
    enabled: type !== undefined,
  });
}

function useGenerationSource(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: ['generations', 'profile', 'activity'],
    queryFn: async ({ pageParam }) => {
      const res = await generationApi.list({ page: pageParam, pageSize: PAGE_SIZE });
      return { items: res.items, page: res.pagination.page, pages: res.pagination.pages };
    },
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page < last.pages ? last.page + 1 : undefined),
    enabled,
  });
}

export function ActivityHistory() {
  const [filter, setFilter] = React.useState<TxFilterKey>('todas');
  const spec = TX_FILTERS.find((f) => f.key === filter) ?? TX_FILTERS[0];
  const tx0 = useTxSource(filter, 0);
  const tx1 = useTxSource(filter, 1);
  const gens = useGenerationSource(spec.withGenerations);

  const txQueries = [tx0, tx1].slice(0, spec.types.length);
  const all = [...txQueries, ...(spec.withGenerations ? [gens] : [])];
  const loading = all.some((q) => q.isLoading);
  const failed = all.some((q) => q.isError);

  const timeline = React.useMemo(
    () => buildTimeline<CreditTransaction, Generation>({
      tx: txQueries.map((q, i) => ({ id: `tx${i}`, items: pagesOf(q), hasMore: hasMoreOf(q) })) as Array<TimelineSource<CreditTransaction>>,
      generations: spec.withGenerations ? { id: 'gen', items: pagesOf(gens), hasMore: hasMoreOf(gens) } : null,
    }),
    [tx0.data, tx1.data, gens.data, filter],
  );

  const fetching = all.some((q) => q.isFetchingNextPage);
  const loadMore = () => {
    // La siguiente página se pide a la fuente que define el borde: así la lista avanza sin saltos ni huecos.
    const byId: Record<string, Source<unknown>> = { tx0: tx0 as Source<unknown>, tx1: tx1 as Source<unknown>, gen: gens as Source<unknown> };
    for (const id of timeline.binding) void byId[id]?.fetchNextPage();
  };

  return (
    <section>
      {/* Grupo segmentado como las secciones de «Tu biblioteca»: contenedor con borde fino y la opción elegida en píldora */}
      <div
        className="mb-4 flex gap-1 scrollbar-none select-none overflow-x-auto rounded-[28px] border-[1.5px] border-line p-1"
        role="group"
        aria-label="Filtrar actividad"
      >
        {TX_FILTERS.map((f) => {
          const active = filter === f.key;
          return (
            <button
              key={f.key}
              type="button"
              aria-pressed={active}
              onClick={() => setFilter(f.key)}
              className={cn(
                'flex h-10 flex-1 shrink-0 items-center justify-center rounded-[22px] px-3 text-[12.5px] whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 sm:h-11 sm:px-4 sm:text-[13px]',
                active ? 'bg-selected font-bold text-on-selected' : 'font-medium text-foreground hover:bg-accent'
              )}
            >
              {f.label}
            </button>
          );
        })}
      </div>
      {/* Contenedor como «Tus canciones» del prototipo estilo-visual-v2: borde fino, esquinas 28/28/14/14, fondo de campo y filas separadas por una línea */}
      <Card className="gap-0 overflow-hidden rounded-[28px_28px_14px_14px] border-[1.5px] border-[var(--m-border)] bg-[var(--m-input)] py-0">
        <CardContent className="p-0">
          {loading ? (
            <div className="p-4 sm:p-5"><LoadingRows count={4} /></div>
          ) : failed ? (
            <div className="p-4 sm:p-5"><ErrorState message="No pudimos cargar tu actividad." onRetry={() => all.forEach((q) => void q.refetch())} /></div>
          ) : timeline.entries.length === 0 && !timeline.hasMore ? (
            <EmptyState
              icon={<Zap className="h-6 w-6" />}
              title="Todavía no hay actividad"
              description="Cuando compres fichas o crees canciones, vas a ver cada movimiento acá."
              actionLabel="Crear mi primera canción"
              actionTo="/create"
            />
          ) : (
            <>
              <ul aria-label="Actividad de fichas y generaciones">
                {timeline.entries.map((entry) => <EntryRow key={entry.key} entry={entry} />)}
              </ul>
              {timeline.hasMore && (
                <Button className="mx-auto my-4 flex rounded-full px-8" onClick={loadMore} disabled={fetching}>
                  {fetching && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                  Ver más
                </Button>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

/* ───────────── Filas ───────────── */

const ROW = 'flex min-h-[78px] items-center gap-3.5 border-b border-[var(--m-separator)] py-3 pr-4 pl-4 last:border-b-0 sm:gap-[18px] sm:pr-[18px]';
const LINK = 'text-xs font-semibold text-amber-strong underline-offset-4 hover:underline';

function EntryRow({ entry }: { entry: TimelineEntry<CreditTransaction, Generation> }) {
  return entry.kind === 'tx'
    ? <TransactionRow tx={entry.tx} generation={entry.generation} refundEvidence={entry.refundEvidence} />
    : <GenerationOnlyRow g={entry.generation} />;
}

/** Fila de un movimiento: el diseño de siempre de «Tu actividad de fichas». */
function TransactionRow({ tx, generation, refundEvidence }: { tx: CreditTransaction; generation: Generation | null; refundEvidence: boolean }) {
  const Icon = TX_ICON[tx.type] ?? Settings2;
  const { title, detail } = describeTransaction(tx);
  const positive = tx.amount >= 0;
  return (
    <li className={ROW}>
      <span className={cn('flex size-[52px] shrink-0 items-center justify-center rounded-full text-primary-foreground', TX_TONE[tx.type] ?? 'bg-element-sound')} aria-hidden>
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate font-display text-base font-bold text-foreground">{title}</p>
        <p className="mt-0.5 truncate text-[13px] text-muted-foreground">
          {detail ? `${detail} · ` : ''}
          {formatRelative(tx.createdAt)}
        </p>
        {/* Lo que le pasó a la generación de este movimiento, solo en su débito (el reintegro ya dice «Devolución») */}
        {generation && tx.type === 'GENERATION_DEBIT' && <GenerationLine g={generation} refundEvidence={refundEvidence} />}
      </div>
      <div className="shrink-0 text-right">
        <p className={cn('font-display text-base font-bold tabular-nums', positive ? 'text-success' : 'text-coral')}>
          {positive ? '+' : '−'}
          {fmtInt(Math.abs(tx.amount))}
        </p>
        <p className="text-[12px] tabular-nums text-muted-foreground">Saldo {fmtInt(tx.balanceAfter)}</p>
      </div>
    </li>
  );
}

/** Generación sin movimientos de fichas que la representen (p. ej. una fallida sin cobro): misma fila, sin importe ni saldo. */
function GenerationOnlyRow({ g }: { g: Generation }) {
  const StatusIcon = g.status === 'COMPLETED' ? CheckCircle2 : g.status === 'FAILED' ? XCircle : Music4;
  const label = generationLabels(g.generationTypes)[0] ?? 'Generación';
  return (
    <li className={ROW}>
      <span className="flex size-[52px] shrink-0 items-center justify-center rounded-full bg-element-lyrics text-primary-foreground" aria-hidden>
        <StatusIcon className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate font-display text-base font-bold text-foreground">{label}</p>
        <p className="mt-0.5 truncate text-[13px] text-muted-foreground">{formatRelative(g.createdAt)}</p>
        <GenerationLine g={g} refundEvidence={false} />
      </div>
      {g.creditsCost === 0 && <p className="shrink-0 text-[12px] text-muted-foreground">Sin cargo</p>}
    </li>
  );
}

const STATE_TEXT: Partial<Record<Generation['status'], string>> = {
  FAILED: 'No se completó',
  CANCELED: 'Cancelada',
  PENDING: 'En cola',
  PROCESSING: 'Generando…',
};

/** Estado y acciones de la generación (las acciones de recuperación pertenecen a la generación, no al movimiento). */
function GenerationLine({ g, refundEvidence }: { g: Generation; refundEvidence: boolean }) {
  const title = activityTitleOf(g); // un Remix bloqueado no muestra el título heredado
  const state = STATE_TEXT[g.status];
  const returned = g.status === 'FAILED' && refundEvidence;
  const recoverable = canRecoverFromHistory(g);
  const retried = g.status === 'FAILED' && Boolean(g.retriedBy);
  const remixBlocked = g.status === 'FAILED' && isRemixBlocked(g); // Remix de otra persona sin origen autorizado: no se recupera
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-muted-foreground">
      {title && <span className="max-w-full truncate font-medium text-foreground/80" title={title}>{title}</span>}
      {g.retryOf && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium">Reintento</span>}
      {state && <span>{state}{returned ? ' · Fichas devueltas' : ''}</span>}
      {g.songId && <button type="button" className={LINK} onClick={() => navigate(`/songs/${g.songId}`)}>Ver canción</button>}
      {recoverable && <button type="button" className={LINK} onClick={() => navigate(`/create?recover=${g.id}`)}>Recuperar</button>}
      {retried && <span>Ya se volvió a intentar</span>}
      {remixBlocked && !retried && <span>Remix no disponible</span>}
    </p>
  );
}
