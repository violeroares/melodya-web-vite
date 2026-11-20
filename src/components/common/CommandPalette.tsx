
/**
 * MELODYA WEB — Command palette (Ctrl/⌘+K): "simple por defecto, poderosa
 * cuando la necesitás". CLIENT-ONLY sobre APIs y stores existentes.
 *
 * • Navegación y acciones (reproductor, atajos, sesión) siempre a mano,
 *   filtradas por la consulta (multi-palabra, sin mayúsculas).
 * • "Tus canciones": búsqueda client-side sobre /songs (BACKEND GAP: /songs
 *   no tiene search server-side, documentado en el código de biblioteca).
 * • "Comunidad": búsqueda server-side real (GET /community/songs?search=).
 * • "?" abre el diálogo de atajos de teclado (descubribilidad).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Home, Sparkles, Library, Users, Coins, User, LogIn, LogOut, Keyboard,
  Play, Pause, SkipForward, SkipBack, VolumeX, Volume2, Maximize2, Shuffle,
  Music4, Command as CommandIcon, CornerDownLeft, ArrowUp, ArrowDown, Loader2, Radio, ListMusic,
} from 'lucide-react';
import {
  Command, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator,
} from '@/components/ui/command';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { navigate } from '@/lib/router';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth';
import { usePlayerStore, type PlayerTrack } from '@/stores/player';
import { songsApi, communityApi } from '@/lib/api';
import { apiFileUrl } from '@/lib/api/client';
import { startCommunityRadio, RADIO_SORT_LABELS } from '@/lib/radio';
import { useDebounce } from '@/hooks';
import type { Song, CommunitySong } from '@/types';

const PALETTE_EVENT = 'melodya:open-palette';
export const EXPAND_PLAYER_EVENT = 'melodya:expand-player';
export const OPEN_QUEUE_EVENT = 'melodya:open-queue';

/** Abre la paleta desde cualquier botón (Header, etc.). */
export function openCommandPalette() {
  window.dispatchEvent(new CustomEvent(PALETTE_EVENT));
}

/** Abre la cola de reproducción (sheet del PlayerBar). */
export function openQueueSheet() {
  window.dispatchEvent(new CustomEvent(OPEN_QUEUE_EVENT));
}

/* ── mapeo a PlayerTrack (mismas reglas que biblioteca/community) ── */
function songTrack(s: Song): PlayerTrack | null {
  const audioUrl = apiFileUrl(s.currentVersion?.audioUrl ?? null);
  if (!audioUrl) return null;
  return {
    id: s.id,
    title: s.title,
    artist: 'Vos',
    coverUrl: apiFileUrl(s.coverUrl),
    audioUrl,
    durationSec: s.currentVersion?.durationSec ?? null,
    own: true,
  };
}

function communityTrack(s: CommunitySong): PlayerTrack | null {
  const audioUrl = apiFileUrl(s.audioUrl);
  if (!audioUrl) return null;
  const myId = useAuthStore.getState().user?.id;
  return {
    id: s.id,
    title: s.title,
    artist: s.author.name,
    coverUrl: apiFileUrl(s.coverUrl),
    audioUrl,
    durationSec: s.durationSec,
    isPublic: true,
    own: !!myId && s.author?.id === myId,
    onPlayed: () => {
      void songsApi.registerPlay(s.id); // registro de reproducción (fire and forget)
    },
  };
}

function match(text: string, q: string): boolean {
  if (!q) return true;
  const t = text.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => t.includes(word));
}

/* Indicador de tecla de los atajos («?», «Q»): círculo de borde fino, en el mismo lenguaje que los íconos de las filas */
function KeyHint({ children }: { children: React.ReactNode }) {
  return (
    <span
      aria-hidden
      className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-full border-[1.5px] border-line font-display text-xs leading-none font-bold text-foreground"
    >
      {children}
    </span>
  );
}

/* ── Diálogo de atajos de teclado ("?") ── */
const SHORTCUTS: Array<{ keys: string[]; label: string }> = [
  { keys: ['Ctrl', 'K'], label: 'Abrir la búsqueda rápida' },
  { keys: ['?'], label: 'Ver estos atajos' },
  { keys: ['Espacio'], label: 'Reproducir / pausar' },
  { keys: ['←', '→'], label: 'Retroceder / avanzar 5 segundos' },
  { keys: ['N'], label: 'Canción siguiente' },
  { keys: ['P'], label: 'Canción anterior' },
  { keys: ['M'], label: 'Silenciar / activar sonido' },
  { keys: ['Esc'], label: 'Cerrar el reproductor expandido o cualquier diálogo' },
];

