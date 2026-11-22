'use client';

/**
 * MELODYA WEB — PublicProfileView: perfil público de creador (ruta #/user/:id).
 * Estilo Instagram: avatar grande, bio, stats clicables (seguidores/seguidos en
 * un dialog), grid de canciones con play, seguir/dejar de seguir y bloqueo.
 *
 * Contratos reales (melodya-backend v0.15 — Manual D.5/D.6/D.6.1):
 *  • GET    /community/users/:id                  → perfil público (bio + métricas + viewerIsFollowing)
 *  • GET    /community/users/:id/follows|followers → listas paginadas (cards con viewerIsFollowing)
 *  • GET    /community/songs?authorId=…            → canciones públicas del creador
 *  • POST|DELETE /users/:id/follow                → seguir / dejar de seguir (🔒)
 *  • POST|DELETE /users/:id/block                  → bloquear / desbloquear (🔒, rompe follows mutuos)
 */
import { useMemo, useState } from 'react';
import { ConfirmDialog } from '@/features/library/library-utils';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Ban, Flag, Heart, Loader2, MessageCircle, MoreVertical, Music4, Pause, Pencil, Play, Share2, Unlock, UserCheck, UserPlus, Users,
} from 'lucide-react';
import { communityApi, profileApi, songsApi } from '@/lib/api';
import { ApiError, apiFileUrl } from '@/lib/api/client';
import { navigate } from '@/lib/router';
import { toUserMessage } from '@/lib/errors';
import { cn } from '@/lib/utils';
import { shareContent } from '@/lib/share';
import { userUrl } from '@/lib/links';
import { hasText } from '@/features/song/song-details';
import { useAuthStore } from '@/stores/auth';
import { usePlayerStore, type PlayerTrack } from '@/stores/player';
import { formatNumber } from '@/hooks';
import { AuthAvatar, AuthImage, CoverArt, EmptyState, ErrorState, LoadingCards } from '@/components/common';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { useCommunityReaction } from '@/features/community/CommunityView';
import { ReportDialog, type ReportTarget } from '@/features/community/ReportDialog';
import type { CommunitySong, CommunityUserCard, Paginated, PublicUserProfile } from '@/types';

/* ── constantes ── */
const USER_LISTS_PAGE_SIZE = 20;
const SONGS_LIMIT = 50;

/** Canción pública del creador → pista del player global (mismo mapeo del feed
 *  de CommunityView: registra la reproducción con POST /songs/:id/play). */
function creatorSongTrack(song: CommunitySong): PlayerTrack | null {
  const audioUrl = apiFileUrl(song.audioUrl);
  if (!audioUrl) return null;
  const myId = useAuthStore.getState().user?.id;
  return {
    id: song.id,
    title: song.title,
    artist: song.author?.name ?? 'Comunidad Melodya',
    coverUrl: song.coverUrl,
    audioUrl,
    durationSec: song.durationSec,
    isPublic: true,
    own: !!myId && song.author?.id === myId,
    community: {
      likesCount: song.likesCount,
      viewerReaction: song.viewerReaction ?? null,
      authorId: song.author?.id ?? null,
    },
    onPlayed: () => {
      songsApi.registerPlay(song.id).catch(() => undefined);
    },
  };
}

/** Guarda de invitado: toast + derivar a /login. Devuelve true si hay sesión. */
function useGuestGuard() {
  const user = useAuthStore((s) => s.user);
  const { toast } = useToast();
  return (title: string, description?: string): boolean => {
    if (user) return true;
    toast({ title, description });
    navigate('/login');
    return false;
  };
}

