
/**
 * MELODYA WEB — SongDetailView: detalle de canción propia (ruta /songs/:id).
 *
 * Contratos reales usados (melodya-backend v0.13):
 *  • GET    /songs/:id                        → detalle (dueño/admin o PUBLIC)
 *  • GET    /songs/:id/versions               → versiones con audioUrl
 *  • PATCH  /songs/:id                         → { title } | { currentVersionId } | { projectId }
 *  • PATCH  /songs/:id/visibility              → { visibility, allowComments }
 *  • DELETE /songs/:id                         → soft delete
 *  • POST   /songs/:id/comments · DELETE       /songs/:id/comments/:commentId
 *  • POST   /generations/cover                 → 202 (0 fichas, prompt/style opcionales, clientRequestId uuid)
 *  • POST   /songs/:id/cover                    → multipart 5 MB (portada propia; el backend la expone)
 *  • PATCH  /songs/:id                        → title · styleSummary · description («Editar detalles»)
 *  • GET    /projects                          → proyectos propios (para "Agregar a proyecto")
 *  • GET    /community/songs/:id/comments       → comentarios (solo canciones PUBLIC)
 */
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import {
  Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronUp, Clock, Copy, CornerDownRight, Download, Flag, FolderOpen, FolderPlus, Globe, Heart, ImagePlus,
  ListEnd, ListMusic, ListStart, Loader2, Lock, MessageCircle, MoreVertical, Music4, Palette, Pause, Pencil, Play, RotateCcw, Send, Share2, Sparkles, ThumbsDown, Trash2,
  Upload, UserCheck, UserPlus, Users, X,
} from 'lucide-react';
import { communityApi, generationApi, profileApi, projectsApi, songsApi } from '@/lib/api';
import { queryPollDelayMs } from '@/lib/api/resilience';
import { apiFileUrl } from '@/lib/api/client';
import { Link, goBack, navigate, useRoute } from '@/lib/router';
import { toUserMessage } from '@/lib/errors';
import { COMMENT_CHECKING_DELAY_MS, canSubmitComment, classifyCommentFailure } from '@/lib/comment-moderation';
import { cn } from '@/lib/utils';
import { shareContent } from '@/lib/share';
import { songUrl, songPath } from '@/lib/links';
import { downloadSongAudio, type DownloadFormat } from '@/lib/song-download';
import { useDownloadState, useEntitlements } from '@/hooks/use-capabilities';
import { usePlanGate } from '@/hooks/use-plan-gate';
import { LOCKED_CONTROL, RequiredPlanBadge } from '@/components/common/PlanGate';
import { LOCK_REASON, hasWavInProgress, newlyReadyWavs, wavMenuState } from '@/lib/capabilities';
import { wavStatusText } from '@/lib/wav-flow';
import { useWavFlow } from '@/features/song/useWavFlow';
import { usePlayerStore, type PlayerTrack } from '@/stores/player';
import { useAuthStore } from '@/stores/auth';
import { formatDuration, formatNumber, formatRelative } from '@/hooks';
import { AuthAvatar, Chip, CoverArt, EmptyState, EqualizerBars, ErrorState, LoadingRows, SectionHeader } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useToast } from '@/hooks/use-toast';
import { WavMenuItem } from '@/features/song/WavMenuItem';
import { EditSongDetailsDialog } from '@/features/song/EditSongDetailsDialog';
import { restoreInvalidationKeys, shouldFallbackToCommunity, songDetailAccess } from '@/features/song/trashed-song';
import { RemixMenu } from '@/features/song/RemixMenu';
import { RemixIcon } from '@/features/song/RemixIcon';
import { RemixAttribution } from '@/features/song/RemixAttribution';
import { remixMenuState } from '@/features/creator/remix-source';
import { customStyleSummary, derivedStyleHint, hasText } from '@/features/song/song-details';
import { ReportDialog, type ReportTarget } from '@/features/community/ReportDialog';
import { useCommunityReaction } from '@/features/community/CommunityView';
import { CommunitySongSection } from '@/features/community/CommunitySongSection';
import { LIST_MENU_COMFORTABLE_MOBILE } from '@/features/library/library-utils';
import type { CommunitySongDetail, Generation, Paginated, Project, Song, SongComment } from '@/types';

/* ── helpers ── */
const SECTION_LABELS: Record<string, string> = {
  intro: 'Intro', verse: 'Verso', verso: 'Verso', coro: 'Coro', chorus: 'Estribillo',
  'pre-chorus': 'Pre-estribillo', prechorus: 'Pre-estribillo', bridge: 'Puente', outro: 'Outro', hook: 'Hook',
};
const GEN_STATUS_LABEL: Record<string, string> = {
  PENDING: 'Pendiente', PROCESSING: 'Procesando', COMPLETED: 'Completada', FAILED: 'Fallida', CANCELED: 'Cancelada',
};
const LYRICS_SOURCE_LABEL: Record<string, string> = {
  USER: 'Escrita por vos', AI: 'Generada con Melodya', AI_EDITED: 'Melodya, editada por vos',
};

/** Los values string a veces llegan con comillas envolventes (p. ej. género). */
/** Estilos pedidos al generar (inputs de la generación): géneros, descripción, voz y tags excluidos. */
function styleInputs(gen: Generation | null | undefined) {
  const inputs = gen?.inputs ?? [];
  const list = (field: string): string[] => {
    const v = inputs.find((i) => i.field === field)?.value;
    return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : typeof v === 'string' && v.trim() ? [v.trim()] : [];
  };
  const description = inputs.find((i) => i.field === 'STYLE_DESCRIPTION')?.text?.trim() || null;
  const vocal = inputs.find((i) => i.field === 'VOCAL_GENDER')?.value;
  return {
    genres: list('GENRE'),
    description,
    vocal: vocal === 'female' ? 'Voz femenina' : vocal === 'male' ? 'Voz masculina' : null,
    excluded: list('NEGATIVE_TAGS'),
  };
}

function cleanTag(v: string): string {
  return v.replace(/^["'\s]+|["'\s]+$/g, '');
}

/** El backend devuelve audioUrl relativas (/api/files/{id}/stream): hay que
 *  resolverlas contra el origin del API (VITE_API_BASE_URL). Sin esto,
 *  con el API en otro origen el audio apuntaba al origen de la web y el
 *  reproductor fallaba con NotSupportedError («no supported sources»). */
function resolveAudioUrl(url: string | null | undefined): string | null {
  return url ? apiFileUrl(url) ?? url : null;
}
function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const LYRICS_COLLAPSED_PX = 420;

/** Detalle público de comunidad → forma de `Song` (para canciones ajenas o vistas como invitado). */
function songFromCommunity(c: CommunitySongDetail): Song {
  return {
    id: c.id,
    userId: c.author.id,
    projectId: null,
    title: c.title,
    coverUrl: c.coverUrl,
    visibility: 'PUBLIC',
    allowComments: c.allowComments,
    allowRemix: c.allowRemix ?? false,
    remixCount: c.remixCount ?? 0,
    origin: c.origin ?? null,
    styleSummary: c.styleSummary ?? null,
    description: c.description ?? null,
    currentVersionId: null,
    completedVersionCount: 1,
    likesCount: c.likesCount,
    dislikesCount: c.dislikesCount,
    playsCount: c.playsCount,
    commentsCount: c.commentsCount,
    lastGenerationAt: null,
    createdAt: c.createdAt,
    updatedAt: c.createdAt,
    currentVersion: {
      id: c.id,
      songId: c.id,
      versionNumber: 1,
      generationId: null,
      title: c.title,
      lyricsText: c.lyrics,
      lyricsSource: null,
      durationSec: c.durationSec,
      genre: c.genre,
      tags: c.tags,
      createdAt: c.createdAt,
      audioUrl: c.audioUrl,
    },
  };
}

/* ── Letra: [secciones] en ámbar, resto como texto ── */
function LyricsBody({ text }: { text: string }) {
  const lines = text.split('\n');
  const isSection = (l: string | undefined) => l !== undefined && /^\s*\[([^\]]+)\]\s*$/.test(l);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const innerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = innerRef.current;
    if (el) setOverflows(el.scrollHeight > LYRICS_COLLAPSED_PX);
  }, [text]);
  const collapsed = overflows && !expanded;
  return (
    <div>
      <div
        ref={innerRef}
        className={collapsed ? 'overflow-hidden' : undefined}
        style={collapsed ? { maxHeight: LYRICS_COLLAPSED_PX, WebkitMaskImage: 'linear-gradient(to bottom, black calc(100% - 64px), transparent 100%)', maskImage: 'linear-gradient(to bottom, black calc(100% - 64px), transparent 100%)' } : undefined}
        role="region"
        aria-label="Letra de la canción"
      >
      <div className="whitespace-pre-line py-5">
        {lines.map((line, i) => {
          const section = /^\s*\[([^\]]+)\]\s*$/.exec(line);
          if (section) {
            const label = SECTION_LABELS[section[1].toLowerCase().trim()] ?? section[1];
            return (
              <p key={i} className="mb-1.5 mt-6 flex items-center gap-2 font-display text-xs font-bold uppercase tracking-[0.18em] text-amber-strong first:mt-0">
                <span aria-hidden className="h-3.5 w-[3px] rounded-full gradient-warm" />
                {label}
              </p>
            );
          }
          /* Línea en blanco previa a una sección (o repetida): se omite; el margen de la sección ya separa los bloques. */
          if (!line.trim() && (i === 0 || isSection(lines[i + 1]) || !lines[i + 1]?.trim())) return null;
          return <p key={i} className="text-[15px] leading-[1.8] text-foreground/90">{line || '\u00A0'}</p>;
        })}
      </div>
      </div>
      {overflows && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="mt-2 inline-flex items-center gap-1 rounded-md text-sm font-medium text-amber-strong transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {expanded ? (
            <>
              <ChevronUp className="h-4 w-4" aria-hidden />
              Mostrar menos
            </>
          ) : (
            <>
              <ChevronDown className="h-4 w-4" aria-hidden />
              Mostrar más
            </>
          )}
        </button>
      )}
    </div>
  );
}

/* ── Hilos de comentarios (v0.15.0): la API devuelve la lista PLANA (raíces +
   respuestas mezcladas, createdAt desc) y la UI arma el árbol. Las respuestas se
   agrupan por parentId y se ordenan ASC para que la conversación fluya; una
   respuesta cuyo padre no está en la página cargada se muestra como raíz
   (no queda huérfana). ── */
