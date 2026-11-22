'use client';

/**
 * MELODYA WEB — Perfil (rutas #/profile y #/profile/settings; auth requerida).
 * Tabs: Perfil · Seguridad · Actividad · Configuración (hash por tab → linkable).
 * Contrato real (audit §2.1, §2.2, §2.5, §2.7):
 *  • GET/PATCH /users/me · POST /users/me/avatar (máx 5MB, image/*) · POST /users/me/voice-consent
 *  • POST /auth/change-password · POST /auth/logout · POST /auth/logout-all
 *  • GET /generations (actividad reciente).
 * Las preferencias de "Configuración" son SOLO de este navegador (localStorage):
 * el backend no tiene endpoints de preferencias (BACKEND GAP, audit §15).
 */
import { ActivityHistory } from '@/features/activity/ActivityHistory';
import React, { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AudioLines, Ban, Camera, Check, CheckCircle2, Crown, Eye, EyeOff, ImagePlus, KeyRound, Loader2, LogOut,
  MonitorSmartphone, Music4, Music2, Plus, Settings2, ShieldCheck, Trash2, Unlock, User, UserMinus, UserPlus, Users, X, type LucideIcon } from 'lucide-react';
import { CoinIcon } from '@/components/common/CoinIcon';
import { authApi, communityApi, profileApi } from '@/lib/api';
import { toUserMessage } from '@/lib/errors';
import { navigate, useRoute } from '@/lib/router';
import { useAuthStore } from '@/stores/auth';
import { formatNumber, useCredits } from '@/hooks';
import { useToast } from '@/hooks/use-toast';
import type { CommunityUserCard, MeProfile, Paginated } from '@/types';
import { cn } from '@/lib/utils';
import { Chip, ErrorState, LoadingRows, SectionHeader, AuthAvatar, AuthImage } from '@/components/common';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { DashedEmpty } from '@/components/common/DashedEmpty';
import { ConfirmDialog } from '@/features/library/library-utils';
import { ExpandableLyrics } from '@/features/creator/PlanetEditors';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

/* Tarjeta de las listas del sistema (design-V2): esquinas 28/28/14/14, borde de 1,5 px y fondo de campo. */
const CARD = 'gap-0 rounded-[28px_28px_14px_14px] border-[1.5px] border-[var(--m-border)] bg-[var(--m-input)] py-0 shadow-none';
/* Título de tarjeta con su ícono en un círculo, como el de «Preferencias» y el de «Publicación» de una canción propia. */
function CardHeading({ icon: Icon, tone = 'gold', children }: { icon: LucideIcon; tone?: 'gold' | 'sound'; children: React.ReactNode }) {
  return (
    <h3 className="flex items-center gap-2 font-display text-lg font-bold text-foreground">
      <span
        aria-hidden
        className={cn('flex size-8 shrink-0 items-center justify-center rounded-full', tone === 'sound' ? 'bg-element-sound text-[#131C33]' : 'bg-gold text-on-gold')}
      >
        <Icon className="h-4 w-4" />
      </span>
      {children}
    </h3>
  );
}

/* Botón secundario de contorno fino. */
const OUTLINE_BTN = 'rounded-full border-[1.5px] border-line bg-transparent text-foreground hover:bg-accent';

/* ── Tabs (hash-linkable: /profile, /profile/security, /profile/activity, /profile/settings) ── */
const PROFILE_TABS = [
  { key: 'profile', label: 'Perfil', icon: User },
  { key: 'security', label: 'Seguridad', icon: ShieldCheck },
  { key: 'activity', label: 'Mi actividad', icon: Music4 },
  { key: 'community', label: 'Comunidad', icon: Users },
  { key: 'settings', label: 'Configuración', icon: Settings2 },
] as const;
type ProfileTabKey = (typeof PROFILE_TABS)[number]['key'];

function tabFromPath(path: string): ProfileTabKey {
  const seg = path.replace(/^\/profile\/?/, '').split('/')[0];
  return PROFILE_TABS.find((t) => t.key === seg)?.key ?? 'profile';
}

const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric' }) : '';


/* ── Autorización de uso de voz (v1 — texto honesto, audit §2.2) ── */
const VOICE_CONSENT_VERSION = '1';
const VOICE_CONSENT_PARAGRAPHS = [
  'Autorizo a Melodya a procesar mis muestras de voz para crear una versión sintética de mi voz, únicamente para generar canciones en mi cuenta.',
  'Mis muestras se usan solamente para crear esa versión sintética: no se comparten con otras personas ni se usan para entrenar voces de terceros.',
  'Puedo revocar este consentimiento en cualquier momento eliminando mis muestras de voz desde la biblioteca.',
  'Me comprometo a no usar esta función para suplantar la voz ni la identidad de otras personas.',
];

export function ProfileView() {
  const { path } = useRoute();
  const tab = tabFromPath(path);
  const user = useAuthStore((s) => s.user);

  if (!user) {
    return (
      <div className="view-in flex min-h-[40vh] items-center justify-center" aria-busy="true">
        <Loader2 className="h-8 w-8 animate-spin text-amber-strong" aria-hidden />
        <span className="sr-only">Cargando tu perfil…</span>
      </div>
    );
  }

  return (
    <div className="view-in">
      <header className="mb-6">
        <h1 className="font-display text-3xl font-extrabold tracking-tight text-foreground">Tu perfil</h1>
        <p className="mt-1 text-sm text-muted-foreground">Quién sos en Melodya, tu seguridad y tu actividad.</p>
      </header>

      <ProfileHeaderCard user={user} />

      {/* Pestañas: mismo grupo segmentado que la Biblioteca */}
      <SegmentedTabs
        tabs={PROFILE_TABS}
        value={tab}
        onChange={(key) => navigate(key === 'profile' ? '/profile' : `/profile/${key}`)}
        ariaLabel="Secciones del perfil"
        className="mb-6 mt-6"
      />

      <div key={tab} className="view-in">
        {tab === 'profile' && <ProfileTab user={user} />}
        {tab === 'security' && <SecurityTab />}
        {tab === 'activity' && <ActivityTab />}
        {tab === 'community' && <CommunityTab user={user} />}
        {tab === 'settings' && <SettingsTab />}
      </div>
    </div>
  );
}

