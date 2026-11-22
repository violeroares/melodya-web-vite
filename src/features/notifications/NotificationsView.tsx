'use client';

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
import {
  Bell,
  BellDot,
  CheckCheck,
  Heart,
  Loader2,
  MessageCircle,
  Search,
  Sparkles,
  UserPlus,
  X,
  type LucideIcon,
} from 'lucide-react';
import { communityApi, notificationsApi } from '@/lib/api';
import { navigate } from '@/lib/router';
import { toUserMessage } from '@/lib/errors';
import { cn } from '@/lib/utils';
import { formatRelative, useDebounce } from '@/hooks';
import { AuthAvatar, EmptyState, ErrorState } from '@/components/common';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { Button } from '@/components/ui/button';
import { TabCtaButton } from '@/features/library/library-utils';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import type { AppNotification, Paginated } from '@/types';

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 400;

/* ── Categorías del filtro (mapean a ?type= csv del backend) ── */
type NotificationCategory = 'all' | 'followers' | 'comments' | 'likes' | 'system' | 'unread';

const CATEGORIES: Array<{
  value: NotificationCategory;
  label: string;
  types?: string;
  icon: LucideIcon;
}> = [
  { value: 'all', label: 'Todas', icon: Bell },
  { value: 'followers', label: 'Seguidores', types: 'NEW_FOLLOWER', icon: UserPlus },
  {
    value: 'comments',
    label: 'Comentarios',
    types: 'SONG_COMMENT,COMMENT_REPLY',
    icon: MessageCircle,
  },
  { value: 'likes', label: 'Me gusta', types: 'SONG_LIKE,COMMENT_LIKE', icon: Heart },
  { value: 'system', label: 'Sistema', types: 'SYSTEM', icon: Sparkles },
  /* Una opción más del selector: muestra solo lo no leído (de todas las categorías) */
  { value: 'unread', label: 'Solo sin leer', icon: BellDot },
];

/** Aviso de sistema que informa un fallo («No pudimos generar…»): el backend no manda una marca, se reconoce por el texto. */
const FAILURE_TEXT = /no pudimos|no se pudo|fall[óo]|error/i;
function isFailureNotice(n: AppNotification): boolean {
  return n.type === 'SYSTEM' && FAILURE_TEXT.test(n.commentExcerpt ?? '');
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
  const actor = <b className="font-bold text-foreground">{n.actor?.name ?? 'Alguien'}</b>;
  const song = n.song ? <span className="font-bold text-muted-foreground">«{n.song.title}»</span> : null;
  switch (n.type) {
    case 'SONG_COMMENT':
      return song ? (
        <>
          {actor} comentó en {song}
        </>
      ) : (
        <>{actor} comentó tu canción</>
      );
    case 'COMMENT_REPLY':
      return song ? (
        <>
          {actor} respondió tu comentario en {song}
        </>
      ) : (
        <>{actor} respondió tu comentario</>
      );
    case 'COMMENT_LIKE':
      return song ? (
        <>
          A {actor} le gustó tu comentario en {song}
        </>
      ) : (
        <>A {actor} le gustó tu comentario</>
      );
    case 'SONG_LIKE':
      return song ? (
        <>
          A {actor} le gustó {song}
        </>
      ) : (
        <>A {actor} le gustó tu canción</>
      );
    default:
      return <>{actor} empezó a seguirte</>;
  }
}