function buildThreads(comments: SongComment[]) {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const roots = comments.filter((c) => !c.parentId || !byId.has(c.parentId));
  const repliesOf = new Map<string, SongComment[]>();
  for (const c of comments) {
    if (!c.parentId || !byId.has(c.parentId)) continue;
    const list = repliesOf.get(c.parentId) ?? [];
    list.push(c);
    repliesOf.set(c.parentId, list);
  }
  repliesOf.forEach((list) => list.sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  return { roots, repliesOf };
}

/* ── Comentarios (solo canciones PUBLIC) ── */
function CommentsSection({
  song,
  currentUserId,
  canModerate,
  action,
  onReportComment,
}: {
  song: Song;
  currentUserId?: string;
  canModerate: boolean;
  action?: ReactNode;
  /** v0.18.0 — abre el dialog de denuncia para comentarios ajenos. */
  onReportComment: (comment: SongComment) => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  /* hilo de conversación: respuesta en curso (siempre cuelga de la raíz) y
     raíces expandidas (las de +3 respuestas arrancan colapsadas en 2) */
  const [replyTo, setReplyTo] = useState<{ id: string; name: string } | null>(null);
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(new Set());
  const composerInputRef = useRef<HTMLInputElement | null>(null);
  /* moderación previa de comentarios (la decisión es del backend): mensaje de rechazo junto al editor y aviso de «revisando…» */
  const [rejection, setRejection] = useState<string | null>(null);
  const [checkingFor, setCheckingFor] = useState<number | null>(null);

  const commentsQuery = useInfiniteQuery({
    queryKey: ['song', song.id, 'comments'],
    queryFn: ({ pageParam }) => communityApi.comments(song.id, { page: pageParam, limit: 20 }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.pagination.page < last.pagination.pages ? last.pagination.page + 1 : undefined),
  });

  const addMutation = useMutation({
    mutationFn: (vars: { content: string; parentId?: string }) => songsApi.addComment(song.id, vars.content, vars.parentId),
    onMutate: () => setRejection(null),
    onSuccess: async () => {
      setDraft('');
      setReplyTo(null);
      setRejection(null);
      await qc.invalidateQueries({ queryKey: ['song', song.id] });
    },
    onError: (err) => {
      const failure = classifyCommentFailure(err, toUserMessage);
      if (failure.kind === 'rejected') {
        // COMMENT_REJECTED: no se guardó nada. El texto (y la respuesta en curso) se CONSERVAN para corregirlos.
        setRejection(failure.message);
        composerInputRef.current?.focus();
        return;
      }
      toast({ title: 'No pudimos publicar tu comentario', description: failure.message, variant: 'destructive' });
    },
  });

  /* «Revisando tu comentario…» solo si la validación tarda: una respuesta rápida no muestra ningún texto intermedio */
  const sending = addMutation.isPending;
  const submittedAt = addMutation.submittedAt;
  useEffect(() => {
    if (!sending) return undefined;
    const timer = window.setTimeout(() => setCheckingFor(submittedAt), COMMENT_CHECKING_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [sending, submittedAt]);
  const checking = sending && checkingFor === submittedAt; // atado a ESTE envío: un envío nuevo vuelve a esperar el retardo

  const removeMutation = useMutation({
    mutationFn: (commentId: string) => songsApi.deleteComment(song.id, commentId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['song', song.id] });
    },
    onError: (err) => toast({ title: 'No pudimos eliminar el comentario', description: toUserMessage(err), variant: 'destructive' }),
  });

  /* ── me gusta de comentario (POST /songs/:id/comments/:commentId/like, toggle
     optimista: el corazón reacciona al toque y el server reconcilia el total) ── */
  const likeMutation = useMutation({
    mutationFn: (commentId: string) => songsApi.likeComment(song.id, commentId),
    onMutate: async (commentId) => {
      await qc.cancelQueries({ queryKey: ['song', song.id, 'comments'] });
      qc.setQueryData<InfiniteData<Paginated<SongComment>>>(['song', song.id, 'comments'], (old) =>
        old
          ? {
              ...old,
              pages: old.pages.map((p) => ({
                ...p,
                items: p.items.map((c) =>
                  c.id === commentId
                    ? {
                        ...c,
                        viewerLiked: !c.viewerLiked,
                        likesCount: Math.max(0, (c.likesCount ?? 0) + (c.viewerLiked ? -1 : 1)),
                      }
                    : c
                ),
              })),
            }
          : old
      );
    },
    onSuccess: (res, commentId) => {
      qc.setQueryData<InfiniteData<Paginated<SongComment>>>(['song', song.id, 'comments'], (old) =>
        old
          ? {
              ...old,
              pages: old.pages.map((p) => ({
                ...p,
                items: p.items.map((c) => (c.id === commentId ? { ...c, viewerLiked: res.liked, likesCount: res.likesCount } : c)),
              })),
            }
          : old
      );
    },
    onError: (err) => {
      void qc.invalidateQueries({ queryKey: ['song', song.id, 'comments'] });
      toast({ title: 'No pudimos registrar tu me gusta', description: toUserMessage(err), variant: 'destructive' });
    },
  });

  /* ── hilos: arrancar una respuesta (expande el hilo y enfoca el composer) y
     colapsar/expandir; responder una respuesta también cuelga de la RAÍZ ── */
  const startReply = (id: string, name: string) => {
    setReplyTo({ id, name });
    setExpandedThreads((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    composerInputRef.current?.focus();
  };

  const toggleThread = (id: string) => {
    setExpandedThreads((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const comments = commentsQuery.data?.pages.flatMap((p) => p.items) ?? [];
  const { roots: commentRoots, repliesOf } = buildThreads(comments);
  const total = commentsQuery.data?.pages[0]?.pagination.total ?? song.commentsCount;

  /* Deep-link ?comment=<id> (denuncias del backoffice): expande el hilo si es respuesta, scrollea
     hasta el comentario y lo resalta un rato. Los setState van en timers (nada síncrono en el efecto). */
  const highlightCommentId = useRoute().query.get('comment');
  const [highlightedCommentId, setHighlightedCommentId] = useState<string | null>(null);
  const highlightDoneRef = useRef<string | null>(null);
  useEffect(() => {
    if (!highlightCommentId || comments.length === 0 || highlightDoneRef.current === highlightCommentId) return;
    const target = comments.find((c) => c.id === highlightCommentId);
    if (!target) return;
    highlightDoneRef.current = highlightCommentId;
    if (target.parentId) {
      window.setTimeout(() => {
        setExpandedThreads((prev) => new Set(prev).add(target.parentId as string));
      }, 80);
    }
    window.setTimeout(() => {
      setHighlightedCommentId(highlightCommentId);
      document.getElementById(`comment-${highlightCommentId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 350);
    window.setTimeout(() => setHighlightedCommentId(null), 6000);
  }, [highlightCommentId, comments]);

  return (
    <section className="space-y-4" aria-label="Comentarios de la comunidad">
      <SectionHeader
        title="Comentarios"
        subtitle={
          total > 0
            ? `${formatNumber(total)} ${total === 1 ? 'comentario' : 'comentarios'} de la comunidad`
            : canModerate ? 'Lo que dice la comunidad sobre tu canción' : 'Lo que dice la comunidad'
        }
        action={action}
      />
      <Card className="rounded-cover border-border/70 bg-surface">
        <CardContent className="space-y-5">
          {song.allowComments && !currentUserId ? (
            <p className="rounded-xl bg-surface-2 px-4 py-3 text-sm text-muted-foreground">
              <Link to="/login" className="font-medium text-amber-strong underline-offset-4 transition-colors hover:underline">
                Ingresá para comentar
              </Link>{' '}
              y sumate a la charla.
            </p>
          ) : song.allowComments ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                // Un envío por vez (botón o Enter): mientras se valida no se manda otro igual.
                if (!canSubmitComment(draft, addMutation.isPending)) return;
                addMutation.mutate({ content: draft.trim(), parentId: replyTo?.id });
              }}
              className="space-y-2"
              aria-busy={addMutation.isPending}
            >
              {replyTo && (
                <div className="flex items-center justify-between gap-2 self-start rounded-full border border-amber/40 bg-amber/10 px-3 py-1 text-xs text-amber-strong">
                  <span className="truncate">Respondiendo a {replyTo.name}</span>
                  <button
                    type="button"
                    onClick={() => setReplyTo(null)}
                    aria-label="Cancelar la respuesta"
                    className="shrink-0 rounded-full p-0.5 transition-colors hover:bg-amber/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </div>
              )}
              <div className="flex gap-2">
                <Input
                  ref={composerInputRef}
                  value={draft}
                  onChange={(e) => { setDraft(e.target.value); if (rejection) setRejection(null); }}
                  readOnly={addMutation.isPending}
                  placeholder="Dejá un comentario…"
                  maxLength={1000}
                  aria-label="Nuevo comentario"
                  aria-invalid={rejection !== null}
                  aria-describedby={rejection !== null ? 'comment-rejection' : undefined}
                  className="h-11 rounded-full border-[1.5px] border-line bg-[var(--m-input)] px-4 text-sm transition-colors hover:border-foreground focus-visible:border-foreground focus-visible:ring-4 focus-visible:ring-[var(--m-focus-ring)]"
                />
                <Button
                  type="submit"
                  size="icon"
                  className="rounded-full"
                  disabled={!canSubmitComment(draft, addMutation.isPending)}
                  aria-label={replyTo ? 'Enviar respuesta' : 'Enviar comentario'}
                >
                  {addMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
                </Button>
              </div>
              {rejection !== null && (
                <p id="comment-rejection" role="alert" className="px-1 text-xs text-destructive">
                  {rejection}
                </p>
              )}
              {checking && addMutation.isPending && (
                <p role="status" aria-live="polite" className="px-1 text-xs text-muted-foreground">
                  Revisando tu comentario…
                </p>
              )}
            </form>
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">Los comentarios están desactivados para esta canción.</p>
          )}

          {commentsQuery.isLoading ? (
            <LoadingRows count={2} />
          ) : commentsQuery.isError ? (
            <ErrorState message={toUserMessage(commentsQuery.error)} onRetry={() => void commentsQuery.refetch()} />
          ) : comments.length === 0 ? (
            song.allowComments ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {canModerate ? 'Todavía no hay comentarios. Publicala en el feed y dejá el primero.' : 'Todavía no hay comentarios. ¡Dejá el primero!'}
              </p>
            ) : null
          ) : (
            <ul className="space-y-5">
              {commentRoots.map((c) => {
                const replies = repliesOf.get(c.id) ?? [];
                /* repliesCount del server puede ser mayor si la paginación todavía no trajo todas las respuestas del hilo */
                const repliesTotal = Math.max(replies.length, c.repliesCount ?? 0);
                const expanded = expandedThreads.has(c.id);
                /* hilos largos: 2 respuestas visibles + "Ver N respuestas" */
                const visibleReplies = replies.length > 3 && !expanded ? replies.slice(0, 2) : replies;
                const canDelete = c.author.id === currentUserId || canModerate;
                /* v0.18.0 — flag de denuncia en comentarios ajenos (convive con el delete de propios) */
                const canReport = Boolean(currentUserId) && c.author.id !== currentUserId;
                return (
                  <li
                    key={c.id}
                    id={`comment-${c.id}`}
                    className={cn('group flex gap-3', highlightedCommentId === c.id && '-mx-2 rounded-xl bg-amber/10 px-2 py-1 ring-1 ring-amber/40')}
                  >
                    <AuthAvatar src={c.author.avatarUrl} name={c.author.name} className="h-9 w-9" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="truncate text-sm font-semibold">{c.author.name}</span>
                        <span className="text-xs text-muted-foreground">{formatRelative(c.createdAt)}</span>
                        {repliesTotal > 0 && (
                          <span className="text-xs text-muted-foreground">
                            · {formatNumber(repliesTotal)} {repliesTotal === 1 ? 'respuesta' : 'respuestas'}
                          </span>
                        )}
                        {canDelete && (
                          <button
                            type="button"
                            onClick={() => removeMutation.mutate(c.id)}
                            disabled={removeMutation.isPending}
                            className="ml-auto flex size-7 shrink-0 items-center justify-center rounded-full border-[1.5px] border-line text-muted-foreground transition-colors hover:border-destructive hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label={`Eliminar comentario de ${c.author.name}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden />
                          </button>
                        )}
                        {canReport && (
                          <button
                            type="button"
                            onClick={() => onReportComment(c)}
                            aria-label="Denunciar comentario"
                            title="Denunciar comentario"
                            className={cn(
                              'rounded-md p-1 text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                              !canDelete && 'ml-auto',
                              'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-sm:opacity-100'
                            )}
                          >
                            <Flag className="h-3.5 w-3.5" aria-hidden />
                          </button>
                        )}
                      </div>
                      <p className="mt-0.5 whitespace-pre-line text-sm leading-relaxed text-foreground/90">{c.content}</p>
                      <div className="mt-1 flex items-center gap-3">
                        {currentUserId && (
                          <button
                            type="button"
                            onClick={() => likeMutation.mutate(c.id)}
                            aria-pressed={c.viewerLiked}
                            aria-label={
                              c.viewerLiked
                                ? `Quitar me gusta del comentario de ${c.author.name}`
                                : `Me gusta comentario de ${c.author.name}`
                            }
                            className="inline-flex items-center gap-1 rounded-md text-xs text-muted-foreground transition-colors hover:text-coral focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <Heart
                              key={c.viewerLiked ? 'on' : 'off'}
                              className={cn('h-3.5 w-3.5', c.viewerLiked && 'fill-current text-coral heart-pop')}
                              aria-hidden
                            />
                            {(c.likesCount ?? 0) > 0 && <span className="tabular-nums">{formatNumber(c.likesCount ?? 0)}</span>}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => startReply(c.id, c.author.name)}
                          aria-label={`Responder a ${c.author.name}`}
                          className="rounded-md text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          Responder
                        </button>
                      </div>

                      {replies.length > 0 && (
                        <div className="ml-6 mt-3 space-y-4 border-l border-border/70 pl-3">
                          {replies.length > 3 && (
                            <button
                              type="button"
                              onClick={() => toggleThread(c.id)}
                              aria-expanded={expanded}
                              className="inline-flex items-center gap-1 rounded-md text-xs font-medium text-amber-strong transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              {expanded ? (
                                <>
                                  <ChevronUp className="h-3.5 w-3.5" aria-hidden />
                                  Ocultar respuestas
                                </>
                              ) : (
                                <>
                                  <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                                  Ver {formatNumber(repliesTotal)} {repliesTotal === 1 ? 'respuesta' : 'respuestas'}
                                </>
                              )}
                            </button>
                          )}
                          {visibleReplies.map((r) => {
                            const canDeleteReply = r.author.id === currentUserId || canModerate;
                            const canReportReply = Boolean(currentUserId) && r.author.id !== currentUserId;
                            return (
                              <div
                                key={r.id}
                                id={`comment-${r.id}`}
                                className={cn('group flex gap-2', highlightedCommentId === r.id && '-mx-2 rounded-xl bg-amber/10 px-2 py-1 ring-1 ring-amber/40')}
                              >
                                <AuthAvatar src={r.author.avatarUrl} name={r.author.name} className="h-7 w-7" />
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                    <span className="truncate text-sm font-semibold">{r.author.name}</span>
                                    <span className="text-xs text-muted-foreground">{formatRelative(r.createdAt)}</span>
                                    {canDeleteReply && (
                                      <button
                                        type="button"
                                        onClick={() => removeMutation.mutate(r.id)}
                                        disabled={removeMutation.isPending}
                                        className="ml-auto flex size-7 shrink-0 items-center justify-center rounded-full border-[1.5px] border-line text-muted-foreground transition-colors hover:border-destructive hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                        aria-label={`Eliminar comentario de ${r.author.name}`}
                                      >
                                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                                      </button>
                                    )}
                                    {canReportReply && (
                                      <button
                                        type="button"
                                        onClick={() => onReportComment(r)}
                                        aria-label="Denunciar comentario"
                                        title="Denunciar comentario"
                                        className={cn(
                                          'rounded-md p-1 text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                          !canDeleteReply && 'ml-auto',
                                          'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-sm:opacity-100'
                                        )}
                                      >
                                        <Flag className="h-3 w-3" aria-hidden />
                                      </button>
                                    )}
                                  </div>
                                  {r.parentAuthor && r.parentAuthor.name !== c.author.name && (
                                    <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                                      <CornerDownRight className="h-3 w-3 shrink-0" aria-hidden />
                                      <span className="truncate">
                                        respondiendo a <span className="font-medium text-foreground/80">{r.parentAuthor.name}</span>
                                      </span>
                                    </p>
                                  )}
                                  <p className="mt-0.5 whitespace-pre-line text-sm leading-relaxed text-foreground/90">{r.content}</p>
                                  <div className="mt-1 flex items-center gap-3">
                                    {currentUserId && (
                                      <button
                                        type="button"
                                        onClick={() => likeMutation.mutate(r.id)}
                                        aria-pressed={r.viewerLiked}
                                        aria-label={
                                          r.viewerLiked
                                            ? `Quitar me gusta del comentario de ${r.author.name}`
                                            : `Me gusta comentario de ${r.author.name}`
                                        }
                                        className="inline-flex items-center gap-1 rounded-md text-xs text-muted-foreground transition-colors hover:text-coral focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                      >
                                        <Heart
                                          key={r.viewerLiked ? 'on' : 'off'}
                                          className={cn('h-3 w-3', r.viewerLiked && 'fill-current text-coral heart-pop')}
                                          aria-hidden
                                        />
                                        {(r.likesCount ?? 0) > 0 && <span className="tabular-nums">{formatNumber(r.likesCount ?? 0)}</span>}
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      onClick={() => startReply(c.id, c.author.name)}
                                      aria-label={`Responder a ${c.author.name}`}
                                      className="rounded-md text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    >
                                      Responder
                                    </button>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
              {commentsQuery.hasNextPage && (
                <li className="pt-1 text-center">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="rounded-full"
                    disabled={commentsQuery.isFetchingNextPage}
                    onClick={() => void commentsQuery.fetchNextPage()}
                  >
                    {commentsQuery.isFetchingNextPage && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                    Ver más comentarios
                  </Button>
                </li>
              )}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

/* ══════════════ Vista principal ══════════════ */
export function SongDetailView({ songId }: { songId: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const play = usePlayerStore((s) => s.play);
  const toggle = usePlayerStore((s) => s.toggle);
  const currentTrack = usePlayerStore((s) => s.track);
  const isPlaying = usePlayerStore((s) => s.isPlaying);

  /* ── datos (queries reales) ── */
  /* Una sola pantalla para canciones propias y de la comunidad: con sesión se pide el detalle propio
   * (dueño/admin o PUBLIC); si no aplica (invitado, o falla) se arma desde el detalle público. */
  const songQuery = useQuery({
    queryKey: ['song', songId, user?.id ?? null],
    queryFn: async () => {
      if (user) {
        try {
          return await songsApi.get(songId);
        } catch (err) {
          /* Solo «no es tuya / no existe para vos» (404/403) cae al detalle público; un corte de red o un 5xx se muestran tal cual.
           * Una canción propia en la Papelera NO llega acá: el backend se la entrega al dueño (con deletedAt). */
          if (!shouldFallbackToCommunity(err)) throw err;
        }
      }
      return songFromCommunity(await communityApi.song(songId));
    },
  });
  const song = songQuery.data ?? null;
  const isOwner = Boolean(song && user && (user.id === song.userId || user.role === 'ADMIN'));
  /* Papelera: mismo detalle, solo lectura. Qué se ofrece y qué se pide a Comunidad sale de un único lugar (trashed-song.ts). */
  const access = songDetailAccess(song, isOwner);
  const isTrashed = access.trashed;
  /* El detalle propio no trae tu reacción, ni el autor: para canciones públicas se toman del detalle de comunidad. */
  const communityQuery = useQuery({
    queryKey: ['community', 'song', songId],
    queryFn: () => communityApi.song(songId),
    enabled: access.fetchCommunity,
    staleTime: 60_000,
  });
  /* En la Papelera no se usa nada de Comunidad (ni lo que haya quedado en caché de antes). */
  const community = access.showCommunity ? (communityQuery.data ?? null) : null;
  const viewerLiked = community?.viewerReaction === 'LIKE';
  const viewerDisliked = community?.viewerReaction === 'DISLIKE';
  const likesCount = community?.likesCount ?? song?.likesCount ?? 0;
  const dislikesCount = community?.dislikesCount ?? song?.dislikesCount ?? 0;
  /* Más del autor / más del género: 4 canciones de la comunidad, sin contar esta. Se pide una de más para poder descartarla. */
  const primaryGenre = (community?.genre ?? '').split(',')[0]?.trim() || null;
  const authorMoreQuery = useQuery({
    queryKey: ['community', 'song', songId, 'more-author', community?.author.id],
    queryFn: () => communityApi.feed({ authorId: community!.author.id, sort: 'newest', limit: 5 }),
    enabled: Boolean(community),
    staleTime: 60_000,
  });
  const genreMoreQuery = useQuery({
    queryKey: ['community', 'song', songId, 'more-genre', primaryGenre],
    queryFn: () => communityApi.feed({ genre: primaryGenre!, sort: 'most_liked', limit: 5 }),
    enabled: Boolean(community && primaryGenre),
    staleTime: 60_000,
  });
  /* Remixes directos de esta canción (públicos y visibles para quien mira): solo se piden si el contador del backend dice que hay. */
  const remixesQuery = useQuery({
    queryKey: ['community', 'song', songId, 'remixes'],
    queryFn: () => communityApi.feed({ remixOf: songId, sort: 'newest', limit: 4 }),
    enabled: Boolean(community) && (song?.remixCount ?? 0) > 0,
    staleTime: 60_000,
  });
  const remixes = remixesQuery.data?.items ?? [];
  const authorMore = (authorMoreQuery.data?.items ?? []).filter((s) => s.id !== songId).slice(0, 4);
  const genreMore = (genreMoreQuery.data?.items ?? []).filter((s) => s.id !== songId).slice(0, 4);
  const reactMutation = useCommunityReaction();
  const playNextInQueue = usePlayerStore((s) => s.playNext);
  const addToPlayerQueue = usePlayerStore((s) => s.addToQueue);
  const currentVersion = song?.currentVersion ?? null;

  /* Si la canción se envió a la Papelera desde otro lugar y su pista sigue en la cola o en la sesión, se marca al abrir el detalle (sin consultas). */
  useEffect(() => {
    if (isTrashed) usePlayerStore.getState().setTrackTrashed(songId, true);
  }, [isTrashed, songId]);

  /* Título de la pestaña con el nombre real de la canción */
  useEffect(() => {
    if (!song?.title) return;
    document.title = `${song.title} · Melodya`;
    return () => {
      document.title = 'Canción · Melodya';
    };
  }, [song?.title]);

  const versionsQuery = useQuery({
    queryKey: ['song', songId, 'versions'],
    queryFn: () => songsApi.versions(songId),
    enabled: isOwner,
    // Mientras alguna versión tenga su WAV en preparación se vuelve a consultar el listado (el backend lo convierte una vez pedido).
    refetchInterval: (query) => (hasWavInProgress(query.state.data?.items) ? queryPollDelayMs(query, 8000) : false),
  });

  /* La versión vigente ya trae su generationId: se pide el detalle directo (sin pasar por el listado de 50).
   * El listado queda solo como respaldo para versiones sin generationId. */
  const versionGenId = currentVersion?.generationId ?? null;
  const generationQuery = useQuery({
    queryKey: ['song', songId, 'generations'],
    queryFn: async () => {
      const res = await generationApi.list({ pageSize: 50 });
      return res.items.filter((g) => g.songId === songId) as Array<Generation & { providerModelId?: string | null }>;
    },
    enabled: isOwner && Boolean(song) && !versionGenId,
    staleTime: 60_000,
  });

  const songGens = generationQuery.data ?? [];
  /* Estilos: la generación que creó la versión vigente; si no, la más reciente con inputs de estilo
   * (la más reciente a secas puede ser una generación de portada, sin estilos). */
  const hasStyle = (g: Generation) => g.inputs?.some((i) => i.field === 'GENRE' || i.field === 'STYLE_DESCRIPTION') ?? false;
  const styleGenId = versionGenId ?? songGens.find(hasStyle)?.id ?? null;
  /* El listado de generaciones trae los inputs sin valor (solo field/source): el contenido está en el detalle. */
  const styleDetailQuery = useQuery({
    queryKey: ['generation', styleGenId],
    queryFn: () => generationApi.get(styleGenId!),
    enabled: isOwner && Boolean(styleGenId),
    staleTime: 5 * 60_000,
  });
  const gen = (styleDetailQuery.data ?? songGens[0] ?? null) as (Generation & { providerModelId?: string | null }) | null;

  /* Proyectos propios (para "Agregar a proyecto" — solo dueño) */
  const projectsQuery = useQuery({
    queryKey: ['projects', 'song-detail'],
    queryFn: () => projectsApi.list({ pageSize: 50 }),
    enabled: isOwner,
    staleTime: 60_000,
  });

  /* ── estado local ── */
  const [detailsOpen, setDetailsOpen] = useState(false); // «Editar detalles de la canción» (nombre, portada, resumen de estilos, descripción)
  const [coverPending, setCoverPending] = useState(false);

  /* v0.18.0 — denuncia de comentarios ajenos (un solo dialog para la vista) */
  const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null);
  const onReportComment = (comment: SongComment) => {
    if (!user) {
      toast({ title: 'Ingresá para denunciar contenido', description: 'Creá tu cuenta para ayudarnos a cuidar la comunidad.' });
      navigate('/login');
      return;
    }
    setReportTarget({ type: 'COMMENT', id: comment.id, title: `el comentario de ${comment.author.name}` });
  };

  /* Invitado: toast + derivar a /login. Devuelve true si hay sesión. */
  const guard = (title: string, description?: string): boolean => {
    if (user) return true;
    toast({ title, description });
    navigate('/login');
    return false;
  };
  const REPORT_GUARD: [string, string] = ['Ingresá para denunciar contenido', 'Creá tu cuenta para ayudarnos a cuidar la comunidad.'];
  const onReportSong = () => {
    if (!song || !guard(...REPORT_GUARD)) return;
    setReportTarget({ type: 'SONG', id: song.id, title: `«${song.title}»` });
  };
  const onReportCard = (s: { id: string; title: string }) => {
    if (!guard(...REPORT_GUARD)) return;
    setReportTarget({ type: 'SONG', id: s.id, title: `«${s.title}»` });
  };
  const onReportAuthor = () => {
    if (!community || !guard(...REPORT_GUARD)) return;
    setReportTarget({ type: 'USER', id: community.author.id, title: `a ${community.author.name}` });
  };
  const onReact = (type: 'LIKE' | 'DISLIKE') => {
    if (!song || !guard('Ingresá para reaccionar', 'Creá tu cuenta gratis y dejá tu me gusta a otros melodiosos.')) return;
    reactMutation.mutate({ id: song.id, type });
  };

  /* ── follow / unfollow del autor (POST / DELETE /users/:id/follow) ── */
  const followMutation = useMutation({
    mutationFn: (vars: { userId: string; follow: boolean }) =>
      vars.follow ? profileApi.follow(vars.userId) : profileApi.unfollow(vars.userId),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: ['community', 'song', songId] });
      qc.setQueryData<CommunitySongDetail>(['community', 'song', songId], (old) =>
        old && old.author.id === vars.userId ? { ...old, viewerIsFollowing: vars.follow } : old
      );
    },
    onError: (err) => {
      toast({ title: 'No pudimos actualizar a quién seguís', description: toUserMessage(err), variant: 'destructive' });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['community', 'song', songId] });
    },
  });

  /* Diálogo "Cambiar portada": subir imagen propia o generar con Melodya */
  const [coverDialogOpen, setCoverDialogOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [coverPrompt, setCoverPrompt] = useState('');
  const [coverStyle, setCoverStyle] = useState('');
  const coverInputRef = useRef<HTMLInputElement>(null);

  /* Diálogo "Agregar a proyecto" */
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  /* ── mutaciones (APIs reales) ── */
  const invalidateSong = async () => {
    await qc.invalidateQueries({ queryKey: ['song', songId] });
    void qc.invalidateQueries({ queryKey: ['songs'] });
    // Las generaciones embeben song.title (y currentVersionId): si el usuario
    // renombró la canción, el home ("Seguí creando") y el perfil tienen que
    // refrescar el título nuevo, no la foto vieja del cache.
    void qc.invalidateQueries({ queryKey: ['generations'] });
  };

  const visibilityMutation = useMutation({
    mutationFn: (body: { visibility?: 'PUBLIC' | 'PRIVATE'; allowComments?: boolean; allowRemix?: boolean }) => songsApi.setVisibility(songId, body),
    onSuccess: async (_res, vars) => {
      await invalidateSong();
      if (vars.allowRemix !== undefined && vars.allowComments === undefined && !vars.visibility) {
        toast({ title: vars.allowRemix ? 'Remixes permitidos' : 'Remixes desactivados', description: vars.allowRemix ? undefined : 'Los remixes que ya existen se conservan.' });
      } else if (!vars.visibility) {
        toast({ title: vars.allowComments ? 'Comentarios habilitados' : 'Comentarios deshabilitados' });
      } else {
        toast({ title: vars.visibility === 'PUBLIC' ? '¡Tu canción está en la comunidad! 🎉' : 'Canción retirada de la comunidad' });
      }
    },
    onError: (err) => toast({ title: 'No pudimos actualizar la configuración', description: toUserMessage(err), variant: 'destructive' }),
  });

  const activeVersionMutation = useMutation({
    mutationFn: (versionId: string) => songsApi.update(songId, { currentVersionId: versionId }),
    onSuccess: async () => {
      await invalidateSong();
      toast({ title: 'Versión activa actualizada' });
    },
    onError: (err) => toast({ title: 'No pudimos cambiar la versión activa', description: toUserMessage(err), variant: 'destructive' }),
  });

  const deleteMutation = useMutation({
    mutationFn: () => songsApi.remove(songId),
    onSuccess: () => {
      usePlayerStore.getState().setTrackTrashed(songId, true); // si estaba en la cola o sonando, sigue oyéndose sin contar ni compartir
      toast({ title: 'Canción enviada a la Papelera', description: 'La restaurás desde Biblioteca › Papelera.' });
      void qc.invalidateQueries({ queryKey: ['songs'] });
      navigate('/library/songs');
    },
    onError: (err) => toast({ title: 'No pudimos eliminar la canción', description: toUserMessage(err), variant: 'destructive' }),
  });

  /* Restaurar desde el detalle (POST /songs/:id/restore, idempotente): refresca detalle, Biblioteca, Papelera y Comunidad. */
  const restoreMutation = useMutation({
    mutationFn: () => songsApi.restore(songId),
    onSuccess: async () => {
      usePlayerStore.getState().setTrackTrashed(songId, false);
      await Promise.all(restoreInvalidationKeys(songId).map((key) => qc.invalidateQueries({ queryKey: [...key] })));
      toast({ title: 'Canción restaurada', description: 'Vuelve a tu biblioteca tal como estaba.' });
    },
    onError: (err) => toast({ title: 'No pudimos restaurar la canción', description: toUserMessage(err), variant: 'destructive' }),
  });

  /* Subir portada propia (POST /songs/:id/cover — BACKEND GAP en el backend real) */
  const uploadCoverMutation = useMutation({
    mutationFn: (file: File) => songsApi.uploadCover(songId, file),
    onSuccess: async () => {
      await invalidateSong();
      toast({ title: 'Portada actualizada' });
      setCoverDialogOpen(false);
      setCoverFile(null);
    },
    onError: (err) => toast({ title: 'No pudimos subir la portada', description: toUserMessage(err), variant: 'destructive' }),
  });

  /* Mover / quitar del proyecto (PATCH /songs/:id con projectId) */
  const moveToProjectMutation = useMutation({
    mutationFn: (projectId: string | null) => songsApi.update(songId, { projectId }),
    onSuccess: async (_res, projectId) => {
      await invalidateSong();
      void qc.invalidateQueries({ queryKey: ['projects'] });
      void qc.invalidateQueries({ queryKey: ['project-songs'] });
      if (projectId) {
        const name = (projectsQuery.data?.items ?? []).find((p) => p.id === projectId)?.name;
        toast({ title: name ? `Canción movida a ${name}` : 'Canción movida al proyecto' });
      } else {
        toast({ title: 'Canción quitada del proyecto' });
      }
      setProjectDialogOpen(false);
    },
    onError: (err) => toast({ title: 'No pudimos actualizar el proyecto de la canción', description: toUserMessage(err), variant: 'destructive' }),
  });

  /* ── handlers ── */
  const onBack = () => {
    if (typeof window !== 'undefined' && window.history.length > 1) goBack();
    else navigate(isOwner ? '/library/songs' : '/community');
  };

  /* ── compartir: diálogo nativo (Web Share API) con fallback a portapapeles ── */
  const [sharePending, setSharePending] = useState(false);
  const onShare = async () => {
    if (!song || sharePending) return;
    setSharePending(true);
    try {
      const url = songUrl(song.id);
      const outcome = await shareContent({
        title: song.title,
        text: `Escuchá "${song.title}" en Melodya`,
        url,
      });
      if (outcome === 'shared') return; // diálogo nativo: nada más que hacer
      if (outcome === 'copied') {
        toast({ title: 'Link copiado 🔗', description: 'Pegalo donde quieras compartir tu canción.' });
      } else {
        window.history.replaceState(window.history.state, '', songPath(song.id));
        toast({ title: 'Link en la barra de direcciones', description: 'Copialo desde ahí para compartirlo.' });
      }
    } finally {
      setSharePending(false);
    }
  };

  /* ── copiar letra ── */
  const onCopyLyrics = async () => {
    if (!currentVersion?.lyricsText) return;
    try {
      await navigator.clipboard.writeText(currentVersion.lyricsText);
      toast({ title: 'Letra copiada 📋' });
    } catch {
      toast({ title: 'No pudimos copiar la letra', variant: 'destructive' });
    }
  };

  /* ── copiar estilo: géneros + descripción, listo para pegar en el campo Estilo del creador ── */
  const onCopyStyle = async () => {
    const text = [usedStyle.genres.join(', '), usedStyle.description].filter(Boolean).join('\n\n');
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: 'Estilo copiado 📋' });
    } catch {
      toast({ title: 'No pudimos copiar el estilo', variant: 'destructive' });
    }
  };

  /* ── descargar audio (fetch autenticado → blob → descarga) ── */
  const [downloading, setDownloading] = useState(false);
  const downloadState = useDownloadState(); // E6: capacidad y cupo de descargas
  const coverGate = usePlanGate('COVER_ART'); // E5: generar portadas; subir una propia no depende del plan
  const coverArtLocked = coverGate.locked;
  // Capacidad no incluida (aviso de upgrade) ≠ cupo agotado (límite del período): el cupo conserva su mensaje propio.
  const downloadGate = usePlanGate('DOWNLOAD_AUDIO');
  const entitlements = useEntitlements();
  const wavGate = usePlanGate('DOWNLOAD_WAV');
  // WAV bajo demanda como una sola experiencia: pedir → esperar → descargar la versión elegida (lib/wav-flow; el seguimiento es el listado de versiones).
  const wavFlow = useWavFlow({ songId, versions: versionsQuery.data?.items, dataUpdatedAt: versionsQuery.dataUpdatedAt });
  const wavFor = (versionId: string | undefined) => (versionId ? versionsQuery.data?.items.find((v) => v.id === versionId)?.wav : undefined);
  const wavStateFor = (versionId: string | undefined) => wavMenuState(entitlements, wavFor(versionId), downloadState, wavFlow.phaseOf(versionId));
  const wavSeen = useRef(new Map<string, string>());
  useEffect(() => {
    const items = versionsQuery.data?.items;
    if (!items) return;
    // El aviso «ya está listo» es solo para los WAV que NO pidió el usuario en esta pantalla: los que sí, se descargan solos.
    for (const v of newlyReadyWavs(wavSeen.current, items)) if (!wavFlow.phaseOf(v.id)) toast({ title: `El WAV de la versión ${v.versionNumber} ya está listo`, description: 'Podés descargarlo desde el menú de la canción.' });
    wavSeen.current = new Map(items.map((v) => [v.id, v.wav?.status ?? 'NONE']));
  }, [versionsQuery.data, toast]);

  /* WAV de UNA versión. Listo → se descarga; en preparación → se espera la existente; nunca pedido o fallido → se pide y se descarga solo al terminar. */
  const onWav = (version: { id: string; versionNumber: number }) => {
    const st = wavStateFor(version.id);
    if (st.kind === 'locked') {
      wavGate.prompt();
      return;
    }
    if (st.disabled || !song) return; // preparando / descargando / cupo agotado / estado sin cargar: nada que hacer (evita el doble clic)
    wavFlow.request({ songId: song.id, versionId: version.id, versionNumber: version.versionNumber, title: song.title, wav: wavFor(version.id) });
  };

  const onDownload = async (format: DownloadFormat = 'mp3', version: { id: string } | null = currentVersion) => {
    if (downloadGate.locked) {
      downloadGate.prompt();
      return;
    }
    if (!version || downloading || !downloadState.allowed) return;
    setDownloading(true);
    try {
      /* E6: la descarga explícita usa su propio endpoint (cuenta contra el cupo). La reproducción sigue usando audioUrl. */
      await downloadSongAudio({ songId: song!.id, versionId: version.id, title: song?.title, format });
      void qc.invalidateQueries({ queryKey: ['usage'] });
      toast({ title: 'Descarga iniciada 💾' });
    } catch (err) {
      toast({ title: 'No pudimos descargar el audio', description: toUserMessage(err), variant: 'destructive' });
    } finally {
      setDownloading(false);
    }
  };

  const playVersion = (v: { audioUrl: string | null; durationSec?: number | null; lyricsText?: string | null }) => {
    const url = resolveAudioUrl(v.audioUrl);
    if (!song || !url) return;
    if (currentTrack?.audioUrl === url) {
      toggle();
      return;
    }
    play({
      id: song.id,
      title: song.title,
      artist: isOwner ? 'Vos' : (community?.author.name ?? 'Comunidad Melodya'),
      coverUrl: song.coverUrl,
      audioUrl: url,
      durationSec: v.durationSec ?? null,
      lyrics: v.lyricsText ?? null,
      isPublic: access.showCommunity,
      own: isOwner, // ExpandedPlayer solo habilita «Descargar» si la pista es propia (own !== false)
      trashed: isTrashed || undefined, // en la Papelera el reproductor no comparte ni descarga
      ...(access.showCommunity && community
        ? { community: { likesCount: community.likesCount, viewerReaction: community.viewerReaction ?? null, authorId: community.author.id } }
        : {}),
      // POST /songs/:id/play — registra reproducción de canciones públicas
      onPlayed:
        access.showCommunity
          ? () => {
              songsApi
                .registerPlay(song.id)
                .then(() => qc.invalidateQueries({ queryKey: ['song', songId] }))
                .catch(() => undefined);
            }
          : undefined,
    });
  };

  /* ── portada: elegir archivo propio (máx 5 MB, como el avatar del perfil) ── */
  const onCoverFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    e.target.value = ''; // permitir volver a elegir el mismo archivo
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast({ title: 'La imagen es demasiado grande', description: 'Elegí una imagen de hasta 5 MB.', variant: 'destructive' });
      return;
    }
    setCoverFile(file);
  };

  const onCoverDialogChange = (open: boolean) => {
    setCoverDialogOpen(open);
    if (!open) {
      setCoverFile(null);
      setCoverPrompt('');
      setCoverStyle('');
    }
  };

  /* ── portada: generar con Melodya (202, 0 fichas, prompt/style opcionales) ── */
  const onGenerateCover = async () => {
    if (coverGate.locked) {
      coverGate.prompt();
      return;
    }
    if (coverPending) return;
    setCoverPending(true);
    try {
      await generationApi.createCover({
        songId,
        prompt: coverPrompt.trim() || undefined,
        style: coverStyle.trim() || undefined,
        clientRequestId: uuid(),
      });
      toast({ title: 'Generando portada…', description: 'En segundos la ves acá. No gasta fichas.' });
      // reconciliación simple: 3 refetches cada 3s (el realtime también invalida al completar)
      [3, 6, 9].forEach((sec) => {
        window.setTimeout(() => {
          void qc.invalidateQueries({ queryKey: ['song', songId] });
        }, sec * 1000);
      });
      window.setTimeout(() => setCoverPending(false), 9500);
      setCoverDialogOpen(false);
    } catch (err) {
      setCoverPending(false);
      toast({ title: 'No pudimos generar la portada', description: toUserMessage(err), variant: 'destructive' });
    }
  };

  /* ── loading: esqueleto del hero ── */
  if (songQuery.isLoading) {
    return (
      <div className="view-in mx-auto w-full max-w-7xl space-y-8" aria-busy="true" aria-label="Cargando canción">
        <Skeleton className="h-8 w-28 rounded-full" />
        <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-end">
          <Skeleton className="h-40 w-40 rounded-cover sm:h-56 sm:w-56" />
          <div className="w-full flex-1 space-y-4">
            <Skeleton className="h-9 w-3/4" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <div className="flex flex-wrap gap-2">
              <Skeleton className="h-11 w-40 rounded-full" />
              <Skeleton className="h-11 w-44 rounded-full" />
            </div>
          </div>
        </div>
        <div className="grid gap-6 lg:grid-cols-3">
          <Skeleton className="h-72 rounded-cover lg:col-span-2" />
          <Skeleton className="h-48 rounded-cover" />
        </div>
      </div>
    );
  }

  /* ── error ── */
  if (songQuery.isError || !song) {
    return (
      <div className="view-in mx-auto w-full max-w-3xl space-y-6">
        <Button variant="ghost" size="sm" className="-ml-2 rounded-full text-muted-foreground" onClick={onBack} aria-label="Volver">
          <ChevronLeft className="h-4 w-4" aria-hidden /> Volver
        </Button>
        <ErrorState message={toUserMessage(songQuery.error, 'No pudimos cargar la canción.')} onRetry={() => void songQuery.refetch()} />
      </div>
    );
  }

  /* ── datos derivados ── */
  const genre = currentVersion?.genre ? cleanTag(currentVersion.genre) : null;
  const tags = (currentVersion?.tags ?? []).map(cleanTag).filter(Boolean);
  const styleSummary = customStyleSummary(song); // «Editar detalles»: null ⇒ se usan los estilos derivados (genre/tags)
  const isCurrentSongPlaying = Boolean(isPlaying && currentTrack?.id === song.id);
  const isCurrentVersionPlaying = Boolean(isPlaying && currentVersion?.audioUrl && currentTrack?.audioUrl === resolveAudioUrl(currentVersion.audioUrl));
  /* Dueño: estilos pedidos al generar. Resto: lo único público del detalle de comunidad (género + etiquetas). */
  const usedStyle = isOwner
    ? styleInputs(styleDetailQuery.data)
    : { genres: Array.from(new Set([...(genre?.split(',') ?? []), ...tags].map((t) => cleanTag(t.trim())).filter(Boolean))), description: null, vocal: null, excluded: [] as string[] };
  const versions = versionsQuery.data?.items ?? [];
  const projects: Project[] = projectsQuery.data?.items ?? [];
  const songProject = song.projectId ? (projects.find((p) => p.id === song.projectId) ?? null) : null;

  /* "Reproducir a continuación" / "Agregar a la cola" sobre la versión vigente */
  const onQueue = (mode: 'next' | 'end') => {
    const url = resolveAudioUrl(currentVersion?.audioUrl);
    if (!url) return;
    const t: PlayerTrack = {
      id: song.id,
      title: song.title,
      artist: isOwner ? 'Vos' : (community?.author.name ?? 'Comunidad Melodya'),
      coverUrl: song.coverUrl,
      audioUrl: url,
      durationSec: currentVersion?.durationSec ?? null,
      isPublic: true,
      own: isOwner,
      ...(community
        ? { community: { likesCount: community.likesCount, viewerReaction: community.viewerReaction ?? null, authorId: community.author.id } }
        : {}),
      onPlayed: () => {
        songsApi.registerPlay(song.id).catch(() => undefined);
      },
    };
    const ok = mode === 'next' ? playNextInQueue(t) : addToPlayerQueue(t);
    toast(
      ok
        ? { title: mode === 'next' ? 'Suena a continuación 🎧' : 'Agregada a la cola ➕', description: `"${t.title}"` }
        : { title: 'Ya está en la cola', description: `"${t.title}" ya estaba esperando su turno.` }
    );
  };

  return (
    <div className="view-in mx-auto w-full max-w-7xl space-y-8">
      <Button variant="ghost" size="sm" className="-ml-2 rounded-full text-muted-foreground hover:text-foreground" onClick={onBack} aria-label="Volver">
        <ChevronLeft className="h-4 w-4" aria-hidden /> Volver
      </Button>

      {/* ── Papelera: mismo detalle en solo lectura; se puede escuchar y restaurar ── */}
      {access.showTrashBanner && (
        <div role="status" data-testid="trash-banner" className="flex flex-wrap items-center gap-3 rounded-2xl border border-amber/40 bg-amber/10 px-4 py-3">
          <Trash2 className="h-5 w-5 shrink-0 text-amber-strong" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground">Esta canción está en la Papelera</p>
            <p className="text-xs text-muted-foreground">
              Podés escucharla y leer su letra, pero no editarla, compartirla ni descargarla. No se ve en la Comunidad hasta que la restaures.
              {song.deletedAt ? ` Enviada ${formatRelative(song.deletedAt)}.` : ''}
            </p>
          </div>
          <Button type="button" className="rounded-full" disabled={restoreMutation.isPending} onClick={() => restoreMutation.mutate()}>
            {restoreMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RotateCcw className="h-4 w-4" aria-hidden />}
            Restaurar
          </Button>
        </div>
      )}

      {/* ── Hero ── */}
      {/* Estilo de «Canción destacada» (Comunidad, design-V2 feed.html): portada ancha con esquinas 28/28/14/14 y una franja navy translúcida abajo con el texto */}
      <section className="relative" aria-label="Detalle de la canción">
        <div className="relative flex min-h-72 flex-col justify-end overflow-hidden rounded-[28px_28px_14px_14px] bg-surface sm:min-h-80 lg:min-h-96">
          <CoverArt
            id={song.id}
            src={song.coverUrl}
            alt={`Portada de ${song.title}`}
            rounded="rounded-none"
            className="absolute inset-0 h-full w-full"
          />
          {/* Menú de tres puntos arriba a la derecha: reúne todas las acciones de la canción (mismo estilo «list» que los de la Biblioteca) */}
          <div className="absolute top-3 right-3 z-10">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={wavFlow.phaseOf(currentVersion?.id) ? `Opciones de ${song.title} (preparando el WAV)` : `Opciones de ${song.title}`}
                  aria-busy={wavFlow.phaseOf(currentVersion?.id) ? true : undefined}
                  className="flex size-11 items-center justify-center rounded-full border-[1.5px] border-[#F3E5E2]/70 bg-[rgba(19,28,51,.88)] text-[#F3E5E2] shadow-[0_2px_10px_rgba(0,0,0,.35)] transition-colors hover:bg-[#F3E5E2] hover:text-[#131C33] focus-visible:outline-2 focus-visible:outline-[#F3E5E2]"
                >
                  {wavFlow.phaseOf(currentVersion?.id) ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> : <MoreVertical className="h-5 w-5" aria-hidden />}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" variant="list" className={LIST_MENU_COMFORTABLE_MOBILE}>
                {access.showTrashBanner && (
                  <DropdownMenuItem disabled={restoreMutation.isPending} onClick={() => restoreMutation.mutate()}>
                    <RotateCcw className="h-4 w-4" aria-hidden /> Restaurar
                  </DropdownMenuItem>
                )}
                {access.canModify && (
                  <DropdownMenuItem onClick={() => setDetailsOpen(true)} title="Nombre, portada, resumen de estilos y descripción">
                    <Pencil className="h-4 w-4" aria-hidden /> Editar detalles
                  </DropdownMenuItem>
                )}
                {access.canModify && (
                  <DropdownMenuItem
                    disabled={visibilityMutation.isPending}
                    onClick={() => visibilityMutation.mutate({ visibility: song.visibility === 'PUBLIC' ? 'PRIVATE' : 'PUBLIC' })}
                  >
                    {visibilityMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    ) : song.visibility === 'PUBLIC' ? (
                      <Lock className="h-4 w-4" aria-hidden />
                    ) : (
                      <Users className="h-4 w-4" aria-hidden />
                    )}
                    {song.visibility === 'PUBLIC' ? 'Quitar de comunidad' : 'Publicar en comunidad'}
                  </DropdownMenuItem>
                )}
                {access.canShare && (
                  <DropdownMenuItem disabled={sharePending} onClick={() => void onShare()}>
                    {sharePending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Share2 className="h-4 w-4" aria-hidden />}
                    Compartir
                  </DropdownMenuItem>
                )}
                {!isOwner && song.visibility === 'PUBLIC' && (
                  <>
                    <DropdownMenuItem onClick={onReportSong} className="text-destructive focus:text-destructive">
                      <Flag className="h-4 w-4" aria-hidden /> Denunciar canción
                    </DropdownMenuItem>
                    {community && (
                      <DropdownMenuItem onClick={onReportAuthor} className="text-destructive focus:text-destructive">
                        <Flag className="h-4 w-4" aria-hidden /> Denunciar a {community.author.name}
                      </DropdownMenuItem>
                    )}
                  </>
                )}
                {access.canDownload && currentVersion?.audioUrl && (
                  <DropdownMenuItem disabled={downloading || (!downloadState.allowed && !downloadGate.locked)} onClick={() => void onDownload('mp3')} title={downloadState.reason ?? downloadState.hint ?? 'Baja el MP3 de la versión activa'} className={downloadGate.locked ? 'opacity-90' : undefined}>
                    {downloading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}
                    Descargar MP3
                    <RequiredPlanBadge capability="DOWNLOAD_AUDIO" className="ml-auto" />
                  </DropdownMenuItem>
                )}
                {access.canDownload && currentVersion?.audioUrl && <WavMenuItem state={wavStateFor(currentVersion.id)} onSelect={() => onWav(currentVersion)} />}
                {!isTrashed && remixMenuState({ isOwner, signedIn: Boolean(user), visibility: song.visibility, allowRemix: song.allowRemix, hasAudio: Boolean(currentVersion?.audioUrl) }).visible && (
                  <RemixMenu songId={song.id} />
                )}
                {access.canModify && (
                  <>
                    <DropdownMenuItem onClick={() => setCoverDialogOpen(true)}>
                      <Palette className="h-4 w-4" aria-hidden /> Cambiar portada
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => navigate(`/create?song=${songId}`)} title="Crear una nueva versión desde el estudio">
                      <Sparkles className="h-4 w-4" aria-hidden /> Otra versión
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        setSelectedProjectId(song.projectId ?? null);
                        setProjectDialogOpen(true);
                      }}
                    >
                      <FolderOpen className="h-4 w-4" aria-hidden /> Agregar a proyecto
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={deleteMutation.isPending}
                      onClick={() => setDeleteOpen(true)}
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden /> Enviar a la Papelera
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        <div className="relative min-w-0 space-y-3 bg-[rgba(19,28,51,.72)] pt-5 pr-24 pb-[18px] pl-5 text-[#F3E5E2]">
          {/* Cápsula como la de «En comunidad» en las portadas de la Biblioteca: sale del borde izquierdo (compensa el padding de la franja), ícono en círculo de acento y fondo sólido bajo el tinte */}
          {access.showTrashBanner && (
            <span className="-ml-5 inline-flex items-center gap-1.5 rounded-full rounded-l-none bg-background py-0.5 pr-3 pl-1 text-xs font-bold text-foreground" title="Está en la Papelera">
              <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-full bg-faint text-foreground"><Trash2 className="h-3.5 w-3.5" /></span>
              En la Papelera
            </span>
          )}
          {access.canModify && (
            <span
              className="-ml-5 inline-flex items-center gap-1.5 rounded-full rounded-l-none bg-background bg-[image:linear-gradient(var(--m-capsule-tint),var(--m-capsule-tint))] py-0.5 pr-3 pl-1 text-xs font-bold text-foreground"
              title={song.visibility === 'PUBLIC' ? 'Publicada en la comunidad' : 'Solo la ves vos'}
            >
              <span aria-hidden className={cn('flex size-6 shrink-0 items-center justify-center rounded-full', song.visibility === 'PUBLIC' ? 'bg-primary text-primary-foreground' : 'bg-faint text-foreground')}>
                {song.visibility === 'PUBLIC' ? <Globe className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
              </span>
              {song.visibility === 'PUBLIC' ? 'En la comunidad' : 'Privada'}
            </span>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {isCurrentSongPlaying && <EqualizerBars className="h-4 shrink-0" />}
            <h1 className="min-w-0 break-words font-display text-[22px] leading-[1.1] font-bold sm:text-[28px]">{song.title}</h1>
          </div>

          {/* meta: en celular los chips y los datos van en dos filas; desde sm los datos quedan en la misma fila, en el extremo derecho */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-x-4">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {/* Resumen de estilos del dueño («Editar detalles»); sin resumen propio se conserva la presentación derivada de la versión (género + etiquetas). */}
            {styleSummary ? (
              <p className="min-w-0 break-words text-sm font-medium text-[#F3E5E2]">{styleSummary}</p>
            ) : (
              <>
                {genre && <Chip className="border-[#F3E5E2] bg-[#F3E5E2]/15 font-bold text-[#F3E5E2] hover:bg-[#F3E5E2]/25">{genre}</Chip>}
                {tags.map((t) => (
                  <Chip key={t} className="border-[#F3E5E2]/50 text-[#F3E5E2] hover:bg-white/10">{t}</Chip>
                ))}
              </>
            )}
          </div>

          {/* duración, versión y proyecto */}
          <div className="flex flex-wrap items-center gap-2 sm:-mr-[4.75rem] sm:shrink-0 sm:justify-end">
            {isOwner && currentVersion && (
              <span className="rounded-full bg-white/15 px-3 py-1 text-xs font-medium text-[#F3E5E2]">Versión v{currentVersion.versionNumber}</span>
            )}
            {currentVersion?.durationSec != null && (
              <span className="inline-flex items-center gap-1.5 text-sm text-[rgba(243,229,226,.85)]">
                <Clock className="h-3.5 w-3.5 text-gold" aria-hidden />
                {formatDuration(currentVersion.durationSec)}
              </span>
            )}
            {songProject && (
              <span className="inline-flex items-center gap-1.5 text-sm text-[rgba(243,229,226,.85)]" title={`Proyecto: ${songProject.name}`}>
                <FolderOpen className="h-3.5 w-3.5 text-gold" aria-hidden />
                {songProject.name}
              </span>
            )}
          </div>
          </div>

          {/* stats (solo si hay interacción o es pública) */}
          {(song.visibility === 'PUBLIC' || song.likesCount + song.playsCount + song.commentsCount + (song.remixCount ?? 0) > 0) && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-[rgba(243,229,226,.85)]">
              <span className="inline-flex items-center gap-1.5" title="Reproducciones" aria-label={`${song.playsCount} reproducciones`}>
                <Play className="h-3.5 w-3.5" aria-hidden />
                {formatNumber(song.playsCount)}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Heart className={cn('h-3.5 w-3.5', viewerLiked && 'fill-current text-[#FF8A70]')} aria-hidden />
                {formatNumber(likesCount)}
              </span>
              <span className="inline-flex items-center gap-1.5" title="No me gusta">
                <ThumbsDown className="h-3.5 w-3.5" aria-hidden />
                {formatNumber(dislikesCount)}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <MessageCircle className="h-3.5 w-3.5" aria-hidden />
                {formatNumber(song.commentsCount)}
              </span>
              {/* Remixes DIRECTOS visibles para ti (público, activo, con audio y sin bloqueos): el número lo calcula el backend (remixCount) */}
              {typeof song.remixCount === 'number' && (
                <span className="inline-flex items-center gap-1.5" title="Remixes" aria-label={`${song.remixCount} ${song.remixCount === 1 ? 'remix' : 'remixes'}`} data-testid="remix-count">
                  <RemixIcon className="h-3.5 w-3.5" aria-hidden />
                  {formatNumber(song.remixCount)}
                </span>
              )}
            </div>
          )}
        </div>
        </div>
        {/* Reproducir como en «Canción destacada»: círculo de 60 px colgando del borde inferior con un aro del color del fondo */}
        <button
          type="button"
          onClick={() => currentVersion && playVersion(currentVersion)}
          disabled={!currentVersion?.audioUrl}
          aria-label={isCurrentVersionPlaying ? 'Pausar' : 'Reproducir'}
          title={isCurrentVersionPlaying ? 'Pausar' : 'Reproducir'}
          className="absolute right-4 -bottom-3.5 z-10 flex size-[60px] cursor-pointer items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[0_0_0_5px_var(--background)] transition-transform active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground disabled:cursor-not-allowed disabled:bg-faint disabled:text-muted-foreground"
        >
          {isCurrentVersionPlaying ? <Pause className="h-[18px] w-[18px] fill-current" aria-hidden /> : <Play className="h-[18px] w-[18px] translate-x-px fill-current" aria-hidden />}
        </button>
      </section>

      {/* ── Remix: «Hecho a partir de» (atribución permanente al origen directo). El contador de remixes va con los demás contadores. ── */}
      <RemixAttribution origin={song.origin} />

      {/* ── Descripción de la canción («Editar detalles»): bloque discreto, solo si existe (también en el detalle público) ── */}
      {hasText(song.description) && (
        <section aria-label="Descripción de la canción">
          <p className="max-w-3xl whitespace-pre-line break-words rounded-2xl border border-border/70 bg-surface-2/40 px-4 py-3 text-sm leading-relaxed text-muted-foreground">
            {song.description.trim()}
          </p>
        </section>
      )}

      {/* ── Comunidad: autor (canciones ajenas) + reacciones y cola (canciones públicas) ── */}
      {access.showCommunity && (
        <section className="space-y-4" aria-label="Autor y reacciones">
          {!isOwner && community && (
            <div className="flex items-center gap-3">
              <Link
                to={`/user/${encodeURIComponent(community.author.id)}`}
                aria-label={`Ver perfil de ${community.author.name}`}
                tabIndex={-1}
                className="shrink-0 rounded-full bg-gold p-[2px] transition-transform duration-200 ease-out hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none motion-reduce:hover:scale-100"
              >
                <AuthAvatar src={community.author.avatarUrl} name={community.author.name} className="h-10 w-10 border-2 border-background" />
              </Link>
              <div className="min-w-0 flex-1">
                <Link
                  to={`/user/${encodeURIComponent(community.author.id)}`}
                  aria-label={`Ver perfil de ${community.author.name}`}
                  className="block max-w-full truncate text-left text-sm font-semibold text-foreground transition-colors hover:text-amber-strong"
                >
                  {community.author.name}
                </Link>
                <p className="text-xs text-muted-foreground">{formatNumber(community.author.followersCount ?? 0)} seguidores</p>
              </div>
              {user?.id !== community.author.id && (
                <Button
                  size="sm"
                  variant={community.viewerIsFollowing ? 'secondary' : 'default'}
                  className="rounded-full max-sm:size-9 max-sm:px-0"
                  aria-label={community.viewerIsFollowing ? `Dejar de seguir a ${community.author.name}` : `Seguir a ${community.author.name}`}
                  disabled={followMutation.isPending}
                  onClick={() => {
                    if (!guard('Ingresá para seguir al creador', 'Creá tu cuenta para seguir a otros melodiosos.')) return;
                    followMutation.mutate({ userId: community.author.id, follow: !community.viewerIsFollowing });
                  }}
                >
                  {followMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : community.viewerIsFollowing ? (
                    <UserCheck className="h-4 w-4" aria-hidden />
                  ) : (
                    <UserPlus className="h-4 w-4" aria-hidden />
                  )}
                  <span className="max-sm:sr-only">{community.viewerIsFollowing ? 'Siguiendo' : 'Seguir'}</span>
                </Button>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-pressed={viewerLiked}
              aria-label={viewerLiked ? `Quitar me gusta de ${song.title}` : `Me gusta ${song.title}`}
              onClick={() => onReact('LIKE')}
              className={cn('rounded-full', viewerLiked && 'border-amber/60 bg-amber/10 text-amber-strong hover:bg-amber/15 hover:text-amber-strong')}
            >
              <Heart key={viewerLiked ? 'on' : 'off'} className={cn('h-4 w-4', viewerLiked && 'fill-current heart-pop')} aria-hidden />
              <span className="tabular-nums">{formatNumber(likesCount)}</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-pressed={viewerDisliked}
              aria-label={viewerDisliked ? `Quitar no me gusta de ${song.title}` : `No me gusta ${song.title}`}
              onClick={() => onReact('DISLIKE')}
              className={cn('rounded-full', viewerDisliked && 'border-foreground/30 bg-surface-2 text-foreground')}
            >
              <ThumbsDown className={cn('h-4 w-4', viewerDisliked && 'fill-current')} aria-hidden />
              <span className="tabular-nums">{formatNumber(dislikesCount)}</span>
            </Button>
            {currentVersion?.audioUrl && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  title="Reproducir a continuación"
                  aria-label={`Reproducir ${song.title} a continuación`}
                  onClick={() => onQueue('next')}
                  className="rounded-full text-muted-foreground hover:text-foreground"
                >
                  <ListStart className="h-4 w-4" aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  title="Agregar a la cola"
                  aria-label={`Agregar ${song.title} a la cola`}
                  onClick={() => onQueue('end')}
                  className="rounded-full text-muted-foreground hover:text-foreground"
                >
                  <ListEnd className="h-4 w-4" aria-hidden />
                </Button>
              </>
            )}
          </div>
        </section>
      )}

      {/* Confirmación de borrado (se abre desde el menú de tres puntos) */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent className="rounded-[28px_28px_14px_14px]">
                <AlertDialogHeader>
                  <AlertDialogTitle className="font-display">¿Enviar «{song.title}» a la Papelera?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Va a la Papelera con sus versiones, la letra y la portada. Deja de verse en tu biblioteca y en la Comunidad; la restaurás desde Biblioteca › Papelera.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel className="rounded-full">Cancelar</AlertDialogCancel>
                  <AlertDialogAction
                    className="rounded-full bg-destructive text-background hover:bg-destructive/90"
                    onClick={(e) => {
                      e.preventDefault();
                      deleteMutation.mutate();
                    }}
                  >
                    {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Trash2 className="h-4 w-4" aria-hidden />}
                    Enviar a la Papelera
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
      </AlertDialog>

      {/* ── Letra + info de generación ── */}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="rounded-cover border-border/70 bg-surface lg:col-span-2">
          <CardHeader className="relative pb-0">
            <CardTitle className="flex items-center gap-2 font-display text-lg font-bold">
              <ListMusic className="h-5 w-5 text-amber-strong" aria-hidden /> Letra
            </CardTitle>
            {currentVersion?.lyricsSource && <CardDescription>{LYRICS_SOURCE_LABEL[currentVersion.lyricsSource] ?? ''}</CardDescription>}
            {currentVersion?.lyricsText && (
              <Button
                variant="ghost"
                size="sm"
                className="absolute right-4 top-4 h-8 gap-1.5 rounded-full px-3 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => void onCopyLyrics()}
              >
                <Copy className="h-3.5 w-3.5" aria-hidden /> Copiar
              </Button>
            )}
          </CardHeader>
          <CardContent>
            {currentVersion?.lyricsText ? (
              <LyricsBody text={currentVersion.lyricsText} />
            ) : (
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber/10 text-amber-strong">
                  <Music4 className="h-6 w-6" aria-hidden />
                </span>
                <p className="text-sm text-muted-foreground">Canción instrumental</p>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          {isOwner && (generationQuery.isLoading || styleDetailQuery.isLoading) ? (
            <Skeleton className="h-44 rounded-cover" />
          ) : gen || !isOwner ? (
            <>
            {/* Info de generación (costo, estado): solo para el dueño */}
            {isOwner && gen && (
            <Card className="h-fit rounded-cover border-border/70 bg-surface">
              <CardHeader className="pb-0">
                <CardTitle className="flex items-center gap-2 font-display text-lg font-bold">
                  <Sparkles className="h-5 w-5 text-amber-strong" aria-hidden /> Info de generación
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2.5 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Estado</span>
                  <Badge variant="outline" className="border-amber/40 text-amber-strong">
                    {GEN_STATUS_LABEL[gen.status] ?? gen.status}
                  </Badge>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Costo</span>
                  <span className="font-medium">{gen.creditsCost > 0 ? `Costó ${gen.creditsCost} fichas` : 'Sin costo'}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Generada</span>
                  <span className="font-medium">{formatRelative(gen.createdAt)}</span>
                </div>
              </CardContent>
            </Card>
            )}
            {(usedStyle.genres.length > 0 || usedStyle.description || usedStyle.vocal || usedStyle.excluded.length > 0) && (
              <Card className="h-fit rounded-cover border-border/70 bg-surface">
                <CardHeader className="relative pb-0">
                  <CardTitle className="flex items-center gap-2 font-display text-lg font-bold">
                    <Music4 className="h-5 w-5 text-amber-strong" aria-hidden /> Estilo
                  </CardTitle>
                  <CardDescription>Estilos usados</CardDescription>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="absolute right-4 top-4 h-8 gap-1.5 rounded-full px-3 text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => void onCopyStyle()}
                  >
                    <Copy className="h-3.5 w-3.5" aria-hidden /> Copiar
                  </Button>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  {(usedStyle.genres.length > 0 || usedStyle.vocal) && (
                    <div className="flex flex-wrap gap-1.5">
                      {usedStyle.genres.map((g) => (
                        <Chip key={g} active>{cleanTag(g)}</Chip>
                      ))}
                      {usedStyle.vocal && <Chip>{usedStyle.vocal}</Chip>}
                    </div>
                  )}
                  {usedStyle.description && <p className="whitespace-pre-line text-muted-foreground">{usedStyle.description}</p>}
                  {usedStyle.excluded.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-xs font-medium text-muted-foreground">Evitar</p>
                      <div className="flex flex-wrap gap-1.5">
                        {usedStyle.excluded.map((t) => (
                          <Chip key={t}>{cleanTag(t)}</Chip>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
            </>
          ) : isOwner && song.lastGenerationAt ? (
            <Card className="h-fit rounded-cover border-border/70 bg-surface">
              <CardContent className="flex items-center gap-3 text-sm text-muted-foreground">
                <Clock className="h-4 w-4 shrink-0 text-amber-strong" aria-hidden />
                Última generación {formatRelative(song.lastGenerationAt)}
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>

      {/* ── Versiones (dueño) ── */}
      {isOwner && (
        <section className="space-y-4" aria-label="Versiones de la canción">
          <SectionHeader
            title="Versiones"
            subtitle={versions.length > 0 ? `${versions.length} ${versions.length === 1 ? 'versión' : 'versiones'}` : undefined}
          />
          {/* Una cápsula por versión, como las de «Seguí creando» del inicio: pegadas al borde izquierdo, tinte terracota */}
          <div className="-ml-4 grid w-[calc(100%+1rem)] gap-3 sm:-ml-6 sm:w-[calc(100%+1.5rem)] lg:grid-cols-2">
              {versionsQuery.isLoading ? (
                <LoadingRows count={2} />
              ) : versionsQuery.isError ? (
                <ErrorState message={toUserMessage(versionsQuery.error)} onRetry={() => void versionsQuery.refetch()} />
              ) : versions.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">Todavía no hay versiones de esta canción.</p>
              ) : (
                versions.map((v) => {
                  const active = song.currentVersionId === v.id;
                  const playing = Boolean(isPlaying && v.audioUrl && currentTrack?.audioUrl === resolveAudioUrl(v.audioUrl));
                  return (
                    <div
                      key={v.id}
                      className="flex min-h-[76px] items-center gap-3.5 rounded-r-[40px] bg-[var(--m-capsule-tint)] py-3 pr-5 pl-6 sm:pl-8 lg:max-xl:pr-4 lg:max-xl:pl-6"
                    >
                      {/* Igual que el botón de las filas de «De la comunidad» del inicio: círculo con borde, solo el ícono */}
                      <button
                        type="button"
                        onClick={() => playVersion(v)}
                        disabled={!v.audioUrl}
                        aria-label={playing ? `Pausar versión ${v.versionNumber}` : `Escuchar versión ${v.versionNumber}`}
                        title={playing ? 'Pausar' : 'Escuchar'}
                        className={`flex size-11 shrink-0 items-center justify-center rounded-full border-[1.5px] transition-colors focus-visible:outline-2 focus-visible:outline-foreground disabled:cursor-not-allowed disabled:opacity-50 ${
                          playing ? 'border-primary bg-primary text-primary-foreground' : 'border-line text-foreground hover:border-[#A5390A] hover:bg-[#A5390A]/40'
                        }`}
                      >
                        {playing ? <Pause className="h-4 w-4 fill-current" aria-hidden /> : <Play className="h-4 w-4 translate-x-px fill-current" aria-hidden />}
                      </button>
                      <div className="min-w-0 flex-1">
                        <span className="text-sm font-semibold">Versión {v.versionNumber}</span>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {formatRelative(v.createdAt)}
                          {v.genre && <> · {cleanTag(v.genre)}</>}
                          {v.durationSec != null && <> · {formatDuration(v.durationSec)}</>}
                        </p>
                        {wavStatusText(wavFlow.phaseOf(v.id)) && (
                          <p role="status" aria-live="polite" data-testid="wav-status" className="mt-0.5 flex items-center gap-1.5 text-xs text-[#A5390A]">
                            <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> {wavStatusText(wavFlow.phaseOf(v.id))}
                          </p>
                        )}
                      </div>
                      {/* Descarga de ESTA versión (MP3 / WAV): corresponde a la fila elegida, no a la versión activa. */}
                      {v.audioUrl && access.canDownload && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              aria-label={wavFlow.phaseOf(v.id) ? `Versión ${v.versionNumber}: preparando el WAV` : `Descargar la versión ${v.versionNumber}`}
                              aria-busy={wavFlow.phaseOf(v.id) ? true : undefined}
                              title={wavFlow.phaseOf(v.id) ? 'Preparando el WAV de esta versión' : 'Descargar esta versión'}
                              className="flex size-9 shrink-0 items-center justify-center rounded-full border-[1.5px] border-line text-foreground transition-colors hover:border-[#A5390A] hover:bg-[#A5390A]/40 focus-visible:outline-2 focus-visible:outline-foreground"
                            >
                              {wavFlow.phaseOf(v.id) ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem disabled={downloading || (!downloadState.allowed && !downloadGate.locked)} onClick={() => void onDownload('mp3', v)} title={downloadState.reason ?? downloadState.hint ?? 'Baja el MP3 de esta versión'} className={downloadGate.locked ? 'opacity-90' : undefined}>
                              <Download className="h-4 w-4" aria-hidden />
                              Descargar MP3
                              <RequiredPlanBadge capability="DOWNLOAD_AUDIO" className="ml-auto" />
                            </DropdownMenuItem>
                            <WavMenuItem state={wavStateFor(v.id)} onSelect={() => onWav(v)} />
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                      {/* Casillero como el «Automático» de Creatividad: texto + círculo dorado; relleno cuando la versión es la activa */}
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={active}
                        aria-label={active ? `Versión ${v.versionNumber} activa` : `Hacer activa la versión ${v.versionNumber}`}
                        title={active ? 'Versión activa' : 'Hacer activa'}
                        onClick={() => !active && access.canModify && activeVersionMutation.mutate(v.id)}
                        disabled={!access.canModify || (!active && activeVersionMutation.isPending)}
                        className={`flex shrink-0 items-center gap-2 text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground disabled:cursor-not-allowed disabled:opacity-60 ${active ? 'cursor-default' : ''}`}
                      >
                        <span
                          aria-hidden
                          className={`flex size-8 shrink-0 items-center justify-center rounded-full border-[1.5px] border-gold transition-colors ${active ? 'bg-gold text-[#131C33]' : 'bg-transparent text-gold'}`}
                        >
                          {activeVersionMutation.isPending && activeVersionMutation.variables === v.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Check className={`h-4 w-4 ${active ? '' : 'opacity-40'}`} strokeWidth={3} />
                          )}
                        </span>
                      </button>
                    </div>
                  );
                })
              )}
            </div>
        </section>
      )}

      {/* ── Comunidad: comentarios o invitación a publicar ── */}
      {access.showCommunity ? (
        <CommentsSection
          song={song}
          currentUserId={user?.id}
          canModerate={isOwner}
          onReportComment={onReportComment}
          action={
            isOwner ? (
              /* Los dos interruptores alineados a la izquierda entre sí; el grupo sigue a la derecha de la sección */
              <div className="flex flex-col items-start gap-2">
                <label className="flex cursor-pointer items-center gap-2.5 text-sm text-muted-foreground">
                  <Switch
                    checked={song.allowComments}
                    onCheckedChange={(val) => visibilityMutation.mutate({ allowComments: val })}
                    disabled={visibilityMutation.isPending}
                    aria-label="Permitir comentarios"
                    className="data-[state=checked]:border-gold data-[state=checked]:bg-gold dark:data-[state=checked]:[&>span]:bg-[#131C33]"
                  />
                  Permitir comentarios
                </label>
                <label className="flex cursor-pointer items-center gap-2.5 text-sm text-muted-foreground">
                  <Switch
                    checked={song.allowRemix === true}
                    onCheckedChange={(val) => visibilityMutation.mutate({ allowRemix: val })}
                    disabled={visibilityMutation.isPending}
                    aria-label="Permitir Remixes"
                    className="data-[state=checked]:border-gold data-[state=checked]:bg-gold dark:data-[state=checked]:[&>span]:bg-[#131C33]"
                  />
                  Permitir Remixes
                </label>
              </div>
            ) : undefined
          }
        />
      ) : access.canModify ? (
        <section className="space-y-4" aria-label="Comentarios">
          <SectionHeader title="Comentarios" subtitle="Tu canción es privada" />
          <EmptyState
            variant="studio"
            actionIcon={null}
            icon={<Users className="h-7 w-7" aria-hidden />}
            title="Publicá tu canción para recibir comentarios de la comunidad"
            description="Mientras sea privada, solo vos podés escucharla. Al publicarla aparece en el feed de la comunidad con tu portada y tu sonido."
            actionLabel="Publicar en comunidad"
            onAction={() => visibilityMutation.mutate({ visibility: 'PUBLIC' })}
          />
        </section>
      ) : null}

      {/* ── Más del autor y más del género (canciones públicas) ── */}
      {access.showCommunity && community && (
        <>
          {authorMore.length > 0 && (
            <CommunitySongSection
              id="song-more-author"
              title={isOwner ? 'Más tuyas en la comunidad' : `Más de ${community.author.name}`}
              action={
                <Link to={`/user/${encodeURIComponent(community.author.id)}`} className="text-sm font-medium text-amber-strong underline-offset-4 transition-colors hover:text-foreground hover:underline">
                  Ver perfil
                </Link>
              }
              songs={authorMore}
              onReport={onReportCard}
            />
          )}
          {genreMore.length > 0 && primaryGenre && (
            <CommunitySongSection
              id="song-more-genre"
              title={`Más de ${primaryGenre}`}
              action={
                <Link to="/community" className="text-sm font-medium text-amber-strong underline-offset-4 transition-colors hover:text-foreground hover:underline">
                  Explorar comunidad
                </Link>
              }
              songs={genreMore}
              onReport={onReportCard}
            />
          )}
          {remixes.length > 0 && (
            <CommunitySongSection id="song-remixes" title="Remixes" songs={remixes} onReport={onReportCard} />
          )}
        </>
      )}

      {/* ── Diálogo: Editar detalles (nombre, portada, resumen de estilos, descripción) — solo dueño ── */}
      {access.canModify && (
        <EditSongDetailsDialog
          open={detailsOpen}
          onOpenChange={setDetailsOpen}
          song={song}
          derivedStyles={derivedStyleHint(currentVersion?.genre, currentVersion?.tags)}
          onChangeCover={() => setCoverDialogOpen(true)}
        />
      )}

      {/* ── Diálogo: Cambiar portada (subir o generar) ── */}
      <Dialog open={coverDialogOpen} onOpenChange={onCoverDialogChange}>
        <DialogContent className="max-w-md border-border/70 bg-surface">
          <DialogHeader>
            <DialogTitle className="font-display">Cambiar portada</DialogTitle>
            <DialogDescription>Subí una imagen tuya o dejá que Melodya genere una nueva.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Opción A: subir tu imagen */}
            <section className="space-y-3 rounded-xl border border-border/70 bg-surface-2/40 p-4" aria-label="Subir tu imagen">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <ImagePlus className="h-4 w-4 text-amber-strong" aria-hidden /> Subir tu imagen
              </h3>
              <p className="text-xs text-muted-foreground">JPG, PNG o WebP de hasta 5 MB. Reemplaza la portada actual.</p>
              <input
                ref={coverInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={onCoverFile}
                aria-label="Elegir imagen de portada"
                disabled={uploadCoverMutation.isPending}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                  onClick={() => coverInputRef.current?.click()}
                  disabled={uploadCoverMutation.isPending}
                >
                  <Upload className="h-4 w-4" aria-hidden /> Elegir imagen
                </Button>
                {coverFile && (
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={coverFile.name}>
                    {coverFile.name} ·{' '}
                    {coverFile.size >= 1024 * 1024
                      ? `${(coverFile.size / (1024 * 1024)).toFixed(1)} MB`
                      : `${Math.max(1, Math.round(coverFile.size / 1024))} KB`}
                  </span>
                )}
              </div>
              <Button
                type="button"
                className="rounded-full gradient-warm text-primary-foreground hover:text-primary-foreground"
                disabled={!coverFile || uploadCoverMutation.isPending}
                onClick={() => coverFile && uploadCoverMutation.mutate(coverFile)}
              >
                {uploadCoverMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Upload className="h-4 w-4" aria-hidden />}
                Subir portada
              </Button>
            </section>

            {/* Opción B: generar con Melodya */}
            <section className="space-y-3 rounded-xl border border-border/70 bg-surface-2/40 p-4" aria-label="Generar con Melodya">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <Sparkles className="h-4 w-4 text-amber-strong" aria-hidden /> Generar con Melodya
              </h3>
              <div className="space-y-2">
                <Input
                  value={coverPrompt}
                  onChange={(e) => setCoverPrompt(e.target.value)}
                  placeholder="Ej.: atardecer en la costa, colores cálidos…"
                  maxLength={1000}
                  aria-label="Descripción de la portada (opcional)"
                  className="rounded-full bg-background"
                  disabled={coverPending || coverArtLocked || uploadCoverMutation.isPending}
                />
                <Input
                  value={coverStyle}
                  onChange={(e) => setCoverStyle(e.target.value)}
                  placeholder="Ej.: retro, minimalista…"
                  maxLength={300}
                  aria-label="Estilo visual (opcional)"
                  className="rounded-full bg-background"
                  disabled={coverPending || coverArtLocked || uploadCoverMutation.isPending}
                />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">{coverArtLocked ? coverGate.copy?.message ?? LOCK_REASON.COVER_ART : 'No gasta fichas.'}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={cn('rounded-full border-amber/40 bg-amber/10 text-amber-strong transition-colors hover:border-amber hover:bg-amber/20', coverArtLocked && LOCKED_CONTROL)}
                  onClick={() => void onGenerateCover()}
                  disabled={coverPending}
                  aria-disabled={coverArtLocked || undefined}
                >
                  {coverPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Palette className="h-4 w-4" aria-hidden />}
                  Generar
                  <RequiredPlanBadge capability="COVER_ART" />
                </Button>
              </div>
            </section>
          </div>

          <DialogFooter>
            <Button variant="outline" className="rounded-full" onClick={() => onCoverDialogChange(false)}>
              Cerrar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Diálogo: Agregar a un proyecto ── */}
      <Dialog open={projectDialogOpen} onOpenChange={setProjectDialogOpen}>
        <DialogContent className="max-w-md border-border/70 bg-surface">
          <DialogHeader>
            <DialogTitle className="font-display">Agregar a un proyecto</DialogTitle>
            <DialogDescription>Elegí dónde vive «{song.title}».</DialogDescription>
          </DialogHeader>

          {projectsQuery.isLoading ? (
            <div className="space-y-2" aria-busy="true" aria-label="Cargando proyectos">
              <Skeleton className="h-16 rounded-xl" />
              <Skeleton className="h-16 rounded-xl" />
              <Skeleton className="h-16 rounded-xl" />
            </div>
          ) : projectsQuery.isError ? (
            <ErrorState message={toUserMessage(projectsQuery.error)} onRetry={() => void projectsQuery.refetch()} />
          ) : projects.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber/10 text-amber-strong" aria-hidden>
                <FolderPlus className="h-6 w-6" />
              </span>
              <p className="text-sm text-muted-foreground">Todavía no tenés proyectos para organizar tus canciones.</p>
              <Button
                variant="outline"
                className="rounded-full border-amber/40 bg-amber/10 text-amber-strong transition-colors hover:border-amber hover:bg-amber/20"
                onClick={() => {
                  setProjectDialogOpen(false);
                  navigate('/library/projects');
                }}
              >
                <FolderPlus className="h-4 w-4" aria-hidden /> Crear un proyecto
              </Button>
            </div>
          ) : (
            <>
              <div role="radiogroup" aria-label="Tus proyectos" className="space-y-2">
                {projects.map((p) => {
                  const isCurrent = song.projectId === p.id;
                  const isSelected = selectedProjectId === p.id;
                  const count = p.songsCount ?? 0;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      disabled={moveToProjectMutation.isPending}
                      onClick={() => setSelectedProjectId(p.id)}
                      className={`flex w-full cursor-pointer items-center gap-3 rounded-xl border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber ${
                        isSelected ? 'border-amber/50 bg-amber/[0.07]' : 'border-border/70 bg-surface-2/40 hover:border-amber/30'
                      } disabled:cursor-wait`}
                    >
                      <span
                        aria-hidden
                        className={`flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full border-2 ${
                          isSelected ? 'border-amber' : 'border-muted-foreground/50'
                        }`}
                      >
                        {isSelected && <span className="h-2 w-2 rounded-full gradient-warm" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-semibold">{p.name}</span>
                          {isCurrent && (
                            <Badge className="gap-1 border-amber/40 bg-amber/15 text-amber-strong">
                              <CheckCircle2 className="h-3 w-3" aria-hidden /> Actual
                            </Badge>
                          )}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                          {count} {count === 1 ? 'canción' : 'canciones'}
                          {p.description ? ` · ${p.description}` : ''}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>

              <DialogFooter className="gap-2 sm:justify-between">
                <div>
                  {song.projectId && (
                    <Button
                      variant="ghost"
                      className="rounded-full text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => moveToProjectMutation.mutate(null)}
                      disabled={moveToProjectMutation.isPending}
                    >
                      Quitar del proyecto
                    </Button>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" className="rounded-full" onClick={() => setProjectDialogOpen(false)}>
                    Cerrar
                  </Button>
                  <Button
                    className="rounded-full gradient-warm text-primary-foreground hover:text-primary-foreground"
                    disabled={!selectedProjectId || selectedProjectId === song.projectId || moveToProjectMutation.isPending}
                    onClick={() => selectedProjectId && moveToProjectMutation.mutate(selectedProjectId)}
                  >
                    {moveToProjectMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    ) : (
                      <FolderOpen className="h-4 w-4" aria-hidden />
                    )}
                    {song.projectId ? 'Mover' : 'Agregar'}
                  </Button>
                </div>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* v0.18.0 — dialog de denuncia (comentarios ajenos de esta canción) */}
      <ReportDialog
        open={reportTarget !== null}
        target={reportTarget}
        onOpenChange={(open) => {
          if (!open) setReportTarget(null);
        }}
      />
    </div>
  );
}
