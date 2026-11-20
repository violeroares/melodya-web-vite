
/**
 * MELODYA WEB — NotificationsView: centro de notificaciones (ruta #/notifications, 🔒).
 *
 * Contratos reales (backend v0.18.0):
 *  • GET  /notifications?page&pageSize&unread=1&type=CSV&search   → Paginated<AppNotification>
 *  • GET  /notifications/unread-count                               → { count }
 *  • POST /notifications/:id/read                                    → AppNotification
 *  • POST /notifications/read-all                                    → { updated }
 *
 * El evento socket `notification:created` (useRealtime en AppShell) invalida
 * ['notifications'] y repinta esta vista en vivo — acá no hace falta socket.
 * Nada se marca como leído sin interacción del usuario.
 */
import { useMemo, useRef, useState } from 'react';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { Bell, Check, CheckCheck, Heart, Loader2, MessageCircle, Search, Sparkles, UserPlus, X } from 'lucide-react';
import { notificationsApi } from '@/lib/api';
import { navigate } from '@/lib/router';
import { toUserMessage } from '@/lib/errors';
import { cn } from '@/lib/utils';
import { formatRelative, useDebounce } from '@/hooks';
import { AuthAvatar, EmptyState, ErrorState } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import type { AppNotification, NotificationType, Paginated } from '@/types';

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 400;

/* ── Categorías del filtro (mapean a ?type= csv del backend) ── */
type NotificationCategory = 'all' | 'followers' | 'comments' | 'likes' | 'system';

const CATEGORIES: Array<{ value: NotificationCategory; label: string; types?: string }> = [
  { value: 'all', label: 'Todas' },
  { value: 'followers', label: 'Seguidores', types: 'NEW_FOLLOWER' },
  { value: 'comments', label: 'Comentarios', types: 'SONG_COMMENT,COMMENT_REPLY' },
  { value: 'likes', label: 'Me gusta', types: 'SONG_LIKE,COMMENT_LIKE' },
  { value: 'system', label: 'Sistema', types: 'SYSTEM' },
];

/* ── Presentación por tipo: ícono en círculo suave ── */
function typeVisual(type: NotificationType): { Icon: typeof UserPlus; circle: string; filled?: boolean } {
  switch (type) {
    case 'NEW_FOLLOWER':
      return { Icon: UserPlus, circle: 'bg-element-sound/25 text-foreground' };
    case 'SONG_COMMENT':
    case 'COMMENT_REPLY':
      return { Icon: MessageCircle, circle: 'bg-coral/15 text-coral' };
    case 'SONG_LIKE':
    case 'COMMENT_LIKE':
      return { Icon: Heart, circle: 'bg-amber/15 text-amber-strong', filled: true };
    default:
      return { Icon: Sparkles, circle: 'bg-surface-2 text-muted-foreground' };
  }
}

/** Destino de la fila (solo tipos con contexto; SYSTEM no navega). */
function notificationHref(n: AppNotification): string | null {
  if (n.type === 'SYSTEM') return null;
  if (n.type === 'NEW_FOLLOWER') return n.actor ? `/user/${encodeURIComponent(n.actor.id)}` : null;
  if (n.song) return `/songs/${encodeURIComponent(n.song.id)}`;
  if (n.actor) return `/user/${encodeURIComponent(n.actor.id)}`;
  return null;
}