/* ── Fila de notificación ── */
function NotificationRow({ n, onOpen }: { n: AppNotification; onOpen: (n: AppNotification) => void }) {
  const unread = !n.readAt;
  const href = notificationHref(n);
  const clickable = Boolean(href);
  const excerpt = n.type !== 'SYSTEM' ? n.commentExcerpt : null;
  const failure = isFailureNotice(n);
  const leadAvatar = n.type !== 'SYSTEM' && Boolean(n.actor);
  /* Si la notificación no trae la foto del actor, se pide a su perfil público (cache compartida con el perfil). */
  const profileQuery = useQuery({
    queryKey: ['community', 'user', n.actor?.id],
    queryFn: () => communityApi.userProfile(n.actor!.id),
    enabled: leadAvatar && !n.actor?.avatarUrl,
    staleTime: 5 * 60_000,
  });
  const actorAvatar = n.actor?.avatarUrl ?? profileQuery.data?.avatarUrl ?? null;

  /* El cuerpo cambia de elemento: botón real si navega, div si no (SYSTEM). */
  const bodyClass =
    'flex min-w-0 flex-1 items-center gap-3 rounded-[32px_12px_12px_32px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

  const content = (
    <>
      <span className="relative shrink-0">
        {leadAvatar && n.actor ? (
          /* Seguidores, comentarios y me gusta: la foto real de quien lo hizo */
          <AuthAvatar
            src={actorAvatar}
            name={n.actor.name}
            className="size-11 border-0 sm:size-[52px]"
            fallbackClassName="bg-[var(--m-accent-soft)] text-base font-bold text-[#131C33]"
          />
        ) : failure ? (
          /* Error de sistema: círculo con borde punteado y «!», como en el diseño */
          <span
            className="flex size-11 items-center justify-center rounded-full border-[2.5px] sm:size-[52px] border-dashed border-[var(--m-label)] text-[24px] font-bold leading-none text-[var(--m-label)]"
            aria-hidden
          >
            !
          </span>
        ) : (
          /* Sin foto y sin error (avisos de Melodya): círculo dorado con la chispa, como en el diseño */
          <span
            className="flex size-11 items-center justify-center rounded-full bg-gold sm:size-[52px] text-[#131C33]"
            aria-hidden
          >
            <Sparkles className="h-[22px] w-[22px]" />
          </span>
        )}
        {/* Punto de no leída sobre el círculo (esquina superior derecha) */}
        {unread && (
          <span
            className="absolute right-0 top-0 size-3 animate-in fade-in zoom-in-95 rounded-full bg-[var(--m-accent)]"
            aria-hidden
          />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-start justify-between gap-3">
          {/* Una sola línea de texto corrido (avatar + frase), que envuelve sin partirse en columnas */}
          <span className="min-w-0 flex-1 text-[15px] font-bold leading-[1.3] text-foreground [overflow-wrap:anywhere]">
            {n.actor && !leadAvatar && (
              <AuthAvatar
                src={n.actor.avatarUrl}
                name={n.actor.name}
                className="mr-1.5 inline-flex h-5 w-5 align-middle"
                fallbackClassName="text-[8px]"
              />
            )}
            <NotificationText n={n} />
          </span>
          <time
            className="mt-0.5 shrink-0 whitespace-nowrap text-[12.5px] leading-[1.3] text-muted-foreground"
            dateTime={n.createdAt}
            title={new Date(n.createdAt).toLocaleString('es-AR')}
          >
            {formatRelative(n.createdAt)}
          </time>
        </span>
        {excerpt && (
          <span
            className="mt-0.5 block truncate font-display text-[13.5px] font-medium leading-[1.35] text-muted-foreground"
            aria-hidden
          >
            «{excerpt}»
          </span>
        )}
      </span>
    </>
  );

  return (
    <li
      className={cn(
        'group flex items-center gap-3 rounded-[40px_16px_16px_40px] border-[1.5px] py-3 pl-3 pr-3 transition-colors sm:pr-4',
        unread ? 'border-line bg-surface' : 'border-border',
        clickable ? 'hover:bg-surface' : 'cursor-default',
      )}
    >
      {clickable ? (
        <button
          type="button"
          onClick={() => onOpen(n)}
          aria-label={`Abrir: ${n.type === 'NEW_FOLLOWER' ? `perfil de ${n.actor?.name ?? 'alguien'}` : (n.song?.title ?? 'notificación')}`}
          className={bodyClass}
        >
          {content}
        </button>
      ) : (
        <div className={bodyClass}>{content}</div>
      )}
    </li>
  );
}

/* ── Buscador de la bandeja: el mismo campo, adentro o afuera del contenedor del selector según el ancho ── */
function NotificationSearch({
  value,
  onChange,
  className,
  outside,
}: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
  outside?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <div className={cn('relative min-w-0 flex-1', className)}>
      <Search
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        type="text"
        placeholder="Buscar en notificaciones…"
        aria-label="Buscar en notificaciones"
        className={cn(
          'rounded-full bg-[var(--m-input)] pl-9 pr-8 text-base font-normal md:text-sm',
          outside ? 'h-11 border-[1.5px] border-line' : 'h-10 rounded-[20px] border-0',
        )}
      />
      {value && (
        <button
          type="button"
          onClick={() => {
            onChange('');
            inputRef.current?.focus();
          }}
          aria-label="Limpiar la búsqueda"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}

/** Loader2 girando, con la forma de un ícono para pasarlo a TabCtaButton. */
const SpinnerIcon = ({ className }: { className?: string }) => <Loader2 className={cn(className, 'animate-spin')} aria-hidden />;

/* ══════════════ Vista principal ══════════════ */
export function NotificationsView() {
  const qc = useQueryClient();
  const { toast } = useToast();

  /* Filtros locales (no viven en la URL) */
  const [category, setCategory] = useState<NotificationCategory>('all');
  const [searchInput, setSearchInput] = useState('');
  const search = useDebounce(searchInput.trim(), SEARCH_DEBOUNCE_MS);

  const unreadOnly = category === 'unread';
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
          : old,
      );
      if (wasUnread) {
        qc.setQueryData<{ count: number }>(['notifications', 'unread-count'], (old) =>
          old ? { count: Math.max(0, old.count - 1) } : old,
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
      toast({
        title: 'No pudimos marcarlas como leídas',
        description: toUserMessage(err),
        variant: 'destructive',
      });
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
    setSearchInput('');
  };

  return (
    <div className="view-in mx-auto w-full max-w-7xl space-y-5">
      {/* Encabezado */}
      {/* El botón va junto al título si entra; si no, baja debajo del subtítulo */}
      <header className="@container grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
        <h1 className="min-w-0 font-display text-3xl font-extrabold tracking-tight text-foreground">Notificaciones</h1>
        <p className="col-span-2 row-start-2 text-sm text-muted-foreground">
          Todo lo que pasa con tu música, en un solo lugar
        </p>
        {/* Mismo botón que «Reproducir todo» de la Biblioteca (contorno fino); siempre visible, deshabilitado si no hay nada sin leer */}
        <div className="col-span-2 row-start-3 mt-2 justify-self-start @[34rem]:col-span-1 @[34rem]:col-start-2 @[34rem]:row-start-1 @[34rem]:mt-0">
          <TabCtaButton
            icon={markAllMutation.isPending ? SpinnerIcon : CheckCheck}
            kind="ghost"
            iconOnlyOnMobile={false}
            onClick={() => markAllMutation.mutate()}
            disabled={markAllMutation.isPending || unreadCount === 0}
          >
            Marcar todas como leídas
          </TabCtaButton>
        </div>
      </header>

      {/* Barra de filtros (sticky bajo el header global) */}
      <div className="@container sticky top-16 z-20 bg-background/95 py-2">
        {/* Mismo selector de grupo del sistema (se desliza con el mouse y muestra el ícono de la opción elegida) */}
        <SegmentedTabs
          tabs={CATEGORIES.map((c) => ({ key: c.value, label: c.label, icon: c.icon }))}
          value={category}
          onChange={setCategory}
          ariaLabel="Categoría de notificaciones"
          /* Con lugar: el buscador va adentro del contenedor, a la derecha de las opciones */
          trailing={<NotificationSearch value={searchInput} onChange={setSearchInput} />}
          trailingClassName="ml-auto hidden w-60 @min-[50rem]:block"
        />

        {/* Sin lugar (pantallas angostas): afuera del contenedor, a todo el ancho */}
        <div className="mt-2 @min-[50rem]:hidden">
          <NotificationSearch value={searchInput} onChange={setSearchInput} outside />
        </div>
      </div>

      {/* Lista */}
      {listQuery.isPending ? (
        <div className="space-y-3" aria-busy="true" aria-label="Cargando notificaciones">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-3.5 rounded-[40px_16px_16px_40px] border-[1.5px] border-border py-3 pl-3 pr-4"
            >
              <Skeleton className="size-11 shrink-0 rounded-full sm:size-[52px]" />
              <div className="flex-1 space-y-2">
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
          <ul className="flex flex-col gap-3" aria-label="Notificaciones">
            {items.map((n) => (
              <NotificationRow key={n.id} n={n} onOpen={onOpen} />
            ))}
          </ul>

          {/* Paginación estilo infinito */}
          <div className="flex flex-col items-center gap-2 pt-1">
            {listQuery.hasNextPage && (
              <Button
                variant="outline"
                className="rounded-full border-[1.5px] border-line px-6"
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
            <p className="text-[13.5px] font-medium text-muted-foreground" aria-live="polite">
              {total} {total === 1 ? 'notificación' : 'notificaciones'}
            </p>
          </div>
        </>
      )}
    </div>
  );
}