/* ── Header: portada + avatar con upload + identidad + badges ── */
function ProfileHeaderCard({ user }: { user: MeProfile }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const avatarInput = useRef<HTMLInputElement>(null);
  const coverInput = useRef<HTMLInputElement>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [uploadingCover, setUploadingCover] = useState(false);
  const [removingCover, setRemovingCover] = useState(false);
  const [confirmCover, setConfirmCover] = useState(false);
  const { data: credits } = useCredits();
  const balance = credits?.balance ?? user.creditsBalance;

  const checkImage = (file: File, kind: string) => {
    if (file.size > 5 * 1024 * 1024) {
      toast({ title: `La ${kind} es demasiado grande`, description: 'Elegí una imagen de hasta 5 MB.', variant: 'destructive' });
      return false;
    }
    return true;
  };

  const onAvatarFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // permitir volver a elegir el mismo archivo
    if (!file || !checkImage(file, 'foto')) return;
    setUploadingAvatar(true);
    try {
      await profileApi.uploadAvatar(file);
      await useAuthStore.getState().loadMe();
      void qc.invalidateQueries({ queryKey: ['me'] });
      toast({ title: 'Foto de perfil actualizada' });
    } catch (err) {
      toast({ title: 'No pudimos actualizar tu foto', description: toUserMessage(err), variant: 'destructive' });
    } finally {
      setUploadingAvatar(false);
    }
  };

  /* v0.19 — portada del perfil: banner que ven los demás en tu perfil público. */
  const onCoverFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !checkImage(file, 'portada')) return;
    setUploadingCover(true);
    try {
      await profileApi.uploadCover(file);
      await useAuthStore.getState().loadMe();
      void qc.invalidateQueries({ queryKey: ['me'] });
      toast({ title: 'Portada actualizada', description: 'Ya se ve en tu perfil público.' });
    } catch (err) {
      toast({ title: 'No pudimos actualizar tu portada', description: toUserMessage(err), variant: 'destructive' });
    } finally {
      setUploadingCover(false);
    }
  };

  const onRemoveCover = async () => {
    setRemovingCover(true);
    try {
      await profileApi.removeCover();
      await useAuthStore.getState().loadMe();
      void qc.invalidateQueries({ queryKey: ['me'] });
      toast({ title: 'Portada quitada' });
    } catch (err) {
      toast({ title: 'No pudimos quitar la portada', description: toUserMessage(err), variant: 'destructive' });
    } finally {
      setRemovingCover(false);
    }
  };

  const coverBusy = uploadingCover || removingCover;

  const overlayBtn =
    'flex h-10 cursor-pointer items-center gap-1.5 rounded-full border-[1.5px] border-white/40 bg-black/45 px-3.5 text-[13px] font-semibold text-white backdrop-blur-sm transition-all hover:bg-black/65 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:cursor-wait disabled:opacity-60 disabled:border-transparent';

  return (
    <Card className={cn(CARD, 'overflow-hidden')}>
      {/* Portada (v0.19) con identidad superpuesta: imagen subida o gradiente de la marca */}
      <div className="group/cover relative aspect-video max-h-80 min-h-64 w-full" role="img" aria-label={user.coverImageUrl ? `Portada de ${user.name}` : 'Sin portada'}>
        <AuthImage src={user.coverImageUrl} alt={`Portada de ${user.name}`} className="absolute inset-0 h-full w-full">
          <div className="absolute inset-0 bg-voice" aria-hidden>
            <div className="absolute -left-6 -top-10 h-32 w-32 rounded-full bg-amber/20 blur-2xl" aria-hidden />
            <div className="absolute -right-8 top-6 h-28 w-28 rounded-full bg-coral/20 blur-2xl" aria-hidden />
            <div className="absolute bottom-2 left-1/3 h-20 w-40 rounded-full bg-white/5 blur-xl" aria-hidden />
          </div>
        </AuthImage>

        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/85 via-black/30 to-transparent" aria-hidden />

        {/* Controles de portada: arriba a la derecha, siempre visibles (mobile no tiene hover) */}
        <div className="absolute right-3 top-3 flex items-center gap-1.5">
          {user.coverImageUrl && (
            <button
              type="button"
              onClick={() => setConfirmCover(true)}
              disabled={coverBusy}
              aria-label="Quitar la portada del perfil"
              title="Quitar portada"
              className={cn(overlayBtn, 'size-10 shrink-0 justify-center gap-0 px-0 hover:bg-destructive/80')}
            >
              {removingCover ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Trash2 className="h-4 w-4" aria-hidden />}
            </button>
          )}
          <button
            type="button"
            onClick={() => coverInput.current?.click()}
            disabled={coverBusy}
            aria-label={user.coverImageUrl ? 'Cambiar la portada del perfil' : 'Agregar una portada al perfil'}
            title={user.coverImageUrl ? 'Cambiar portada' : 'Agregar portada'}
            className={cn(overlayBtn, 'max-sm:size-10 max-sm:shrink-0 max-sm:justify-center max-sm:gap-0 max-sm:px-0')}
          >
            {uploadingCover ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ImagePlus className="h-4 w-4" aria-hidden />}
            <span className="hidden sm:inline">{user.coverImageUrl ? 'Cambiar' : 'Agregar'} portada</span>
          </button>
        </div>
        <input ref={coverInput} type="file" accept="image/*" className="hidden" onChange={onCoverFile} aria-label="Subir imagen de portada" />
        <ConfirmDialog
          open={confirmCover}
          onOpenChange={setConfirmCover}
          title="¿Quitar la portada?"
          description="Tu perfil público vuelve a mostrarse sin portada. Podés subir otra cuando quieras."
          actionLabel="Quitar portada"
          pending={removingCover}
          onConfirm={() => {
            setConfirmCover(false);
            void onRemoveCover();
          }}
        />

        {/* Identidad: avatar (con upload) + nombre + email */}
        <div className="absolute inset-x-0 bottom-0 flex flex-col gap-4 p-4 sm:p-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex min-w-0 items-center gap-4">
          <div className="group relative shrink-0">
            {/* Mismo avatar que los «Creadores» de Comunidad: aro del color de fondo y aro dorado por fuera */}
            <span className="block rounded-full" aria-hidden>
              <AuthAvatar
                src={user.avatarUrl}
                name={user.name}
                className="size-20 border-0 shadow-[0_0_0_4px_var(--background),0_0_0_6.5px_var(--m-gold)] sm:size-24"
                fallbackClassName="bg-surface text-[22px] text-foreground sm:text-[26px] dark:text-foreground"
              />
            </span>
            <button
              type="button"
              onClick={() => avatarInput.current?.click()}
              disabled={uploadingAvatar}
              aria-label="Cambiar tu foto de perfil"
              className="absolute inset-0 flex cursor-pointer items-center justify-center rounded-full bg-black/60 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 disabled:cursor-wait"
            >
              {uploadingAvatar ? (
                <Loader2 className="h-6 w-6 animate-spin text-white" aria-hidden />
              ) : (
                <Camera className="h-6 w-6 text-white" aria-hidden />
              )}
            </button>
            <input ref={avatarInput} type="file" accept="image/*" className="hidden" onChange={onAvatarFile} aria-label="Subir foto de perfil" />
          </div>
          <div className="min-w-0">
            <h2 className="truncate font-display text-2xl font-extrabold tracking-tight text-white drop-shadow sm:text-4xl">{user.name}</h2>
            <p className="truncate text-[15px] font-semibold text-white/90">{user.email}</p>
            <p className="mt-0.5 text-[13px] text-white/65">Miembro desde {fmtDate(user.createdAt)}</p>
          </div>
          </div>

          {/* Fichas y plan, a la derecha */}
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Badge variant="outline" className="h-8 gap-1.5 border-[1.5px] border-white/40 bg-black/45 px-3 text-[13px] text-white backdrop-blur-sm">
              <CoinIcon className="h-3.5 w-3.5 text-[var(--m-gold)]" aria-hidden /> {balance.toLocaleString('es-AR')} fichas
            </Badge>
            {(user.effectivePlan ?? user.subscription?.plan) && (
              <Badge variant="outline" className="h-8 gap-1.5 border-[1.5px] border-white/40 bg-black/45 px-3 text-[13px] text-white backdrop-blur-sm">
                <Crown className="h-3.5 w-3.5 text-[var(--m-gold)]" aria-hidden /> Plan {(user.effectivePlan ?? user.subscription!.plan).name}
              </Badge>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

/* ── Tab Perfil: datos + géneros + bio pública + autorización de voz ── */
const MAX_GENRES = 5;

function ProfileTab({ user }: { user: MeProfile }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState(user.name);
  const [bio, setBio] = useState(user.bio ?? '');
  /* v0.19 — géneros musicales (hasta 5): chips rápidos al crear canciones. */
  const [genres, setGenres] = useState<string[]>(user.genres ?? []);
  const [genreInput, setGenreInput] = useState('');
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);

  const genreExists = (g: string) => genres.some((x) => x.toLowerCase() === g.toLowerCase());
  const canAddGenre = genres.length < MAX_GENRES;

  const addGenre = (raw: string) => {
    const g = raw.trim().slice(0, 40);
    if (!g || !canAddGenre || genreExists(g)) {
      setGenreInput('');
      return;
    }
    setGenres([...genres, g]);
    setGenreInput('');
  };

  const removeGenre = (g: string) => setGenres(genres.filter((x) => x !== g));

  const saveMutation = useMutation({
    mutationFn: () =>
      profileApi.update({
        name: name.trim(),
        bio: bio.trim() || null,
        genres, // hasta 5; [] limpia
      }),
    onSuccess: async () => {
      await useAuthStore.getState().loadMe();
      void qc.invalidateQueries({ queryKey: ['me'] });
      toast({ title: 'Perfil actualizado', description: 'Tus datos ya están en Melodya.' });
    },
    onError: (err) => toast({ title: 'No pudimos guardar los cambios', description: toUserMessage(err), variant: 'destructive' }),
  });

  const consentMutation = useMutation({
    mutationFn: () => profileApi.acceptVoiceConsent(VOICE_CONSENT_VERSION),
    onSuccess: async () => {
      await useAuthStore.getState().loadMe();
      void qc.invalidateQueries({ queryKey: ['me'] });
      setConsentOpen(false);
      setConsentChecked(false);
      toast({ title: 'Autorización registrada', description: 'Ya podés subir muestras de tu voz y clonarla para tus canciones.' });
    },
    onError: (err) => toast({ title: 'No pudimos registrar la autorización', description: toUserMessage(err), variant: 'destructive' }),
  });

  const nameChanged = name.trim() !== user.name && name.trim().length >= 2;
  const bioChanged = (bio.trim() || null) !== (user.bio ?? null);
  const genresChanged = JSON.stringify(genres) !== JSON.stringify(user.genres ?? []);
  const formDirty = nameChanged || bioChanged || genresChanged;
  const consentAccepted = !!user.voiceConsentAcceptedAt;

  return (
    <div className="space-y-4">
      {/* Datos */}
      <Card className={CARD}>
        <CardContent className="p-5 sm:p-6">
          <CardHeading icon={User}>Tus datos</CardHeading>
          <div className="mt-4 grid gap-5">
            <div className="grid gap-2">
              <Label htmlFor="profile-name" className="text-[13px] font-bold">Nombre</Label>
              <Input
                id="profile-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                autoComplete="name"
                placeholder="Cómo querés que te llamemos"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="profile-email" className="text-[13px] font-bold">Email</Label>
              <Input id="profile-email" value={user.email} readOnly className="text-muted-foreground" />
              <p className="text-xs text-muted-foreground">El email no se puede cambiar.</p>
            </div>
            {/* v0.19 — géneros musicales (hasta 5): input + Añadir → chips removibles */}
            <div className="grid gap-2">
              <div className="flex items-baseline justify-between gap-2">
                <Label htmlFor="profile-genre" className="text-[13px] font-bold">Géneros musicales</Label>
                <span
                  className={cn(
                    'text-xs tabular-nums',
                    genres.length >= MAX_GENRES ? 'font-bold text-label' : 'text-muted-foreground'
                  )}
                  aria-live="polite"
                >
                  {genres.length}/{MAX_GENRES}
                </span>
              </div>
              <div className="flex gap-2">
                <div className="relative min-w-0 flex-1">
                  <Music2 className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                  <Input
                    id="profile-genre"
                    value={genreInput}
                    onChange={(e) => setGenreInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return;
                      e.preventDefault(); // Enter añade el género, no envía nada
                      addGenre(genreInput);
                    }}
                    maxLength={40}
                    disabled={!canAddGenre}
                    placeholder={canAddGenre ? 'Ej.: rock, cumbia, trap…' : 'Ya tenés 5: quitá uno para cambiar'}
                    aria-describedby="profile-genres-hint"
                    className="pl-11 pr-4 disabled:opacity-60"
                  />
                </div>
                <Button
                  type="button"
                  onClick={() => addGenre(genreInput)}
                  disabled={!canAddGenre || genreInput.trim().length === 0 || genreExists(genreInput)}
                  variant="outline"
                  className="shrink-0 h-14 rounded-full border-[1.5px] border-primary bg-primary px-5 text-sm font-bold text-[#131C33] hover:border-primary hover:bg-primary hover:text-[#131C33] hover:brightness-95"
                >
                  <Plus className="h-4 w-4" aria-hidden />
                  Añadir
                </Button>
              </div>
              {genres.length > 0 && (
                <ul className="flex flex-wrap gap-2 pt-0.5" aria-label="Tus géneros musicales">
                  {genres.map((g) => (
                    /* Mismo chip que «Agregados por vos» del panel de Estilo (Crear): elegido, con la X para quitarlo */
                    <li key={g}>
                      <Chip active onClick={() => removeGenre(g)}>
                        <span>{g}</span>
                        <X className="h-3.5 w-3.5" aria-hidden />
                        <span className="sr-only">Quitar el género {g}</span>
                      </Chip>
                    </li>
                  ))}
                </ul>
              )}
              <p id="profile-genres-hint" className="text-xs text-muted-foreground">
                Hasta {MAX_GENRES}. Te los ofrecemos como chips rápidos cuando creás una canción, y se ven en tu perfil público.
              </p>
            </div>
            <div className="grid gap-2">
              <div className="flex items-baseline justify-between gap-2">
                <Label htmlFor="profile-bio" className="text-[13px] font-bold">Bio pública</Label>
                <span className="text-xs tabular-nums text-muted-foreground" aria-live="polite">
                  {bio.length}/500
                </span>
              </div>
              {/* Mismo lienzo que «Tu idea» de Crear: borrar el texto y ampliarlo a pantalla completa */}
              <ExpandableLyrics
                id="profile-bio"
                plain
                value={bio}
                onChange={setBio}
                maxLength={500}
                placeholder="Contale a la comunidad qué música hacés…"
                heightClass="h-[110px]"
                modalTitle="Bio pública"
                ariaLabel="Bio pública"
              />
              <p id="profile-bio-hint" className="text-xs text-muted-foreground">
                Se muestra en tu perfil público de la comunidad. Dejarla vacía la quita.
              </p>
            </div>
            <div className="flex justify-center">
              <Button
                onClick={() => saveMutation.mutate()}
                disabled={!formDirty || saveMutation.isPending}
                className="rounded-full gradient-warm text-primary-foreground hover:text-primary-foreground"
              >
                {saveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
                Guardar cambios
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Autorización de uso de voz */}
      <Card className={CARD}>
        <CardContent className="p-5 sm:p-6">
          <div className="flex items-start gap-4">
            <div className="min-w-0">
              <CardHeading icon={AudioLines} tone="sound">Autorización de uso de voz</CardHeading>
              {!consentAccepted ? (
                <>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    Para subir muestras de tu voz y crear una versión sintética que cante tus canciones, necesitamos tu
                    autorización explícita. Es tu voz: vos decidís qué pasa con ella y podés revocarla cuando quieras.
                  </p>
                  <Button
                    variant="outline"
                    className={cn(OUTLINE_BTN, 'mt-4')}
                    onClick={() => setConsentOpen(true)}
                  >
                    Leer y aceptar
                  </Button>
                </>
              ) : (
                <p className="mt-2 flex flex-wrap items-center gap-1.5 text-sm font-semibold text-success">
                  <CheckCircle2 className="h-4.5 w-4.5" aria-hidden />
                  Aceptada el {fmtDate(user.voiceConsentAcceptedAt)} (versión {user.voiceConsentVersion ?? VOICE_CONSENT_VERSION})
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Dialog de consentimiento */}
      <Dialog open={consentOpen} onOpenChange={setConsentOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-display">Autorización de uso de voz</DialogTitle>
            <DialogDescription>Leé con calma: es corto y está en cristiano.</DialogDescription>
          </DialogHeader>
          <div className="max-h-72 space-y-3 overflow-y-auto rounded-[20px_20px_6px_6px] border-[1.5px] border-line bg-[var(--m-input)] p-4 text-sm leading-relaxed text-foreground/90">
            {VOICE_CONSENT_PARAGRAPHS.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
            <p className="text-xs text-muted-foreground">Versión {VOICE_CONSENT_VERSION}</p>
          </div>
          <div className="flex items-start gap-3">
            <Checkbox
              id="voice-consent-checkbox"
              checked={consentChecked}
              onCheckedChange={(v) => setConsentChecked(v === true)}
              aria-label="Acepto la autorización de uso de voz"
            />
            <Label htmlFor="voice-consent-checkbox" className="text-sm font-normal leading-snug text-foreground">
              Acepto la autorización de uso de voz
            </Label>
          </div>
          <DialogFooter>
            <Button variant="outline" className={OUTLINE_BTN} onClick={() => setConsentOpen(false)}>
              Cancelar
            </Button>
            <Button
              onClick={() => consentMutation.mutate()}
              disabled={!consentChecked || consentMutation.isPending}
              className="rounded-full gradient-warm text-primary-foreground hover:text-primary-foreground"
            >
              {consentMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <ShieldCheck className="h-4 w-4" aria-hidden />
              )}
              Confirmar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* Campo de contraseña con el ojo para verla u ocultarla (como en «Cambiar contraseña» del diseño). */
function PasswordInput({ className, ...props }: Omit<React.ComponentProps<typeof Input>, 'type'>) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input {...props} type={visible ? 'text' : 'password'} className={cn('pr-14', className)} />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'}
        title={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'}
        className="absolute top-1/2 right-2 flex size-10 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full text-foreground transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-foreground"
      >
        {visible ? <EyeOff className="h-5 w-5" aria-hidden /> : <Eye className="h-5 w-5" aria-hidden />}
      </button>
    </div>
  );
}

/* ── Tab Seguridad: contraseña + sesiones ── */
function SecurityTab() {
  const { toast } = useToast();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  const changeMutation = useMutation({
    mutationFn: () => useAuthStore.getState().changePassword(currentPassword, newPassword),
    onSuccess: ({ sessionRenewed }) => {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setValidationError(null);
      toast(
        sessionRenewed
          ? { title: 'Contraseña actualizada', description: 'Cerramos tu sesión en los demás dispositivos. Acá seguís conectado.' }
          : { title: 'Contraseña actualizada', description: 'Por seguridad se cerraron todas las sesiones: ingresá con tu contraseña nueva.' },
      );
    },
    onError: (err) => toast({ title: 'No pudimos cambiar tu contraseña', description: toUserMessage(err), variant: 'destructive' }),
  });

  const logoutAllMutation = useMutation({
    mutationFn: () => authApi.logoutAll(),
    onSuccess: async () => {
      await useAuthStore.getState().logout(); // limpia el estado local (logout normal best-effort)
      navigate('/');
      toast({ title: 'Sesiones cerradas', description: 'Cerraste tu sesión en todos los dispositivos.' });
    },
    onError: (err) => toast({ title: 'No pudimos cerrar las sesiones', description: toUserMessage(err), variant: 'destructive' }),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 8 || !/[a-zA-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      setValidationError('La contraseña nueva necesita al menos 8 caracteres, con letras y números.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setValidationError('Las contraseñas nuevas no coinciden.');
      return;
    }
    setValidationError(null);
    changeMutation.mutate();
  };

  return (
    <div className="space-y-4">
      <Card className={CARD}>
        <CardContent className="p-5 sm:p-6">
          <CardHeading icon={KeyRound}>Cambiar contraseña</CardHeading>
          <form onSubmit={submit} noValidate className="mt-4 grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="current-password" className="text-[13px] font-bold">Contraseña actual</Label>
              <PasswordInput
                id="current-password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="new-password" className="text-[13px] font-bold">Contraseña nueva</Label>
              <PasswordInput
                id="new-password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                aria-invalid={!!validationError}
                required
              />
              <p className="text-xs text-muted-foreground">Mínimo 8 caracteres, con letras y números.</p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="confirm-password" className="text-[13px] font-bold">Confirmá la contraseña nueva</Label>
              <PasswordInput
                id="confirm-password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                aria-invalid={!!validationError}
                required
              />
            </div>
            {validationError && (
              <p role="alert" className="text-sm text-destructive">
                {validationError}
              </p>
            )}
            <div className="flex justify-center">
              <Button
                type="submit"
                disabled={changeMutation.isPending || !currentPassword || !newPassword || !confirmPassword}
                className="rounded-full gradient-warm text-primary-foreground hover:text-primary-foreground"
              >
                {changeMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <KeyRound className="h-4 w-4" aria-hidden />}
                Cambiar contraseña
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card className={CARD}>
        <CardContent className="p-5 sm:p-6">
          <CardHeading icon={MonitorSmartphone}>Sesiones abiertas</CardHeading>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            ¿Entraste desde otro dispositivo y no querés dejarlo activo? Cerrá tu sesión en todos lados de una vez.
          </p>
          <div className="mt-4 flex justify-center">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="outline"
                  className="h-auto min-h-11 max-w-full rounded-full border-[1.5px] border-destructive py-2.5 text-left whitespace-normal text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <LogOut className="h-4 w-4" aria-hidden /> Cerrar sesión en todos los dispositivos
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle className="font-display">¿Cerrar sesión en todos lados?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Se cierra tu sesión en este navegador y en cualquier otro dispositivo donde hayas ingresado. Vas a tener
                    que volver a iniciar sesión.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel className={OUTLINE_BTN}>Cancelar</AlertDialogCancel>
                  <AlertDialogAction
                    className="rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
                    onClick={(e) => {
                      e.preventDefault(); // mantener el dialog abierto mientras viaja el request
                      logoutAllMutation.mutate();
                    }}
                  >
                    {logoutAllMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                    Cerrar todo
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/* ── Tab Mi actividad: el historial de fichas (compras, generaciones y devoluciones) con las generaciones integradas + link a fichas ── */
function ActivityTab() {
  return (
    <div className="space-y-4">
      <ActivityHistory
        footer={
          /* Como el chip de fichas de «Perfil» del diseño: píldora voice con la monedita dorada */
          <Button
            className="h-11 gap-2 rounded-[22px] bg-voice px-[18px] text-[15px] font-bold tracking-[0.02em] text-on-voice hover:bg-voice/90"
            onClick={() => navigate('/plans')}
          >
            <CoinIcon className="size-[18px] text-[var(--m-gold)]" aria-hidden /> Ver fichas
          </Button>
        }
      />
    </div>
  );
}

/* ── Tab Comunidad: a quién seguís, quién te sigue, bloqueados ──
 * Contrato real (v0.15): GET /community/users/:id/follows|followers +
 * GET /users/me/blocks · POST|DELETE /users/:id/follow y /users/:id/block. */
function CommunityTab({ user }: { user: MeProfile }) {
  const followsQuery = useQuery({
    queryKey: ['community', 'my-follows'],
    queryFn: () => communityApi.userFollows(user.id, { limit: 50 }),
  });
  const followersQuery = useQuery({
    queryKey: ['community', 'my-followers'],
    queryFn: () => communityApi.userFollowers(user.id),
  });
  const blocksQuery = useQuery({
    queryKey: ['community', 'my-blocks'],
    queryFn: () => profileApi.blocks(),
  });

  const follows = followsQuery.data?.items ?? [];
  const followers = followersQuery.data?.items ?? [];
  const blocks = blocksQuery.data?.items ?? [];
  const [sub, setSub] = useState<'follows' | 'followers' | 'blocks'>('follows');
  const total = (q: { data?: { items: unknown[]; pagination?: { total: number } } }) =>
    q.data ? (q.data.pagination?.total ?? q.data.items.length) : undefined;

  return (
    <div className="space-y-4">
      {/* Selector de grupo como el del diseño: Seguís / Te siguen / Bloqueados, con su cantidad */}
      <SegmentedTabs
        ariaLabel="Ver comunidad"
        variant="trash"
        value={sub}
        onChange={setSub}
        tabs={[
          { key: 'follows', label: 'Seguís', icon: UserPlus, count: total(followsQuery) },
          { key: 'followers', label: 'Te siguen', icon: Users, count: total(followersQuery) },
          { key: 'blocks', label: 'Bloqueados', icon: Ban, count: total(blocksQuery) },
        ]}
      />

      {/* A quién seguís */}
      {sub === 'follows' && (
      <Card className={CARD}>
        <CardContent className="p-5">
          <CardHeading icon={UserPlus}>A quién seguís</CardHeading>
          <p className="mt-2 text-[15.5px] leading-[1.5] text-[var(--m-foreground-secondary)]">
            Los creadores cuyo contenido querés ver primero en la comunidad.
          </p>
          <div className="mt-3.5">
            {followsQuery.isLoading ? (
              <LoadingRows count={3} />
            ) : followsQuery.isError ? (
              <ErrorState
                message={toUserMessage(followsQuery.error, 'No pudimos cargar a quién seguís.')}
                onRetry={() => void followsQuery.refetch()}
                className="py-6"
              />
            ) : follows.length === 0 ? (
              <DashedEmpty
                icon={<UserPlus className="h-6 w-6" />}
                title="Todavía no seguís a nadie"
                description="Andá a la comunidad, escuchá lo que están creando y seguí a quien te guste."
                actionLabel="Explorar la comunidad"
                actionTo="/community"
              />
            ) : (
              <ul className="divide-y divide-[var(--m-separator)]" aria-label="Creadores que seguís">
                {follows.map((row) => (
                  <FollowsRow key={row.id} row={row} />
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>
      )}

      {/* Quién te sigue */}
      {sub === 'followers' && (
      <Card className={CARD}>
        <CardContent className="p-5">
          <CardHeading icon={Users}>Quién te sigue</CardHeading>
          <p className="mt-2 text-[15.5px] leading-[1.5] text-[var(--m-foreground-secondary)]">
            Dejá el gesto devuelto: seguilos con un toque para no perderte lo que publican.
          </p>
          <div className="mt-3.5">
            {followersQuery.isLoading ? (
              <LoadingRows count={3} />
            ) : followersQuery.isError ? (
              <ErrorState
                message={toUserMessage(followersQuery.error, 'No pudimos cargar quién te sigue.')}
                onRetry={() => void followersQuery.refetch()}
                className="py-6"
              />
            ) : followers.length === 0 ? (
              <DashedEmpty
                icon={<Users className="h-6 w-6" />}
                title="Todavía no te sigue nadie"
                description="Publicá tus canciones y compartilas: cuando alguien te siga, lo vas a ver acá."
                actionLabel="Explorar la comunidad"
                actionTo="/community"
              />
            ) : (
              <ul className="divide-y divide-[var(--m-separator)]" aria-label="Creadores que te siguen">
                {followers.map((row) => (
                  <FollowersRow key={row.id} row={row} />
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>
      )}

      {/* Bloqueados */}
      {sub === 'blocks' && (
      <Card className={CARD}>
        <CardContent className="p-5">
          <CardHeading icon={Ban}>Bloqueados</CardHeading>
          <p className="mt-2 text-[15.5px] leading-[1.5] text-[var(--m-foreground-secondary)]">
            Las personas bloqueadas no ven tu contenido ni pueden seguirte, y vos no ves el suyo.
          </p>
          <div className="mt-3.5">
            {blocksQuery.isLoading ? (
              <LoadingRows count={2} />
            ) : blocksQuery.isError ? (
              <ErrorState
                message={toUserMessage(blocksQuery.error, 'No pudimos cargar tus bloqueos.')}
                onRetry={() => void blocksQuery.refetch()}
                className="py-6"
              />
            ) : blocks.length === 0 ? (
              <DashedEmpty
                icon={<Ban className="h-6 w-6" />}
                title="No bloqueaste a nadie"
                description="Si alguien te molesta en la comunidad, podés bloquearlo desde su perfil público."
              />
            ) : (
              <ul className="divide-y divide-[var(--m-separator)]" aria-label="Personas bloqueadas">
                {blocks.map((row) => (
                  <BlockedRow key={row.id} row={row} />
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>
      )}
    </div>
  );
}

/** Fila base: avatar + nombre (link al perfil público) + acción a la derecha. */
function CommunityRow({
  row, meta, action,
}: {
  row: CommunityUserCard;
  meta?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <li className="flex min-h-[72px] items-center gap-2 py-3 sm:gap-3.5">
      <button
        type="button"
        onClick={() => navigate(`/user/${row.id}`)}
        aria-label={`Ver el perfil de ${row.name}`}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-full p-1 pr-3 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <AuthAvatar src={row.avatarUrl} name={row.name} className="size-12 shrink-0 border-0 ring-2 ring-[var(--m-gold)] ring-offset-2 ring-offset-[var(--m-input)]" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-bold leading-tight text-foreground">{row.name}</span>
          {meta ? <span className="block text-[13px] text-muted-foreground">{meta}</span> : null}
        </span>
      </button>
      {action}
    </li>
  );
}

/** Fila de "A quién seguís": dejar de seguir con confirmación implícita. */
function FollowsRow({ row }: { row: CommunityUserCard }) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const unfollowMutation = useMutation({
    mutationFn: () => profileApi.unfollow(row.id),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: ['community', 'my-follows'] });
      const prev = qc.getQueryData<Paginated<CommunityUserCard>>(['community', 'my-follows']);
      qc.setQueryData<Paginated<CommunityUserCard>>(['community', 'my-follows'], (old) =>
        old ? { ...old, items: old.items.filter((it) => it.id !== row.id) } : old
      );
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(['community', 'my-follows'], ctx.prev);
      toast({ title: 'No pudimos dejar de seguir', description: toUserMessage(err), variant: 'destructive' });
    },
    onSuccess: () => {
      toast({ title: `Dejaste de seguir a ${row.name}`, description: 'Su contenido deja de aparecer en el feed de seguidos.' });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['community'] });
    },
  });

  return (
    <CommunityRow
      row={row}
      meta={`${formatNumber(row.followersCount ?? 0)} seguidores`}
      action={
        /* Pide confirmación antes de dejar de seguir */
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={unfollowMutation.isPending}
              aria-label={`Dejar de seguir a ${row.name}`}
              className="shrink-0 rounded-full px-3 text-[15px] font-bold text-[var(--m-foreground-secondary)] transition-colors hover:bg-destructive/10 hover:text-destructive"
            >
              {unfollowMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <UserMinus className="h-4 w-4" aria-hidden />
              )}
              <span className="max-[420px]:sr-only">Dejar de seguir</span>
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="font-display">¿Dejar de seguir a {row.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                Su contenido deja de aparecer en tu feed de seguidos. Podés volver a seguirlo cuando quieras desde su perfil.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className={OUTLINE_BTN}>Cancelar</AlertDialogCancel>
              <AlertDialogAction
                className="rounded-full max-sm:text-[12px]! bg-primary text-primary-foreground hover:bg-primary/90"
                onClick={() => unfollowMutation.mutate()}
              >
                Dejar de seguir
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      }
    />
  );
}

/** Fila de "Quién te sigue": reciprocar rápido con un Seguir. */
function FollowersRow({ row }: { row: CommunityUserCard }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const following = Boolean(row.viewerIsFollowing);

  const followMutation = useMutation({
    mutationFn: () => profileApi.follow(row.id),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: ['community', 'my-followers'] });
      const prev = qc.getQueryData<Paginated<CommunityUserCard>>(['community', 'my-followers']);
      qc.setQueryData<Paginated<CommunityUserCard>>(['community', 'my-followers'], (old) =>
        old
          ? { ...old, items: old.items.map((it) => (it.id === row.id ? { ...it, viewerIsFollowing: true } : it)) }
          : old
      );
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(['community', 'my-followers'], ctx.prev);
      toast({ title: 'No pudimos seguir', description: toUserMessage(err), variant: 'destructive' });
    },
    onSuccess: () => {
      toast({ title: `Ahora seguís a ${row.name}` });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['community'] });
    },
  });

  if (following) {
    return (
      <CommunityRow
        row={row}
        meta={`${formatNumber(row.followersCount ?? 0)} seguidores`}
      />
    );
  }

  return (
    <CommunityRow
      row={row}
      meta={`${formatNumber(row.followersCount ?? 0)} seguidores`}
      action={
        <Button
          variant="outline"
          size="sm"
          disabled={followMutation.isPending}
          aria-label={`Seguir a ${row.name}`}
          onClick={() => followMutation.mutate()}
          className="shrink-0 rounded-full border-[1.5px] border-line px-5 text-foreground hover:bg-accent"
        >
          {followMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <UserPlus className="h-4 w-4" aria-hidden />
          )}
          Seguir
        </Button>
      }
    />
  );
}

/** Fila de "Bloqueados": desbloquear (restaura la visibilidad mutua). */
function BlockedRow({ row }: { row: CommunityUserCard }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const unblockMutation = useMutation({
    mutationFn: () => profileApi.unblock(row.id),
    onSuccess: () => {
      toast({
        title: `Desbloqueaste a ${row.name}`,
        description: 'Ya pueden verse el contenido y seguirse otra vez.',
      });
    },
    onError: (err) => {
      toast({ title: 'No pudimos desbloquear', description: toUserMessage(err), variant: 'destructive' });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['community', 'my-blocks'] });
      void qc.invalidateQueries({ queryKey: ['community'] });
    },
  });

  return (
    <CommunityRow
      row={row}
      action={
        <>
        <Button
          variant="ghost"
          size="sm"
          disabled={unblockMutation.isPending}
          aria-label={`Desbloquear a ${row.name}`}
          onClick={() => setConfirmOpen(true)}
          className="shrink-0 rounded-full px-3 text-[15px] font-bold text-[var(--m-foreground-secondary)] transition-colors hover:bg-accent hover:text-foreground"
        >
          {unblockMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Unlock className="h-4 w-4" aria-hidden />
          )}
          <span className="max-[420px]:sr-only">Desbloquear</span>
        </Button>
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title={`¿Desbloquear a ${row.name}?`}
          description="Van a poder verse el contenido y seguirse otra vez."
          actionLabel="Desbloquear"
          pending={unblockMutation.isPending}
          onConfirm={() => {
            setConfirmOpen(false);
            unblockMutation.mutate();
          }}
        />
        </>
      }
    />
  );
}

/* ── Tab Configuración ──
 * CLIENT-ONLY: estas preferencias viven en el localStorage de este navegador.
 * El backend no tiene endpoints de preferencias (BACKEND GAP, audit §15) — no inventamos. */
const PREF_NOTIFICATIONS = 'melodya.prefs.notifications';
const PREF_AUTOPLAY = 'melodya.prefs.autoplay';

function useLocalPref(key: string, defaultValue: boolean) {
  // Lazy initializer: lectura pura de localStorage en el primer render (esta vista
  // vive bajo el hash-router, nunca se renderiza en el servidor; guard igualmente).
  const [value, setValue] = useState(() => {
    if (typeof window === 'undefined') return defaultValue;
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? defaultValue : raw === '1';
    } catch {
      return defaultValue;
    }
  });
  const update = (v: boolean) => {
    setValue(v);
    try {
      window.localStorage.setItem(key, v ? '1' : '0');
    } catch {
      /* best-effort */
    }
  };
  return [value, update] as const;
}

function SettingsTab() {
  const { toast } = useToast();
  const [loggingOut, setLoggingOut] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [notifications, setNotifications] = useLocalPref(PREF_NOTIFICATIONS, true);
  const [autoplay, setAutoplay] = useLocalPref(PREF_AUTOPLAY, false);

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await useAuthStore.getState().logout(); // authApi.logout + limpia el estado local
      navigate('/');
      toast({ title: 'Sesión cerrada', description: '¡Volvé cuando quieras!' });
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Preferencias (solo este navegador): mismo contenedor que «Publicación» de una canción propia */}
      <Card className="h-fit rounded-cover border-border/70 bg-surface" aria-label="Preferencias">
        <CardHeader className="pb-0">
          <CardTitle className="flex items-center gap-2 font-display text-lg font-bold">
            <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-gold text-on-gold">
              <Settings2 className="h-4 w-4" />
            </span>{' '}
            Preferencias
          </CardTitle>
        </CardHeader>
        <CardContent className="-mt-2 flex flex-col gap-0.5 pt-0">
          <label htmlFor="pref-notifications" className="flex min-h-10 w-full cursor-pointer items-center gap-3 py-1">
            <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
              <b className="text-[15px] font-bold">Notificaciones de generaciones</b>
              <span className="text-xs leading-relaxed text-muted-foreground">
                Avisos en pantalla cuando una generación termina o falla (afecta los toasts).
              </span>
            </span>
            <Switch
              id="pref-notifications"
              checked={notifications}
              onCheckedChange={setNotifications}
              aria-label="Notificaciones de generaciones"
              className="data-[state=checked]:border-gold data-[state=checked]:bg-gold dark:data-[state=checked]:[&>span]:bg-[#131C33]"
            />
          </label>
          <label htmlFor="pref-autoplay" className="flex min-h-10 w-full cursor-pointer items-center gap-3 py-1">
            <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
              <b className="text-[15px] font-bold">Reproducción automática</b>
              <span className="text-xs leading-relaxed text-muted-foreground">Reproducir la canción apenas termina de generarse.</span>
            </span>
            <Switch
              id="pref-autoplay"
              checked={autoplay}
              onCheckedChange={setAutoplay}
              aria-label="Reproducción automática"
              className="data-[state=checked]:border-gold data-[state=checked]:bg-gold dark:data-[state=checked]:[&>span]:bg-[#131C33]"
            />
          </label>
          <p className="pt-3 text-[13px] font-medium text-gold">Estas preferencias se guardan solo en este navegador.</p>
        </CardContent>
      </Card>

      {/* Sesión */}
      <Card className={CARD}>
        <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:p-6 sm:items-center sm:justify-between">
          <div className="min-w-0">
            <CardHeading icon={LogOut}>Cerrar sesión</CardHeading>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              Salís de tu cuenta en este dispositivo. Tus canciones quedan guardadas.
            </p>
          </div>
          <Button className="shrink-0 rounded-full" onClick={() => setConfirmLogout(true)} disabled={loggingOut}>
            {loggingOut ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <LogOut className="h-4 w-4" aria-hidden />}
            Cerrar sesión
          </Button>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmLogout}
        onOpenChange={setConfirmLogout}
        title="¿Cerrar sesión?"
        description="Salís de tu cuenta en este dispositivo. Tus canciones quedan guardadas."
        actionLabel="Cerrar sesión"
        pending={loggingOut}
        onConfirm={() => {
          setConfirmLogout(false);
          void handleLogout();
        }}
      />
    </div>
  );
}

export default ProfileView;