/** Frase de la notificación: actor en <b> y canción entre «». */
function NotificationText({ n }: { n: AppNotification }) {
  if (n.type === 'SYSTEM') {
    // Los avisos del sistema viajan en commentExcerpt (contrato v0.18.0).
    return <>{n.commentExcerpt ?? 'Novedades de Melodya'}</>;
  }
  const actor = <b className="font-semibold text-foreground">{n.actor?.name ?? 'Alguien'}</b>;
  const song = n.song ? <span className="font-medium text-foreground">«{n.song.title}»</span> : null;
  switch (n.type) {
    case 'SONG_COMMENT':
      return song ? <>{actor} comentó en {song}</> : <>{actor} comentó tu canción</>;
    case 'COMMENT_REPLY':
      return song ? <>{actor} respondió tu comentario en {song}</> : <>{actor} respondió tu comentario</>;
    case 'COMMENT_LIKE':
      return song ? (
        <>
          A {actor} le gustó tu comentario en {song}
        </>
      ) : (
        <>
          A {actor} le gustó tu comentario
        </>
      );
    case 'SONG_LIKE':
      return song ? (
        <>
          A {actor} le gustó {song}
        </>
      ) : (
        <>
          A {actor} le gustó tu canción
        </>
      );
    default:
      return <>{actor} empezó a seguirte</>;
  }
}

/* ── Fila de notificación ── */
function NotificationRow({
  n,
  onOpen,
  onMarkRead,
}: {
  n: AppNotification;
  onOpen: (n: AppNotification) => void;
  onMarkRead: (id: string) => void;
}) {
  const unread = !n.readAt;
  const href = notificationHref(n);
  const clickable = Boolean(href);
  const { Icon, circle, filled } = typeVisual(n.type);
  const excerpt = n.type !== 'SYSTEM' ? n.commentExcerpt : null;

  /* El cuerpo cambia de elemento: botón real si navega, div si no (SYSTEM). */
  const bodyClass =
    'flex min-w-0 flex-1 items-start gap-3 rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

  const content = (
    <>
      <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full', circle)} aria-hidden>
        <Icon className={cn('h-4 w-4', filled && 'fill-current')} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
          <span className="flex min-w-0 items-center gap-1.5 text-sm leading-snug text-foreground/80">
            {n.actor && (
              <AuthAvatar
                src={n.actor.avatarUrl}
                name={n.actor.name}
                className="h-5 w-5 shrink-0"
                fallbackClassName="text-[8px]"
              />
            )}
            <NotificationText n={n} />
          </span>
          <time
            className="shrink-0 text-xs text-muted-foreground"
            dateTime={n.createdAt}
            title={new Date(n.createdAt).toLocaleString('es-AR')}
          >
            {formatRelative(n.createdAt)}
          </time>
        </span>
        {excerpt && (
          <span className="mt-0.5 block truncate text-xs italic text-muted-foreground" aria-hidden>
            «{excerpt}»
          </span>
        )}
      </span>
    </>
  );

  return (
    <li
      className={cn(
        'group flex items-start gap-2.5 rounded-xl px-3 py-3 transition-colors',
        unread ? 'bg-amber/5' : '',
        clickable ? 'hover:bg-surface-2/50' : 'cursor-default'
      )}
    >
      {/* Punto ámbar de no leída (columna fija para no mover el layout) */}
      <span className="mt-4 flex h-2 w-2 shrink-0 items-center justify-center" aria-hidden>
        {unread && <span className="h-2 w-2 animate-in fade-in zoom-in-95 rounded-full gradient-warm" />}
      </span>

      {clickable ? (
        <button
          type="button"
          onClick={() => onOpen(n)}
          aria-label={`Abrir: ${n.type === 'NEW_FOLLOWER' ? `perfil de ${n.actor?.name ?? 'alguien'}` : n.song?.title ?? 'notificación'}`}
          className={bodyClass}
        >
          {content}
        </button>
      ) : (
        <div className={bodyClass}>{content}</div>
      )}

      {/* Marcar leída explícita: aparece al pasar por la fila (siempre en touch y focus) */}
      {unread && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onMarkRead(n.id);
          }}
          aria-label="Marcar como leída"
          title="Marcar como leída"
          className="mt-1.5 shrink-0 rounded-md p-1.5 text-muted-foreground opacity-0 transition-all hover:bg-surface-2 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 max-sm:opacity-100"
        >
          <Check className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
    </li>
  );
}