function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md rounded-[28px_28px_14px_14px] border-border/70 bg-surface/95 p-0">
        <DialogHeader className="sr-only">
          <DialogTitle>Atajos de teclado</DialogTitle>
          <DialogDescription>Lista de atajos de teclado de Melodya.</DialogDescription>
        </DialogHeader>
        <div className="grid-music px-6 pt-6 pb-2">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-full gradient-warm text-primary-foreground">
              <Keyboard className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <h2 className="font-display text-lg font-bold">Atajos de teclado</h2>
              <p className="text-xs text-muted-foreground">Manejá Melodya sin sacar las manos del teclado.</p>
            </div>
          </div>
        </div>
        <ul className="px-6 pb-6">
          {SHORTCUTS.map((s) => (
            <li key={s.label} className="flex items-center justify-between gap-4 border-b border-border/50 py-2.5 last:border-0">
              <span className="text-sm text-foreground/90">{s.label}</span>
              <span className="flex shrink-0 items-center gap-1" aria-hidden>
                {s.keys.map((k) => (
                  <kbd key={k} className="kbd">
                    {k}
                  </kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const debounced = useDebounce(query, 300);
  const user = useAuthStore((s) => s.user);
  const status = useAuthStore((s) => s.status);
  const logout = useAuthStore((s) => s.logout);
  const track = usePlayerStore((s) => s.track);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const play = usePlayerStore((s) => s.play);
  const toggle = usePlayerStore((s) => s.toggle);
  const next = usePlayerStore((s) => s.next);
  const prev = usePlayerStore((s) => s.prev);
  const toggleMute = usePlayerStore((s) => s.toggleMute);
  const muted = usePlayerStore((s) => s.muted);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);

  const authed = status === 'authenticated' && !!user;

  /* Apertura: Ctrl/⌘+K (toggle), "/" (búsqueda), evento de botones y "?" para atajos. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as Partial<HTMLElement> | null;
      // `t` puede ser `document` (eventos sintéticos): acceso defensivo.
      const typing =
        !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable === true || t.getAttribute?.('role') === 'textbox');
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyK') {
        e.preventDefault();
        setOpen((v) => !v);
        setQuery('');
      } else if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setOpen(true);
        setQuery('');
      } else if (e.key === '?' && !typing) {
        e.preventDefault();
        setShortcutsOpen(true);
      }
    };
    const onOpen = () => {
      setOpen(true);
      setQuery('');
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener(PALETTE_EVENT, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(PALETTE_EVENT, onOpen);
    };
  }, []);

  /* Al abrir: foco en el input (cmdk-input). La consulta se limpia al cerrar. */
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      document.querySelector<HTMLInputElement>('[cmdk-input]')?.focus();
    }, 40);
    return () => clearTimeout(t);
  }, [open]);

  const handleOpenChange = (v: boolean) => {
    setOpen(v);
    if (!v) setQuery('');
  };

  /* Tus canciones (búsqueda client-side: /songs sin search — BACKEND GAP). */
  const { data: mySongs } = useQuery({
    queryKey: ['songs', 'palette'],
    queryFn: () => songsApi.list({ page: 1, pageSize: 50 }),
    enabled: open && authed,
    staleTime: 30_000,
  });

  /* Comunidad: búsqueda server-side real (?search=). */
  const { data: communityResults, isLoading: communityLoading } = useQuery({
    queryKey: ['community', 'palette', debounced],
    queryFn: () => communityApi.feed({ search: debounced || undefined, limit: 6, sort: 'newest' }),
    enabled: open && debounced.trim().length >= 2,
    staleTime: 15_000,
  });

  const mySongItems = useMemo(() => {
    if (!authed || !mySongs?.items) return [];
    return mySongs.items
      .map(songTrack)
      .filter((t): t is PlayerTrack => !!t)
      .filter((t) => match(t.title, query))
      .slice(0, 6);
  }, [authed, mySongs, query]);

  const communityItems = useMemo(() => {
    if (!communityResults?.items || debounced.trim().length < 2) return [];
    return communityResults.items
      .map(communityTrack)
      .filter((t): t is PlayerTrack => !!t)
      .slice(0, 6);
  }, [communityResults, debounced]);

  const run = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  const playFrom = (t: PlayerTrack, queue: PlayerTrack[]) => run(() => play(t, queue));

  /* Navegación filtrada por la consulta (multi-palabra). */
  const navItems = useMemo(() => {
    const items: Array<{ icon: React.ReactNode; label: string; to: string; danger?: boolean }> = [
      { icon: <Home className="h-4 w-4" aria-hidden />, label: 'Inicio', to: '/' },
      { icon: <Users className="h-4 w-4" aria-hidden />, label: 'Comunidad', to: '/community' },
      { icon: <Coins className="h-4 w-4" aria-hidden />, label: 'Planes y fichas', to: '/plans' },
    ];
    if (authed) {
      items.push(
        { icon: <Sparkles className="h-4 w-4" aria-hidden />, label: 'Crear canción', to: '/create' },
        { icon: <Library className="h-4 w-4" aria-hidden />, label: 'Biblioteca', to: '/library/songs' },
        { icon: <User className="h-4 w-4" aria-hidden />, label: 'Mi perfil', to: '/profile' }
      );
    } else {
      items.push(
        { icon: <LogIn className="h-4 w-4" aria-hidden />, label: 'Ingresar', to: '/login' },
        { icon: <Sparkles className="h-4 w-4" aria-hidden />, label: 'Crear cuenta gratis', to: '/register' }
      );
    }
    return items.filter((i) => match(i.label, query));
  }, [authed, query]);

  const playerItems = useMemo(() => {
    if (!track) return [] as Array<{ icon: React.ReactNode; label: string; hint?: string; action: () => void }>;
    const items: Array<{ icon: React.ReactNode; label: string; hint?: string; action: () => void }> = [
      {
        icon: isPlaying ? <Pause className="h-4 w-4" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />,
        label: isPlaying ? 'Pausar' : 'Reproducir',
        action: toggle,
      },
      { icon: <SkipForward className="h-4 w-4" aria-hidden />, label: 'Siguiente canción', action: next },
      { icon: <SkipBack className="h-4 w-4" aria-hidden />, label: 'Canción anterior', action: prev },
      {
        icon: muted ? <Volume2 className="h-4 w-4" aria-hidden /> : <VolumeX className="h-4 w-4" aria-hidden />,
        label: muted ? 'Activar sonido' : 'Silenciar',
        action: toggleMute,
      },
      {
        icon: <Shuffle className={cn('h-4 w-4', shuffle && 'text-amber-strong')} aria-hidden />,
        label: shuffle ? 'Desactivar orden aleatorio' : 'Reproducir en orden aleatorio',
        hint: shuffle ? 'aleatorio activo' : undefined,
        action: toggleShuffle,
      },
      {
        icon: <ListMusic className="h-4 w-4" aria-hidden />,
        label: 'Ver cola de reproducción',
        hint: 'Q',
        action: openQueueSheet,
      },
      {
        icon: <Maximize2 className="h-4 w-4" aria-hidden />,
        label: 'Abrir “Sonando ahora”',
        action: () => window.dispatchEvent(new CustomEvent(EXPAND_PLAYER_EVENT)),
      },
    ];
    return items.filter((i) => match(i.label + ' ' + track.title, query));
  }, [track, isPlaying, muted, shuffle, toggle, next, prev, toggleMute, toggleShuffle, query]);

  const searching = communityLoading && debounced.trim().length >= 2;
  const nothingFound =
    query.trim().length > 0 &&
    navItems.length === 0 &&
    playerItems.length === 0 &&
    mySongItems.length === 0 &&
    communityItems.length === 0 &&
    !searching;

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          className="gap-0 overflow-hidden rounded-[28px_28px_14px_14px] border-[1.5px]! border-border bg-[var(--m-input)] p-0 shadow-xl! sm:max-w-lg"
          showCloseButton={false}
        >
          <DialogHeader className="sr-only">
            <DialogTitle>Búsqueda rápida</DialogTitle>
            <DialogDescription>Buscá canciones, páginas y acciones de Melodya.</DialogDescription>
          </DialogHeader>
          <Command shouldFilter={false} className="[&_[cmdk-group-heading]]:text-muted-foreground [&_[data-slot=command-input-wrapper]]:border-b-0">
            <CommandInput
              autoFocus
              cmdk-input
              aria-label="Búsqueda rápida"
              value={query}
              onValueChange={setQuery}
              placeholder="Buscar canciones, páginas o acciones…"
            />
            <CommandList className="scrollbar-none max-h-[380px] overflow-y-auto px-0 pt-3 pb-4 [mask-image:linear-gradient(to_bottom,transparent_0,black_10px,black_calc(100%-18px),transparent_100%)] [&_[cmdk-item]]:h-11 [&_[cmdk-item]]:gap-2.5 [&_[cmdk-item]]:rounded-none! [&_[cmdk-item]]:px-3.5 [&_[cmdk-item]]:text-[13px] [&_[cmdk-item]]:font-semibold [&_[cmdk-item]]:outline-none! [&_[cmdk-separator]]:hidden [&_[cmdk-item]>svg]:box-content [&_[cmdk-item]>svg]:size-[12px]! [&_[cmdk-item]>svg]:rounded-full [&_[cmdk-item]>svg]:border-[1.5px] [&_[cmdk-item]>svg]:border-line [&_[cmdk-item]>svg]:p-[5px] [&_[cmdk-group]]:p-0 [&_[cmdk-group-heading]]:flex [&_[cmdk-group-heading]]:items-center [&_[cmdk-group-heading]]:gap-2 [&_[cmdk-group-heading]]:px-3.5 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:text-[13px] [&_[cmdk-group-heading]]:font-bold [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-label! [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:before:size-[7.5px] [&_[cmdk-group-heading]]:before:shrink-0 [&_[cmdk-group-heading]]:before:rounded-full [&_[cmdk-group-heading]]:before:bg-gold [&_[cmdk-group-heading]]:before:content-[''] max-sm:[&_[cmdk-item]]:h-9 max-sm:[&_[cmdk-item]]:gap-2 max-sm:[&_[cmdk-item]]:px-3 max-sm:[&_[cmdk-item]]:text-xs max-sm:[&_[cmdk-item]>svg]:size-[10px]! max-sm:[&_[cmdk-item]>svg]:p-1">
              {nothingFound && (
                <p className="py-6 text-center text-sm text-muted-foreground" role="status">
                  Nada por acá. Probá con otra palabra.
                </p>
              )}

              {/* Reproductor (solo si hay algo cargado) */}
              {playerItems.length > 0 && (
                <CommandGroup heading="Reproductor" className="[&_[cmdk-item]>svg]:border-transparent [&_[cmdk-item]>svg]:bg-element-sound [&_[cmdk-item]>svg]:text-[#131C33]!">
                  {playerItems.map((i) => (
                    <CommandItem key={i.label} onSelect={() => run(i.action)} className="cursor-pointer">
                      {i.icon}
                      {i.label}
                      {i.label === 'Abrir “Sonando ahora”' && (
                        <span className="ml-2 truncate text-xs text-muted-foreground">— {track?.title}</span>
                      )}
                      {i.hint && (
                        i.hint === 'Q' ? (
                          <KeyHint>Q</KeyHint>
                        ) : (
                          <span className="ml-auto shrink-0 rounded-full bg-primary px-2.5 py-0.5 text-[10px] font-bold text-primary-foreground">{i.hint}</span>
                        )
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}

              {/* Tus canciones (auth) */}
              {authed && mySongItems.length > 0 && (
                <CommandGroup heading="Tus canciones" className="[&_[cmdk-item]>svg]:border-transparent [&_[cmdk-item]>svg]:bg-element-idea [&_[cmdk-item]>svg]:text-[#131C33]!">
                  {mySongItems.map((t) => (
                    <CommandItem
                      key={`mine-${t.id}-${t.audioUrl}`}
                      value={`m ${t.title}`}
                      onSelect={() => playFrom(t, mySongItems)}
                      className="cursor-pointer"
                    >
                      <Music4 className="h-4 w-4 text-amber-strong" aria-hidden />
                      <span className="truncate">{t.title}</span>
                      <span className="ml-auto text-xs text-muted-foreground">Tuya</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}

              {/* Comunidad (server-side search) */}
              {communityItems.length > 0 && (
                <CommandGroup heading="De la comunidad" className="[&_[cmdk-item]>svg]:border-transparent [&_[cmdk-item]>svg]:bg-element-style [&_[cmdk-item]>svg]:text-[#131C33]!">
                  {communityItems.map((t) => (
                    <CommandItem
                      key={`com-${t.id}-${t.audioUrl}`}
                      value={`c ${t.title}`}
                      onSelect={() => playFrom(t, communityItems)}
                      className="cursor-pointer"
                    >
                      <Users className="h-4 w-4 text-amber-strong" aria-hidden />
                      <span className="truncate">{t.title}</span>
                      <span className="ml-auto max-w-28 truncate text-xs text-muted-foreground">{t.artist}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {searching && (
                <p className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground" role="status">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-strong" aria-hidden />
                  Buscando en la comunidad…
                </p>
              )}

              {navItems.length > 0 && (
                <>
                  <CommandSeparator className="my-1" />
                  <CommandGroup heading="Ir a" className="[&_[cmdk-item]>svg]:border-transparent [&_[cmdk-item]>svg]:bg-element-lyrics [&_[cmdk-item]>svg]:text-[#131C33]!">
                    {navItems.map((i) => (
                      <CommandItem key={i.to} onSelect={() => run(() => navigate(i.to))} className="cursor-pointer">
                        {i.icon}
                        {i.label}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </>
              )}

              {/* Radio de la comunidad */}
              {match('radio', query) && (
                <CommandGroup heading="Radio" className="[&_[cmdk-item]>svg]:border-transparent [&_[cmdk-item]>svg]:bg-element-sound [&_[cmdk-item]>svg]:text-[#131C33]!">
                  <CommandItem
                    onSelect={() => run(() => void startCommunityRadio('most_liked'))}
                    className="cursor-pointer"
                  >
                    <Radio className="h-4 w-4 text-amber-strong" aria-hidden />
                    Encender la radio · {RADIO_SORT_LABELS.most_liked}
                    <span className="ml-auto hidden text-[11px] text-muted-foreground md:inline">cola infinita</span>
                  </CommandItem>
                  <CommandItem
                    onSelect={() => run(() => void startCommunityRadio('newest'))}
                    className="cursor-pointer"
                  >
                    <Radio className="h-4 w-4 text-amber-strong" aria-hidden />
                    Encender la radio · {RADIO_SORT_LABELS.newest}
                    <span className="ml-auto hidden text-[11px] text-muted-foreground md:inline">cola infinita</span>
                  </CommandItem>
                </CommandGroup>
              )}

              {/* Acciones */}
              {match('atajos de teclado', query) && (
                <CommandGroup heading="Acciones" className="[&_[cmdk-item]>svg]:border-transparent [&_[cmdk-item]>svg]:bg-element-style [&_[cmdk-item]>svg]:text-[#131C33]!">
                  <CommandItem onSelect={() => run(() => setShortcutsOpen(true))} className="cursor-pointer">
                    <Keyboard className="h-4 w-4" aria-hidden />
                    Ver atajos de teclado
                    <span className="ml-auto hidden sm:flex">
                      <KeyHint>?</KeyHint>
                    </span>
                  </CommandItem>
                  {authed && match('cerrar sesión', query) && (
                    <CommandItem
                      onSelect={() => run(() => void logout())}
                      className="cursor-pointer text-destructive focus:text-destructive [&>svg]:bg-destructive/15 [&>svg]:text-destructive!"
                    >
                      <LogOut className="h-4 w-4" aria-hidden />
                      Cerrar sesión
                    </CommandItem>
                  )}
                </CommandGroup>
              )}

              {/* Pie: ayuda de uso */}
              <div className="flex items-center gap-4 px-3 pt-2 pb-1 text-[11px] text-muted-foreground" aria-hidden>
                <span className="flex items-center gap-1">
                  <ArrowUp className="h-3 w-3" aria-hidden />
                  <ArrowDown className="h-3 w-3" aria-hidden />
                  navegar
                </span>
                <span className="flex items-center gap-1">
                  <CornerDownLeft className="h-3 w-3" aria-hidden />
                  elegir
                </span>
                <span className="ml-auto flex items-center gap-1">
                  <CommandIcon className="h-3 w-3" aria-hidden />K abre esto en cualquier momento
                </span>
              </div>
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </>
  );
}