/* ── Confirmación de bloqueo (destructiva, accesible) ── */
function BlockConfirmDialog({
  open, onOpenChange, name, actionLabel, description, onConfirm, pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  actionLabel: string;
  description: string;
  onConfirm: () => void;
  pending: boolean;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="font-display">{name}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending} className="rounded-full">Cancelar</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault(); // mantener el dialog abierto mientras viaja el request
              onConfirm();
            }}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {actionLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/* ══════════════ Vista principal ══════════════ */
export function PublicProfileView({ userId }: { userId: string }) {
  const user = useAuthStore((s) => s.user);
  const [listMode, setListMode] = useState<'followers' | 'following' | null>(null);

  const profileQuery = useQuery({
    queryKey: ['community', 'user', userId],
    queryFn: () => communityApi.userProfile(userId),
  });

  if (profileQuery.isLoading) {
    return (
      <div className="view-in mx-auto w-full max-w-7xl space-y-6" aria-busy="true" aria-label="Cargando el perfil">
        <div className="flex flex-col gap-5 rounded-2xl border border-border/70 bg-surface p-6 sm:flex-row">
          <Skeleton className="h-24 w-24 shrink-0 rounded-full sm:h-28 sm:w-28" />
          <div className="flex-1 space-y-3">
            <Skeleton className="h-8 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/3" />
            <div className="flex gap-3 pt-1">
              <Skeleton className="h-9 w-28 rounded-full" />
              <Skeleton className="h-9 w-9 rounded-full" />
            </div>
          </div>
        </div>
        <div className="space-y-3">
          <Skeleton className="h-6 w-32" />
          <LoadingCards count={5} />
        </div>
      </div>
    );
  }

  if (profileQuery.isError || !profileQuery.data) {
    /* 404 = usuario bloqueado o inexistente (el backend lo oculta a propósito). */
    const notFound = profileQuery.error instanceof ApiError && profileQuery.error.status === 404;
    return (
      <div className="view-in mx-auto w-full max-w-3xl space-y-4 py-10">
        <ErrorState
          message={
            notFound
              ? 'No pudimos cargar este perfil: no existe o hay un bloqueo de por medio.'
              : toUserMessage(profileQuery.error, 'No pudimos cargar este perfil.')
          }
        />
        <div className="flex justify-center">
          <Button variant="outline" className="rounded-full" onClick={() => navigate('/community')}>
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Volver a la comunidad
          </Button>
        </div>
      </div>
    );
  }

  const profile = profileQuery.data;
  const isOwn = Boolean(user && user.id === profile.id);

  return (
    <div className="view-in mx-auto w-full max-w-7xl space-y-6">
      <ProfileHeader
        profile={profile}
        isOwn={isOwn}
        onOpenList={(mode) => setListMode(mode)}
        onRefetchProfile={() => void profileQuery.refetch()}
      />

      {/* Bio pública del creador (la que escribe en «Mi perfil»): solo si tiene texto; respeta los saltos de línea */}
      {hasText(profile.bio) && (
        <section aria-label={`Bio de ${profile.name}`} className="min-w-0">
          {/* Como una cita: filete dorado a la izquierda y comillas de apertura y cierre; texto normal (sin cursiva) con la misma tipografía que la descripción de una canción (text-sm, leading-relaxed) */}
          <blockquote className="w-full min-w-0 border-l-[3px] border-[var(--m-gold)] py-0.5 pl-4 sm:pl-5">
            <p className="whitespace-pre-line break-words [overflow-wrap:anywhere] text-sm font-normal leading-relaxed text-muted-foreground before:mr-1 before:text-xl before:leading-none before:text-[var(--m-gold)] before:content-['“'] after:ml-1 after:text-xl after:leading-none after:text-[var(--m-gold)] after:content-['”']">
              {profile.bio.trim()}
            </p>
          </blockquote>
        </section>
      )}

      <CreatorSongs userId={userId} songsCount={profile.songsCount} />

      {/* listas de seguidos/seguidores (dialog reutilizado con modo) */}
      <UserListDialog
        userId={userId}
        profileName={profile.name}
        mode={listMode}
        open={listMode !== null}
        onOpenChange={(open) => {
          if (!open) setListMode(null);
        }}
      />
    </div>
  );
}

/* ══════════════ Header estilo Instagram ══════════════ */
function ProfileHeader({
  profile, isOwn, onOpenList, onRefetchProfile,
}: {
  profile: PublicUserProfile;
  isOwn: boolean;
  onOpenList: (mode: 'followers' | 'following') => void;
  onRefetchProfile: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const guard = useGuestGuard();
  const [blockOpen, setBlockOpen] = useState(false);
  const [confirmUnfollow, setConfirmUnfollow] = useState(false);
  /* v0.18.0 — denuncia del creador (POST /reports, targetType USER). */
  const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null);
  const onReportProfile = () => {
    if (!guard('Ingresá para denunciar contenido', 'Creá tu cuenta para ayudarnos a cuidar la comunidad.')) return;
    setReportTarget({ type: 'USER', id: profile.id, title: `a ${profile.name}` });
  };

  /* Compartir el perfil: diálogo nativo si existe; si no, copia el link al portapapeles. */
  const onShareProfile = async () => {
    const url = userUrl(profile.id);
    const outcome = await shareContent({ title: profile.name, text: `Mirá el perfil de ${profile.name} en Melodya`, url });
    if (outcome === 'shared') return;
    if (outcome === 'copied') {
      toast({ title: 'Link copiado 🔗', description: 'Pegalo donde quieras compartir este perfil.' });
    } else {
      toast({ title: 'No pudimos compartir el perfil', variant: 'destructive' });
    }
  };

  const following = Boolean(profile.viewerIsFollowing);
  const blocked = Boolean(profile.viewerHasBlocked);

  /* ── seguir / dejar de seguir (optimista sobre el perfil público) ── */
  const followMutation = useMutation({
    mutationFn: (vars: { follow: boolean }) =>
      vars.follow ? profileApi.follow(profile.id) : profileApi.unfollow(profile.id),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: ['community', 'user', profile.id] });
      qc.setQueryData<PublicUserProfile>(['community', 'user', profile.id], (old) =>
        old && old.id === profile.id
          ? {
              ...old,
              viewerIsFollowing: vars.follow,
              followersCount: Math.max(0, old.followersCount + (vars.follow ? 1 : -1)),
            }
          : old
      );
    },
    onError: (err) => {
      toast({ title: 'No pudimos actualizar a quién seguís', description: toUserMessage(err), variant: 'destructive' });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['community', 'user', profile.id] });
    },
  });

  /* ── bloquear (rompe follows mutuos) / desbloquear ── */
  const blockMutation = useMutation({
    mutationFn: (vars: { block: boolean }) =>
      vars.block ? profileApi.block(profile.id) : profileApi.unblock(profile.id),
    onSuccess: (_data, vars) => {
      setBlockOpen(false);
      if (vars.block) {
        // v0.26 — el bloqueo oculta TODO: también la música del autor que ya
        // estaba en la cola de reproducción (o sonando en este momento).
        const purged = usePlayerStore.getState().purgeAuthor(profile.id);
        toast({
          title: `Bloqueaste a ${profile.name}`,
          description:
            purged > 0
              ? `No se van a ver el contenido ni seguirse entre ustedes. Se quitó ${purged} ${purged === 1 ? 'canción' : 'canciones'} de tu cola.`
              : 'No se van a ver el contenido ni seguirse entre ustedes.',
        });
        // Su perfil "no existe" para nosotros ahora: volvemos a la comunidad.
        navigate('/community');
      } else {
        toast({
          title: `Desbloqueaste a ${profile.name}`,
          description: 'Ya pueden verse el contenido y seguirse otra vez.',
        });
        onRefetchProfile();
      }
      // el perfil cambia entero (viewerIsFollowing/métricas) y el feed filtra al bloqueado
      void qc.invalidateQueries({ queryKey: ['community', 'user', profile.id] });
      void qc.invalidateQueries({ queryKey: ['community'] });
    },
    onError: (err) => {
      toast({
        title: 'No pudimos actualizar el bloqueo',
        description: toUserMessage(err),
        variant: 'destructive',
      });
    },
  });

  const onFollowClick = () => {
    if (!guard('Ingresá para seguir creadores', 'Creá tu cuenta gratis y seguí a quien te gusta.')) return;
    // Dejar de seguir pide confirmación; seguir es directo.
    if (following) setConfirmUnfollow(true);
    else followMutation.mutate({ follow: true });
  };

  /* Reproducir todo el catálogo público del creador (misma query que la grilla: se comparte la caché). */
  const play = usePlayerStore((s) => s.play);
  const togglePlayer = usePlayerStore((s) => s.toggle);
  const currentTrack = usePlayerStore((s) => s.track);
  const playerPlaying = usePlayerStore((s) => s.isPlaying);
  const songsQuery = useQuery({
    queryKey: ['community', 'user', profile.id, 'songs'],
    queryFn: () => communityApi.feed({ authorId: profile.id, limit: SONGS_LIMIT }),
  });
  const queue = useMemo(
    () => (songsQuery.data?.items ?? []).map((s) => creatorSongTrack(s)).filter((t): t is PlayerTrack => t !== null),
    [songsQuery.data]
  );
  const playingCreator = Boolean(playerPlaying && currentTrack?.community?.authorId === profile.id);
  const onPlayAll = () => {
    if (playingCreator) {
      togglePlayer();
      return;
    }
    if (queue.length > 0) play(queue[0], queue);
  };

  const overlayBtn =
    'rounded-full border border-white/15 bg-black/45 text-white backdrop-blur-sm hover:bg-black/65 hover:text-white';

  return (
    <header className="relative rounded-[28px_28px_14px_14px] border-[1.5px] border-[var(--m-border)] bg-[var(--m-input)]">
      {/* portada del creador con identidad y acciones superpuestas */}
      <div className="relative aspect-video max-h-80 min-h-64 w-full overflow-hidden lg:max-h-[22rem] lg:min-h-[22rem] rounded-[26.5px_26.5px_12.5px_12.5px]">
        <AuthImage src={profile.coverImageUrl} alt={`Portada de ${profile.name}`} className="absolute inset-0 h-full w-full">
          <div className="absolute inset-0 bg-voice">
            <div className="absolute -left-6 -top-10 h-32 w-32 rounded-full bg-amber/20 blur-2xl" aria-hidden />
            <div className="absolute -right-8 top-6 h-28 w-28 rounded-full bg-coral/20 blur-2xl" aria-hidden />
            <div className="absolute bottom-2 left-1/3 h-20 w-40 rounded-full bg-white/5 blur-xl" aria-hidden />
          </div>
        </AuthImage>
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/85 via-black/30 to-transparent" aria-hidden />

        {/* acciones: arriba a la derecha de la portada */}
        <div className="absolute top-3 right-3 z-10 flex items-center gap-2 sm:top-4 sm:right-4">
          {isOwn ? (
            <Button variant="ghost" className={cn('h-11 px-5', overlayBtn)} onClick={() => navigate('/profile')}>
              <Pencil className="h-4 w-4" aria-hidden />
              Editar mi perfil
            </Button>
          ) : (
            <>
              <Button
                variant="ghost"
                disabled={followMutation.isPending}
                onClick={onFollowClick}
                aria-pressed={following}
                className={cn(
                  'h-11 px-5',
                  following
                    ? overlayBtn
                    : 'rounded-full gradient-warm text-primary-foreground hover:text-primary-foreground',
                  blocked && followMutation.isPending && 'opacity-50'
                )}
              >
                {followMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : following ? (
                  <UserCheck className="h-4 w-4" aria-hidden />
                ) : (
                  <UserPlus className="h-4 w-4" aria-hidden />
                )}
                {following ? 'Siguiendo' : 'Seguir'}
              </Button>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Más opciones para ${profile.name}`}
                    className={cn('h-11 w-11', overlayBtn)}
                  >
                    <MoreVertical className="h-4 w-4" aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" variant="list">
                  <DropdownMenuItem onClick={() => void onShareProfile()} className="cursor-pointer gap-2 rounded-lg">
                    <Share2 className="h-4 w-4" aria-hidden />
                    Compartir perfil
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {blocked ? (
                    <DropdownMenuItem
                      onClick={() => setBlockOpen(true)}
                      className="cursor-pointer gap-2 rounded-lg"
                    >
                      <Unlock className="h-4 w-4 text-amber-strong" aria-hidden />
                      Desbloquear
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem
                      onClick={() => setBlockOpen(true)}
                      className="cursor-pointer gap-2 rounded-lg text-destructive focus:text-destructive"
                    >
                      <Ban className="h-4 w-4" aria-hidden />
                      Bloquear
                    </DropdownMenuItem>
                  )}
                  {/* v0.18.0 — denuncia del creador (convive con el bloqueo) */}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={onReportProfile}
                    className="cursor-pointer gap-2 rounded-lg text-destructive focus:text-destructive"
                  >
                    <Flag className="h-4 w-4" aria-hidden />
                    Denunciar a {profile.name}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </div>

        <div className="@container absolute inset-x-0 bottom-0 flex flex-col">
        <div className="flex flex-col gap-4 p-4 sm:p-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            {/* Mismo avatar que en «Mi perfil»: aro del color de fondo y aro dorado por fuera */}
            <span className="block shrink-0 rounded-full" aria-hidden>
              <AuthAvatar
                src={profile.avatarUrl}
                name={profile.name}
                className="size-20 border-0 shadow-[0_0_0_4px_var(--background),0_0_0_6.5px_var(--m-gold)] sm:size-24"
                fallbackClassName="bg-surface text-[22px] text-foreground sm:text-[26px] dark:text-foreground"
              />
            </span>
            <div className="min-w-0">
              <h1 className="truncate font-display text-2xl font-extrabold tracking-tight text-white drop-shadow sm:text-4xl">
                {profile.name}
              </h1>
              {/* Reproducciones totales bajo el nombre (en la franja de contadores la fila se partía en dos líneas en celulares angostos) */}
              <p
                className="mt-1 inline-flex items-center gap-1.5 text-sm text-white/80"
                title="Reproducciones totales de sus canciones públicas"
              >
                <Play className="h-4 w-4" aria-hidden />
                <span className="font-semibold tabular-nums">{formatNumber(profile.totalPlays)}</span>
                reproducciones
              </p>
            </div>
          </div>

        </div>
          {/* stats clicables, sobre la portada (abajo, igual que en el detalle de una canción): mismo estilo que los números del detalle de una canción (franja navy translúcida, crema, 14 px semibold, íconos de 17 px) */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 bg-surface/80 py-3 pr-24 pl-4 text-[14px] font-semibold text-foreground/85 sm:pr-24 sm:pl-6 dark:bg-[rgba(19,28,51,.72)] dark:text-[rgba(243,229,226,.85)]">
            <button
              type="button"
              onClick={() => document.getElementById('creator-songs')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              aria-label={`Ver las ${profile.songsCount} canciones de ${profile.name}`}
              className="inline-flex items-center gap-1.5 rounded-full transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground dark:hover:text-[#F3E5E2] dark:focus-visible:outline-[#F3E5E2]"
            >
              <Music4 className="h-[17px] w-[17px]" aria-hidden />
              <span className="tabular-nums">{formatNumber(profile.songsCount)}</span> <span className="@max-[48rem]:sr-only">canciones</span>
            </button>
            <button
              type="button"
              onClick={() => onOpenList('followers')}
              aria-label={`Ver los seguidores de ${profile.name}`}
              className="inline-flex items-center gap-1.5 rounded-full transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground dark:hover:text-[#F3E5E2] dark:focus-visible:outline-[#F3E5E2]"
            >
              <Users className="h-[17px] w-[17px]" aria-hidden />
              <span className="tabular-nums">{formatNumber(profile.followersCount)}</span> <span className="@max-[48rem]:sr-only">seguidores</span>
            </button>
            <button
              type="button"
              onClick={() => onOpenList('following')}
              aria-label={`Ver a quién sigue ${profile.name}`}
              className="inline-flex items-center gap-1.5 rounded-full transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground dark:hover:text-[#F3E5E2] dark:focus-visible:outline-[#F3E5E2]"
            >
              <UserCheck className="h-[17px] w-[17px]" aria-hidden />
              <span className="tabular-nums">{formatNumber(profile.followingCount)}</span> <span className="@max-[48rem]:sr-only">seguidos</span>
            </button>
            <span className="inline-flex items-center gap-1.5" title="Me gusta totales de sus canciones públicas">
              <Heart className="h-[17px] w-[17px]" aria-hidden />
              <span className="tabular-nums">{formatNumber(profile.totalLikes)}</span>
              <span className="@max-[48rem]:sr-only">me gusta</span>
            </span>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmUnfollow}
        onOpenChange={setConfirmUnfollow}
        title={`¿Dejar de seguir a ${profile.name}?`}
        description="Su contenido deja de aparecer en tu feed de seguidos. Podés volver a seguirlo cuando quieras."
        actionLabel="Dejar de seguir"
        pending={followMutation.isPending}
        onConfirm={() => {
          setConfirmUnfollow(false);
          followMutation.mutate({ follow: false });
        }}
      />

      {/* confirmación de bloqueo / desbloqueo */}
      <BlockConfirmDialog
        open={blockOpen}
        onOpenChange={setBlockOpen}
        name={profile.name}
        actionLabel={blocked ? 'Desbloquear' : 'Bloquear'}
        description={
          blocked
            ? `¿Desbloquear a ${profile.name}? Vuelve a ver el contenido del otro y pueden seguirse si quieren.`
            : `¿Bloquear a ${profile.name}? No van a poder verse el contenido ni seguirse, y se rompen los follows en ambas direcciones.`
        }
        onConfirm={() => {
          if (!guard('Ingresá para gestionar bloqueos', 'Necesitás una cuenta para bloquear creadores.')) {
            setBlockOpen(false);
            return;
          }
          blockMutation.mutate({ block: !blocked });
        }}
        pending={blockMutation.isPending}
      />

      {/* Reproducir como en «Más escuchada» de Comunidad: círculo de 60 px que cuelga del borde inferior de la portada, con aro del color del fondo */}
      <button
        type="button"
        onClick={onPlayAll}
        disabled={queue.length === 0 && !playingCreator}
        aria-label={playingCreator ? `Pausar a ${profile.name}` : `Reproducir canciones de ${profile.name}`}
        className="absolute right-4 -bottom-3.5 z-10 flex size-[60px] cursor-pointer items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[0_0_0_5px_var(--background)] transition-transform active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground disabled:cursor-not-allowed disabled:opacity-50"
      >
        {playingCreator ? (
          <Pause className="h-[18px] w-[18px] fill-current" aria-hidden />
        ) : (
          <Play className="h-[18px] w-[18px] translate-x-px fill-current" aria-hidden />
        )}
      </button>

      {/* v0.18.0 — dialog de denuncia del creador */}
      <ReportDialog
        open={reportTarget !== null}
        target={reportTarget}
        onOpenChange={(open) => {
          if (!open) setReportTarget(null);
        }}
      />
    </header>
  );
}

/* ══════════════ Canciones del creador ══════════════ */
function CreatorSongs({ userId, songsCount }: { userId: string; songsCount: number }) {
  const play = usePlayerStore((s) => s.play);
  const currentTrack = usePlayerStore((s) => s.track);
  const isPlaying = usePlayerStore((s) => s.isPlaying);

  const songsQuery = useQuery({
    queryKey: ['community', 'user', userId, 'songs'],
    queryFn: () => communityApi.feed({ authorId: userId, limit: SONGS_LIMIT }),
  });

  const songs = useMemo(() => songsQuery.data?.items ?? [], [songsQuery.data]);
  const queue = useMemo(
    () => songs.map((s) => creatorSongTrack(s)).filter((t): t is PlayerTrack => t !== null),
    [songs]
  );

  const isCurrentPlaying = (song: CommunitySong) => Boolean(isPlaying && currentTrack?.id === song.id);

  const guard = useGuestGuard();
  const reactMutation = useCommunityReaction();
  const onReact = (song: CommunitySong) => {
    if (!guard('Ingresá para reaccionar', 'Creá tu cuenta gratis y dejá tu me gusta a otros melodiosos.')) return;
    reactMutation.mutate({ id: song.id, type: 'LIKE' });
  };

  const onPlaySong = (song: CommunitySong) => {
    const track = creatorSongTrack(song);
    if (!track) return;
    play(track, queue);
  };

  return (
    <section id="creator-songs" aria-label="Canciones del creador" className="scroll-mt-20 space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-[13px] font-bold uppercase tracking-[0.08em] text-label">
            <span aria-hidden className="size-[7.5px] shrink-0 rounded-full bg-gold" />
            Canciones
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {songsCount > 0
              ? `${formatNumber(songsCount)} ${songsCount === 1 ? 'canción publicada' : 'canciones publicadas'}`
              : 'Todavía sin publicaciones'}
          </p>
        </div>
      </div>

      {songsQuery.isLoading ? (
        <LoadingCards count={5} className="grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5" />
      ) : songsQuery.isError ? (
        <ErrorState
          message={toUserMessage(songsQuery.error, 'No pudimos cargar las canciones.')}
          onRetry={() => void songsQuery.refetch()}
        />
      ) : songs.length === 0 ? (
        <EmptyState
          icon={<Music4 className="h-7 w-7" />}
          title="Todavía no publicó canciones"
          description="Cuando publique algo de su biblioteca, va a aparecer acá para escucharlo y comentarlo."
        />
      ) : (
        <div
          role="list"
          aria-label="Canciones publicadas"
          className="stagger grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
        >
          {songs.map((song) => {
            const playable = Boolean(apiFileUrl(song.audioUrl));
            const playing = isCurrentPlaying(song);
            return (
              <article key={song.id} role="listitem" className="lift group flex flex-col gap-2">
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => navigate(`/songs/${song.id}`)}
                    aria-label={`Ver ${song.title}, de ${song.author.name}`}
                    className="block w-full cursor-pointer rounded-[28px_28px_14px_14px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <CoverArt
                      id={song.id}
                      src={song.coverUrl}
                      alt={`Portada de ${song.title}`}
                      className="aspect-square w-full transition-transform duration-300"
                      rounded="rounded-[28px_28px_14px_14px]"
                    />
                  </button>
                  {playable && (
                    /* Insignia ▶ como en las canciones de la Biblioteca: círculo de 32 px con borde blanco en la esquina inferior derecha (zona táctil de 52 px) */
                    <button
                      type="button"
                      aria-label={playing ? `Pausar ${song.title}` : `Escuchá ${song.title}`}
                      onClick={() => onPlaySong(song)}
                      className="group/pb absolute right-0 bottom-0 z-[2] flex size-[52px] items-center justify-center focus-visible:outline-none"
                    >
                      <span
                        aria-hidden
                        className={cn(
                          'flex size-8 items-center justify-center rounded-full border-[1.5px] border-white transition-transform group-active/pb:scale-95 group-focus-visible/pb:ring-2 group-focus-visible/pb:ring-foreground group-focus-visible/pb:ring-offset-2',
                          playing ? 'bg-primary text-primary-foreground' : 'bg-black/55 text-white'
                        )}
                      >
                        {playing ? <Pause className="h-3.5 w-3.5 fill-current" /> : <Play className="h-3.5 w-3.5 translate-x-px fill-current" />}
                      </span>
                    </button>
                  )}
                </div>

                <div className="flex min-w-0 flex-col gap-0.5 pt-0.5">
                  <button
                    type="button"
                    onClick={() => navigate(`/songs/${song.id}`)}
                    className="block w-full min-w-0 cursor-pointer truncate rounded text-left text-[15px] leading-tight font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  >
                    {song.title}
                  </button>
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 pt-0.5 text-xs tabular-nums text-muted-foreground">
                    <span className="inline-flex items-center gap-1" title="Reproducciones">
                      <Play className="h-3.5 w-3.5" aria-hidden />
                      <span className="tabular-nums">{formatNumber(song.playsCount)}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => onReact(song)}
                      aria-pressed={song.viewerReaction === 'LIKE'}
                      aria-label={song.viewerReaction === 'LIKE' ? `Quitar me gusta de ${song.title}` : `Me gusta ${song.title}`}
                      title="Me gusta"
                      className={cn(
                        'inline-flex items-center gap-1 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        song.viewerReaction === 'LIKE' ? 'text-label' : 'hover:text-foreground'
                      )}
                    >
                      <Heart
                        key={song.viewerReaction === 'LIKE' ? 'on' : 'off'}
                        className={cn('h-3.5 w-3.5', song.viewerReaction === 'LIKE' && 'fill-current heart-pop')}
                        aria-hidden
                      />
                      <span className="tabular-nums">{formatNumber(song.likesCount)}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => navigate(`/songs/${song.id}`)}
                      aria-label={`${song.commentsCount} comentarios, ver ${song.title}`}
                      title="Comentarios"
                      className="inline-flex items-center gap-1 rounded-full transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <MessageCircle className="h-3.5 w-3.5" aria-hidden />
                      <span className="tabular-nums">{formatNumber(song.commentsCount)}</span>
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

/* ══════════════ Dialog de seguidos / seguidores ══════════════ */
function UserListDialog({
  userId, profileName, mode, open, onOpenChange,
}: {
  userId: string;
  profileName: string;
  mode: 'followers' | 'following' | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const viewer = useAuthStore((s) => s.user);

  const listQuery = useInfiniteQuery({
    queryKey: ['community', 'user', userId, mode ?? 'followers'],
    queryFn: ({ pageParam }) =>
      mode === 'following'
        ? communityApi.userFollows(userId, { page: pageParam, limit: USER_LISTS_PAGE_SIZE })
        : communityApi.userFollowers(userId, { page: pageParam, limit: USER_LISTS_PAGE_SIZE }),
    enabled: open && mode !== null,
    initialPageParam: 1,
    getNextPageParam: (last: Paginated<CommunityUserCard>) =>
      last.pagination.page < last.pagination.pages ? last.pagination.page + 1 : undefined,
  });

  const rows = useMemo(() => listQuery.data?.pages.flatMap((p) => p.items) ?? [], [listQuery.data]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] gap-0 overflow-y-auto rounded-[28px_28px_14px_14px] p-0 sm:max-w-md">
        <div className="sticky top-0 z-10 border-b border-border bg-surface px-5 py-4 pr-16">
          <DialogTitle className="text-left font-display text-lg font-bold text-foreground">
            {mode === 'following' ? `A quién sigue ${profileName}` : `Seguidores de ${profileName}`}
          </DialogTitle>
          <DialogDescription className="mt-0.5 text-left text-xs">
            {mode === 'following' ? 'Los creadores que sigue en Melodya' : 'Quien sigue su música en Melodya'}
          </DialogDescription>
        </div>

        <div className="p-3">
          {listQuery.isLoading ? (
            <div className="space-y-2" aria-busy="true" aria-label="Cargando la lista">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 p-2">
                  <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-2/3" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                </div>
              ))}
            </div>
          ) : listQuery.isError ? (
            <ErrorState
              message={toUserMessage(listQuery.error, 'No pudimos cargar la lista.')}
              onRetry={() => void listQuery.refetch()}
              className="py-8"
            />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<Users className="h-6 w-6" />}
              title={mode === 'following' ? 'Todavía no sigue a nadie' : 'Todavía no tiene seguidores'}
              description={
                mode === 'following'
                  ? `Cuando ${profileName} empiece a seguir creadores, van a aparecer acá.`
                  : 'Cuando alguien la siga o lo siga, va a aparecer acá.'
              }
              className="border-0 bg-transparent py-8"
            />
          ) : (
            <>
              <ul className="divide-y divide-border/60" aria-label={mode === 'following' ? 'Seguidos' : 'Seguidores'}>
                {rows.map((row) => (
                  <UserListRow
                    key={row.id}
                    row={row}
                    listUserId={userId}
                    listMode={mode ?? 'followers'}
                    isViewer={Boolean(viewer && viewer.id === row.id)}
                    canFollow={!viewer || viewer.id !== row.id}
                    onOpenProfile={() => {
                      onOpenChange(false);
                      navigate(`/user/${row.id}`);
                    }}
                  />
                ))}
              </ul>
              {listQuery.hasNextPage && (
                <div className="pt-3 text-center">
                  <Button
                    variant="outline"
                    className="h-10 rounded-[20px] border-[1.5px] border-foreground/50 bg-transparent px-[18px] text-sm font-medium text-foreground transition-colors hover:border-foreground/50 hover:bg-foreground/10 hover:text-foreground"
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
                </div>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Fila de usuario: avatar + nombre + seguidores + seguir/dejar de seguir rápido. */
function UserListRow({
  row, listUserId, listMode, isViewer, canFollow, onOpenProfile,
}: {
  row: CommunityUserCard;
  listUserId: string;
  listMode: 'followers' | 'following';
  isViewer: boolean;
  canFollow: boolean;
  onOpenProfile: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const guard = useGuestGuard();
  const following = Boolean(row.viewerIsFollowing);
  const [confirmUnfollow, setConfirmUnfollow] = useState(false);

  /* Optimista sobre la lista visible; el invalidate global resincroniza el resto
   * (perfil del row, mis seguidos, feed de seguidos, etc.). */
  const followMutation = useMutation({
    mutationFn: (vars: { follow: boolean }) =>
      vars.follow ? profileApi.follow(row.id) : profileApi.unfollow(row.id),
    onMutate: async (vars) => {
      const listKey = ['community', 'user', listUserId, listMode];
      await qc.cancelQueries({ queryKey: listKey });
      qc.setQueryData<{ pages: Array<Paginated<CommunityUserCard>> }>(listKey, (old) =>
        old
          ? {
              ...old,
              pages: old.pages.map((page) => ({
                ...page,
                items: page.items.map((it) => (it.id === row.id ? { ...it, viewerIsFollowing: vars.follow } : it)),
              })),
            }
          : old
      );
    },
    onError: (err) => {
      toast({ title: 'No pudimos actualizar a quién seguís', description: toUserMessage(err), variant: 'destructive' });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['community'] });
    },
  });

  return (
    <li className="flex items-center gap-3 py-2.5">
      <button
        type="button"
        onClick={onOpenProfile}
        aria-label={`Ver el perfil de ${row.name}`}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-xl p-1 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <AuthAvatar src={row.avatarUrl} name={row.name} className="h-10 w-10 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-foreground">{row.name}</span>
          <span className="block text-xs text-muted-foreground">
            {isViewer ? 'Vos' : `${formatNumber(row.followersCount ?? 0)} seguidores`}
          </span>
        </span>
      </button>

      {canFollow && !isViewer && (
        <Button
          size="sm"
          variant={following ? 'secondary' : 'outline'}
          disabled={followMutation.isPending}
          aria-pressed={following}
          aria-label={following ? `Dejar de seguir a ${row.name}` : `Seguir a ${row.name}`}
          onClick={() => {
            if (!guard('Ingresá para seguir creadores', 'Creá tu cuenta gratis y seguí a quien te gusta.')) return;
            // Dejar de seguir pide confirmación; seguir es directo.
            if (following) setConfirmUnfollow(true);
            else followMutation.mutate({ follow: true });
          }}
          className={cn(
            'shrink-0 rounded-full',
            !following && 'border-amber/40 bg-amber/10 text-amber-strong hover:border-amber hover:bg-amber/20 hover:text-amber-strong'
          )}
        >
          {followMutation.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : following ? (
            <UserCheck className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <UserPlus className="h-3.5 w-3.5" aria-hidden />
          )}
          {following ? 'Siguiendo' : 'Seguir'}
        </Button>
      )}
      <ConfirmDialog
        open={confirmUnfollow}
        onOpenChange={setConfirmUnfollow}
        title={`¿Dejar de seguir a ${row.name}?`}
        description="Su contenido deja de aparecer en tu feed de seguidos. Podés volver a seguirlo cuando quieras."
        actionLabel="Dejar de seguir"
        pending={followMutation.isPending}
        onConfirm={() => {
          setConfirmUnfollow(false);
          followMutation.mutate({ follow: false });
        }}
      />
    </li>
  );
}