/* ══════════════ Vista principal ══════════════ */
export function NotificationsView() {
  const qc = useQueryClient();
  const { toast } = useToast();

  /* Filtros locales (no viven en la URL) */
  const [category, setCategory] = useState<NotificationCategory>('all');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const search = useDebounce(searchInput.trim(), SEARCH_DEBOUNCE_MS);

  const activeTypes = CATEGORIES.find((c) => c.value === category)?.types;
  const hasFilters = category !== 'all' || unreadOnly || search.length > 0;

  /* Contador sin leer (misma key que la campanita del Header → cache compartida) */
  const unreadQuery = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: () => notificationsApi.unreadCount(),
  });
  const unreadCount = unreadQuery.data?.count ?? 0;

  /* Lista infinita (GET /notifications con filtros) */
  const listQuery = useInfiniteQuery({
    queryKey: ['notifications', 'list', { category, unread: unreadOnly, search: search || null }],
    queryFn: ({ pageParam }) =>
      notificationsApi.list({
        page: pageParam,
        pageSize: PAGE_SIZE,
        unread: unreadOnly ? '1' : undefined,
        type: activeTypes,
        search: search || undefined,
      }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.pagination.page < last.pagination.pages ? last.pagination.page + 1 : undefined),
    placeholderData: keepPreviousData,
  });

  const items = useMemo(() => listQuery.data?.pages.flatMap((p) => p.items) ?? [], [listQuery.data]);
  const total = listQuery.data?.pages[0]?.pagination.total ?? 0;

  /* Marcar una como leída (optimista: la fila pierde el highlight al toque). */
  const markReadMutation = useMutation({
    mutationFn: (id: string) => notificationsApi.markRead(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ['notifications', 'list'] });
      let wasUnread = false;
      qc.setQueriesData<InfiniteData<Paginated<AppNotification>>>({ queryKey: ['notifications', 'list'] }, (old) =>
        old
          ? {
              ...old,
              pages: old.pages.map((page) => ({
                ...page,
                items: page.items.map((it) => {
                  if (it.id === id && !it.readAt) {
                    wasUnread = true;
                    return { ...it, readAt: new Date().toISOString() };
                  }
                  return it;
                }),
              })),
            }
          : old
      );
      if (wasUnread) {
        qc.setQueryData<{ count: number }>(['notifications', 'unread-count'], (old) =>
          old ? { count: Math.max(0, old.count - 1) } : old
        );
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  /* Marcar todas como leídas (POST /notifications/read-all). */
  const markAllMutation = useMutation({
    mutationFn: () => notificationsApi.markAll(),
    onSuccess: (res) => {
      toast({
        title: 'Todo al día ✅',
        description: `${res.updated} ${res.updated === 1 ? 'notificación marcada' : 'notificaciones marcadas'} como leídas.`,
      });
    },
    onError: (err) => {
      toast({ title: 'No pudimos marcarlas como leídas', description: toUserMessage(err), variant: 'destructive' });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  /* Click en fila: marca como leída (si corresponde) y navega al contexto. */
  const onOpen = (n: AppNotification) => {
    const href = notificationHref(n);
    if (!n.readAt) markReadMutation.mutate(n.id);
    if (href) navigate(href);
  };

  const clearFilters = () => {
    setCategory('all');
    setUnreadOnly(false);
    setSearchInput('');
  };

  return (
    <div className="view-in mx-auto w-full max-w-7xl space-y-5">
      {/* Encabezado */}
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-extrabold tracking-tight text-foreground">Notificaciones</h1>
          <p className="mt-1 text-sm text-muted-foreground">Todo lo que pasa con tu música, en un solo lugar</p>
        </div>
        {unreadCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="rounded-full text-amber-strong"
            onClick={() => markAllMutation.mutate()}
            disabled={markAllMutation.isPending}
          >
            {markAllMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <CheckCheck className="h-4 w-4" aria-hidden />
            )}
            Marcar todas como leídas
          </Button>
        )}
      </header>

      {/* Barra de filtros (sticky bajo el header global) */}
      <div className="sticky top-16 z-20 flex flex-wrap items-center gap-2 rounded-2xl border border-border/70 bg-surface/95 p-2.5">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Categoría de notificaciones">
          {CATEGORIES.map((c) => {
            const active = category === c.value;
            return (
              <button
                key={c.value}
                type="button"
                onClick={() => setCategory(c.value)}
                aria-pressed={active}
                className={cn(
                  'rounded-full px-3 py-1.5 text-xs font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active
                    ? 'gradient-warm text-primary-foreground'
                    : 'border border-border bg-surface-2 text-muted-foreground hover:border-amber/40 hover:text-foreground'
                )}
              >
                {c.label}
              </button>
            );
          })}
        </div>

        <div className="ml-auto flex flex-1 flex-wrap items-center justify-end gap-2">
          <label className="flex shrink-0 cursor-pointer items-center gap-2 rounded-full border border-border/70 bg-surface-2/50 py-1 pl-2 pr-3">
            <Switch checked={unreadOnly} onCheckedChange={setUnreadOnly} aria-label="Solo sin leer" className="scale-90" />
            <span className="text-xs font-medium text-muted-foreground">Solo sin leer</span>
          </label>

          <div className="relative min-w-0 flex-1 sm:max-w-60">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              ref={searchInputRef}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              type="text"
              placeholder="Buscar en notificaciones…"
              aria-label="Buscar en notificaciones"
              className="h-11 rounded-full pl-9 pr-8 text-sm font-normal"
            />
            {searchInput && (
              <button
                type="button"
                onClick={() => {
                  setSearchInput('');
                  searchInputRef.current?.focus();
                }}
                aria-label="Limpiar la búsqueda"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Lista */}
      {listQuery.isPending ? (
        <div className="space-y-2" aria-busy="true" aria-label="Cargando notificaciones">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-start gap-3 px-3 py-3">
              <Skeleton className="mt-1 h-9 w-9 shrink-0 rounded-full" />
              <div className="flex-1 space-y-2 pt-1">
                <Skeleton className="h-3.5 w-2/3" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            </div>
          ))}
        </div>
      ) : listQuery.isError ? (
        <ErrorState
          message={toUserMessage(listQuery.error, 'No pudimos cargar tus notificaciones.')}
          onRetry={() => void listQuery.refetch()}
        />
      ) : items.length === 0 ? (
        hasFilters ? (
          <EmptyState
            icon={<Bell className="h-7 w-7" />}
            title="No hay nada acá con esos filtros"
            description="Probá con otra categoría, quitá el filtro de sin leer o cambiá la búsqueda."
            actionLabel="Limpiar filtros"
            onAction={clearFilters}
          />
        ) : (
          <EmptyState
            icon={<Bell className="h-7 w-7" />}
            title="Todavía estás en paz"
            description="Cuando alguien te siga, comente tu música o le guste lo que hacés, te enterás acá primero."
            actionLabel="Explorar comunidad"
            actionTo="/community"
          />
        )
      ) : (
        <>
          <div className="overflow-hidden rounded-cover border border-border/70 bg-surface/50">
            <ul className="divide-y divide-border/50" aria-label="Notificaciones">
              {items.map((n) => (
                <NotificationRow key={n.id} n={n} onOpen={onOpen} onMarkRead={(id) => markReadMutation.mutate(id)} />
              ))}
            </ul>
          </div>

          {/* Paginación estilo infinito */}
          <div className="flex flex-col items-center gap-2 pt-1">
            {listQuery.hasNextPage && (
              <Button
                variant="outline"
                className="rounded-full px-6"
                onClick={() => void listQuery.fetchNextPage()}
                disabled={listQuery.isFetchingNextPage}
              >
                {listQuery.isFetchingNextPage ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> Cargando…
                  </>
                ) : (
                  'Cargar más'
                )}
              </Button>
            )}
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {total} {total === 1 ? 'notificación' : 'notificaciones'}
            </p>
          </div>
        </>
      )}
    </div>
  );
}
