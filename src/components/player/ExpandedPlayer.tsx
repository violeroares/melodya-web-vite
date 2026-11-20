
/**
 * MELODYA WEB — ExpandedPlayer ("Sonando ahora"): reproductor a pantalla
 * completa. CLIENT-ONLY sobre el playerStore global.
 *
 * • Portada grande con disco de vinilo girando + fondo difuminado de la portada.
 * • Visualizador de audio real (Web Audio AnalyserNode + canvas) opt-in.
 * • Letra con scroll + cola embebida (pestañas), compartir/descargar,
 *   velocidad, volumen y timer de sueño (5/15/30/60 min o fin del tema).
 * • Es-AR, dark-first, acentos ámbar; respeta prefers-reduced-motion.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Play, Pause, SkipBack, SkipForward, Volume2, VolumeX, ChevronDown, ListMusic,
  Share2, Download, Check, Activity, Gauge, Music4, Loader2, ExternalLink, Radio, Copy, Heart, Shuffle, BookmarkPlus, UserRound,
} from 'lucide-react';
import { usePlayerStore } from '@/stores/player';
import { useQueryClient } from '@tanstack/react-query';
import { useDownloadState } from '@/hooks/use-capabilities';
import { usePlanGate } from '@/hooks/use-plan-gate';
import { RequiredPlanBadge } from '@/components/common/PlanGate';
import { downloadSongAudio } from '@/lib/song-download';
import { toggleCurrentTrackLike } from '@/lib/like';
import { navigate } from '@/lib/router';
import { cn } from '@/lib/utils';
import { CoverArt } from '@/components/common';
import { Waveform } from './Waveform';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-mobile';
import { shareContent } from '@/lib/share';
import { songUrl } from '@/lib/links';
import { toUserMessage } from '@/lib/errors';
import { useToast } from '@/hooks/use-toast';
import { QueueList } from './QueueList';
import { ExportQueueDialog } from './ExportQueueDialog';
import { ensureAnalyser, getAnalyser } from '@/lib/audio-viz';
import { apiFileUrl } from '@/lib/api/client';
import { communityApi, songsApi } from '@/lib/api';
import { fetchTrackLyrics, trackSupportsLyrics } from './track-lyrics';
import { formatNumber } from '@/hooks';

const SPEED_OPTIONS = [0.75, 1, 1.25, 1.5];

function speedLabel(v: number) {
  return `${v === 1 ? '1' : v.toFixed(2).replace(/0$/, '')}×`;
}

/* ── Visualizador: barras ámbar/coral reactivas al audio real ── */
function Visualizer({ isPlaying, onEnable, enabled, failed }: { isPlaying: boolean; enabled: boolean; failed: boolean; onEnable: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const levelsRef = useRef<number[]>([]);
  const rafRef = useRef<number | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(getAnalyser());
  const dataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const BARS = 40;
    const analyser = analyserRef.current;
    let levels = levelsRef.current;
    if (levels.length !== BARS) levels = levelsRef.current = new Array(BARS).fill(0);

    if (analyser) {
      if (!dataRef.current || dataRef.current.length !== analyser.frequencyBinCount) {
        dataRef.current = new Uint8Array(analyser.frequencyBinCount);
      }
      const data = dataRef.current;
      analyser.getByteFrequencyData(data);
      const bins = Math.min(analyser.frequencyBinCount, 60); // zona con contenido musical
      for (let i = 0; i < BARS; i++) {
        const bin = Math.floor((i / BARS) * bins);
        const v = data[bin] / 255;
        levels[i] = isPlaying ? Math.max(v, levels[i] * 0.86) : levels[i] * 0.9;
      }
    } else {
      for (let i = 0; i < BARS; i++) levels[i] *= 0.9;
    }

    const gap = Math.max(2, w / BARS * 0.32);
    const bw = (w - gap * (BARS - 1)) / BARS;
    for (let i = 0; i < BARS; i++) {
      const v = levels[i];
      const bh = Math.max(3, v * (h - 4));
      const x = i * (bw + gap);
      const y = h - bh;
      ctx.fillStyle = '#FF6B4D'; // naranja de marca (design-V2)
      if (typeof ctx.roundRect === 'function') {
        ctx.beginPath();
        ctx.roundRect(x, y, bw, bh, Math.min(bw / 2, 3));
        ctx.fill();
      } else {
        ctx.fillRect(x, y, bw, bh);
      }
    }
  }, [isPlaying]);

  useEffect(() => {
    const loop = () => {
      draw();
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [draw]);

  // Sincronizar analyser cuando se activa desde afuera.
  useEffect(() => {
    analyserRef.current = getAnalyser();
  }, [enabled, isPlaying]);

  return (
    <div className="relative w-full">
      <canvas
        ref={canvasRef}
        aria-hidden
        className={cn('h-14 w-full transition-opacity duration-500', failed ? 'opacity-30' : 'opacity-90')}
      />
      {failed && !enabled && (
        <button
          type="button"
          onClick={onEnable}
          className="absolute inset-0 flex items-center justify-center gap-2 text-xs font-medium text-muted-foreground transition-colors hover:text-amber-strong"
          aria-label="Activar visualizador de audio"
        >
          <Activity className="h-3.5 w-3.5" aria-hidden />
          Activar visualizador
        </button>
      )}
    </div>
  );
}

/* ── Letra a pantalla completa ──
   La letra no trae marcas de tiempo (el backend solo guarda el texto), así que se muestra como texto con scroll,
   sin seguir la canción. */
const SECTION_RE = /^\[(.+)\]$/;

function LyricLines({ lyrics, large = false }: { lyrics: string; large?: boolean }) {
  const lines = useMemo(() => lyrics.split(/\r?\n/), [lyrics]);

  return (
    <div
      role="region"
      aria-label="Letra de la canción"
      className="fade-edges-y relative h-full min-h-0 overflow-y-auto px-2 text-center scrollbar-none"
    >
      {lines.map((line, i) => {
        const section = line.trim().match(SECTION_RE);
        if (section) {
          return (
            <p key={i} className={cn('pt-4 pb-2 font-bold tracking-[0.12em] text-label uppercase', large ? 'text-sm' : 'text-xs')}>
              {section[1]}
            </p>
          );
        }
        if (!line.trim()) return <div key={i} className="h-3" />;
        return (
          <p key={i} className={cn('whitespace-pre-line py-1.5 font-display font-semibold leading-[1.3] text-foreground', large ? 'text-2xl' : 'text-lg')}>
            {line}
          </p>
        );
      })}
    </div>
  );
}

export function ExpandedPlayer({ open, onClose, audioRef }: { open: boolean; onClose: () => void; audioRef: React.RefObject<HTMLAudioElement | null> }) {
  const { track, queue, isPlaying, position, duration, volume, muted, speed, shuffle, radioMode, radioGenre, toggle, seek, setVolume, setSpeed, toggleMute, toggleShuffle, next, prev, play } =
    usePlayerStore();
  const { toast } = useToast();
  const [vizEnabled, setVizEnabled] = useState(false);
  const [vizFailed, setVizFailed] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const queryClient = useQueryClient();
  const downloadState = useDownloadState(); // E6: capacidad y cupo de descargas
  const downloadGate = usePlanGate('DOWNLOAD_AUDIO'); // capacidad no incluida → aviso de upgrade (el cupo agotado conserva su mensaje)
  const ownDownloadable = Boolean(track) && track?.kind !== 'sample' && track?.own !== false && !track?.trashed; // la descarga explícita es solo de canciones propias (y no de las que están en la Papelera)
  const [exportOpen, setExportOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const queueButtonRef = useRef<HTMLButtonElement>(null);
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const lyricsButtonRef = useRef<HTMLButtonElement>(null);
  const isMobile = useIsMobile();
  const [loadingLyrics, setLoadingLyrics] = useState(false);
  /* Letra bajo demanda: el feed de comunidad no la trae — la buscamos en el
     detalle real (GET /community/songs/:id o GET /songs/:id) al pedirla. */
  const [fetchedLyrics, setFetchedLyrics] = useState<{ key: string | null; text: string | null }>({ key: null, text: null });
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const volumeRef = useRef<HTMLDivElement | null>(null);

  /* Rueda del ratón sobre el volumen (mismo gesto que el PlayerBar). */
  useEffect(() => {
    const el = volumeRef.current;
    if (!el || !open) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { volume, muted, setVolume, toggleMute } = usePlayerStore.getState();
      const delta = e.deltaY < 0 ? 0.05 : -0.05;
      if (muted && delta > 0) toggleMute();
      setVolume(Math.min(1, Math.max(0, volume + delta)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [open]);

  /* La letra pedida pertenece a un tema concreto: si cambia el tema, deja de valer (estado derivado). */
  const lyricsKey = track ? `${track.id}|${track.audioUrl}` : null;
  const lyricsFetched = lyricsKey !== null && fetchedLyrics.key === lyricsKey;
  const lyricsText = track?.lyrics ?? (lyricsFetched ? fetchedLyrics.text : null);
  /* Ya se consultó y la canción no tiene letra (instrumental): no se muestra la card (desktop) ni el botón "Ver letra" (mobile). */
  /* Las muestras (voz/instrumental) no son canciones: no tienen letra que pedir ni mostrar. */
  const isSample = !trackSupportsLyrics(track);
  const hasNoLyrics = isSample || (lyricsFetched && !lyricsText?.trim());

  /* ── Reacción (me gusta): estado en el playerStore (compartido con el atajo
     "L" y la sesión persistida); el toggle optimista vive en src/lib/like.ts. ── */
  const community = track?.community ?? null;
  const liked = community?.viewerReaction === 'LIKE';
  const likesCount = community?.likesCount ?? 0;

  const toggleLike = () => {
    if (!track || !community) return;
    void toggleCurrentTrackLike().then((outcome) => {
      if (outcome === 'guest') {
        toast({
          title: 'Ingresá para reaccionar',
          description: 'Creá tu cuenta gratis y dejá tu me gusta a otros melodiosos.',
        });
        onClose();
        navigate('/login');
      }
    });
  };

  const loadLyrics = async (silent = false) => {
    if (!track || loadingLyrics) return;
    setLoadingLyrics(true);
    try {
      const text = await fetchTrackLyrics(track, {
        communityLyrics: async (id) => (await communityApi.song(id)).lyrics,
        songLyrics: async (id) => (await songsApi.get(id)).currentVersion?.lyricsText,
      });
      setFetchedLyrics({ key: lyricsKey, text });
    } catch (err) {
      if (!silent) toast({ title: 'No pudimos traer la letra', description: toUserMessage(err), variant: 'destructive' });
    } finally {
      setLoadingLyrics(false);
    }
  };

  /* La letra se trae sola al abrir el reproductor (una vez por tema; si falla queda el botón «Buscar letra»). */
  const autoLyricsFor = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !track || isSample || !lyricsKey || track.lyrics || lyricsFetched || autoLyricsFor.current === lyricsKey) return;
    autoLyricsFor.current = lyricsKey;
    void loadLyrics(true);
  }, [open, track, isSample, lyricsKey, lyricsFetched]);

  /* Foco inicial: solo al abrir el reproductor. No debe depender de la cola ni de `onClose`: si se re-ejecutara al cerrar el
   * Sheet de la cola, el foco saltaría al botón de cerrar mientras el reproductor sigue con aria-hidden (aviso del navegador) y
   * le robaría el foco al panel abierto. */
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  /* Esc para cerrar. */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (queueOpen || lyricsOpen) return; // con la cola o la letra abiertas, Esc cierra solo ese panel (lo maneja el Sheet)
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose, queueOpen, lyricsOpen]);

  const enableViz = useCallback((manual = false) => {
    const a = ensureAnalyser(audioRef.current);
    setVizEnabled(!!a);
    setVizFailed(!a);
    if (!a && manual) toast({ title: 'El visualizador no está disponible', description: 'Tu navegador bloqueó el análisis de audio.' });
  }, [audioRef, toast]);

  /* El visualizador se activa solo al abrir el reproductor expandido (abrirlo es un gesto del usuario, así que
     el AudioContext puede arrancar). Si el navegador lo bloquea queda el botón manual. */
  useEffect(() => {
    if (open && track && !vizEnabled) enableViz();
  }, [open, track, vizEnabled, enableViz]);

  const share = async () => {
    if (!track) return;
    const url = songUrl(track.id);
    const out = await shareContent({ title: track.title, text: 'Escuchá esta canción hecha con Melodya 🎵', url });
    if (out === 'copied') toast({ title: 'Link copiado', description: 'Pegalo donde quieras compartirlo.' });
  };

  const download = async () => {
    if (downloadGate.locked && ownDownloadable) {
      downloadGate.prompt();
      return;
    }
    if (!track || downloading || !downloadState.allowed || !ownDownloadable) return;
    setDownloading(true);
    try {
      /* E6: la descarga explícita usa su propio endpoint (cuenta contra el cupo). La reproducción sigue usando track.audioUrl. */
      await downloadSongAudio({ songId: track.id, title: track.title });
      void queryClient.invalidateQueries({ queryKey: ['usage'] });
      toast({ title: 'Descarga iniciada', description: `Guardando "${track.title}" en tu equipo.` });
    } catch (err) {
      toast({ title: 'No pudimos descargar la canción', description: toUserMessage(err), variant: 'destructive' });
    } finally {
      setDownloading(false);
    }
  };

  const copyLyrics = async () => {
    if (!lyricsText) return;
    try {
      await navigator.clipboard.writeText(lyricsText);
      toast({ title: 'Letra copiada', description: 'Pegala donde la necesites.' });
    } catch {
      toast({ title: 'No pudimos copiar la letra', variant: 'destructive' });
    }
  };

  const fmt = (s: number) => {
    if (!Number.isFinite(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const currentIdx = queue.findIndex((t) => track && t.id === track.id && t.audioUrl === track.audioUrl);

  const coverUrl = track?.coverUrl;
  const backdrop = useMemo(() => {
    const url = coverUrl ? apiFileUrl(coverUrl) : null;
    if (!url) return null;
    return url;
  }, [coverUrl]);

  /* Con el reproductor abierto la página de atrás no se desplaza: así no aparece una segunda barra de scroll. */
  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = 'hidden';
    return () => {
      root.style.overflow = previous;
    };
  }, [open]);

  if (!open || !track) return null;

  /* Letra (o sus estados: vacía, buscando, "¿Querés ver la letra?"). Se usa en la columna derecha (desktop) y en el bottom sheet (mobile). */
  const renderLyrics = (bare = false) => (
    <>
      {lyricsText && bare ? (
        /* Mobile (sheet): sin la card interior, para aprovechar el ancho; el texto va más grande y en blanco pleno. */
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex justify-end pb-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void copyLyrics()}
              className="h-8 rounded-full px-3 text-xs text-muted-foreground transition-colors hover:text-amber-strong"
              aria-label="Copiar letra al portapapeles"
            >
              <Copy className="h-3.5 w-3.5" aria-hidden />
              Copiar
            </Button>
          </div>
          <div className="min-h-0 flex-1">
            <LyricLines lyrics={lyricsText} large />
          </div>
        </div>
      ) : lyricsText ? (
        <div className="flex h-full min-h-0 flex-col rounded-t-[28px] rounded-b-[14px] border-[1.5px] border-border bg-surface">
          <div className="flex items-center justify-between gap-2 border-b border-border px-5 py-2">
            <p className="truncate text-xs font-bold tracking-[0.12em] text-label uppercase">Letra</p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void copyLyrics()}
              className="h-7 rounded-full px-2.5 text-xs text-muted-foreground transition-colors hover:text-amber-strong"
              aria-label="Copiar letra al portapapeles"
            >
              <Copy className="h-3.5 w-3.5" aria-hidden />
              Copiar
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden px-3 pt-2 pb-3">
            <LyricLines lyrics={lyricsText} />
          </div>
        </div>
      ) : lyricsFetched ? (
        <div className="flex h-full min-h-[160px] flex-col items-center justify-center gap-2 rounded-cover border border-dashed border-border/70 bg-surface/40 p-6 text-center">
          <Music4 className="h-6 w-6 text-muted-foreground" aria-hidden />
          <p className="text-sm font-medium">Esta canción no tiene letra</p>
          <p className="text-xs text-muted-foreground">Música instrumental, sin letra cargada.</p>
        </div>
      ) : loadingLyrics ? (
        <div role="status" className="flex h-full min-h-[160px] flex-col items-center justify-center gap-2 rounded-cover border border-dashed border-border/70 bg-surface/40 p-6 text-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden />
          <p className="text-sm font-medium">Buscando la letra…</p>
        </div>
      ) : (
        <div className="flex h-full min-h-[160px] flex-col items-center justify-center gap-3 rounded-cover border border-dashed border-border/70 bg-surface/40 p-6 text-center">
          <Music4 className="h-6 w-6 text-muted-foreground" aria-hidden />
          <p className="text-sm font-medium">¿Querés ver la letra?</p>
          <p className="max-w-xs text-xs text-muted-foreground">La traemos del detalle de la canción.</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadLyrics()}
            disabled={loadingLyrics}
            className="rounded-full border-amber/40 bg-amber/10 text-amber-strong transition-colors hover:bg-amber/20"
            aria-label="Buscar la letra de la canción"
          >
            {loadingLyrics ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Music4 className="h-4 w-4" aria-hidden />}
            {loadingLyrics ? 'Buscando…' : 'Buscar letra'}
          </Button>
        </div>
      )}
    </>
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Reproductor expandido"
      className="np-fade fixed inset-0 z-[70] flex flex-col bg-background"
    >
      {/* Encabezado */}
      <div className="relative z-10 flex items-center gap-3 px-4 pt-4 sm:px-6 [@media(max-height:600px)]:pt-2">
        <Button ref={closeRef} variant="ghost" size="icon" onClick={onClose} aria-label="Minimizar reproductor" className="size-12 shrink-0 rounded-full bg-voice text-on-voice shadow-md hover:bg-voice/90 hover:text-on-voice">
          <ChevronDown className="h-6 w-6" strokeWidth={2.5} aria-hidden />
        </Button>
        <div className="min-w-0 flex-1 text-center">
          <p className="text-xs font-bold tracking-[0.12em] text-label uppercase">Reproduciendo</p>
          <p className="flex items-center justify-center gap-2 truncate text-xs text-muted-foreground">
            {radioMode && (
              <span
                className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber/40 bg-amber/10 px-2 py-0.5 text-[10px] font-bold text-amber-strong"
                title={`Radio de la comunidad${radioGenre ? ` · ${radioGenre}` : ''}`}
              >
                <Radio className="h-3 w-3 animate-pulse" aria-hidden />
                Radio infinita{radioGenre ? <span className="max-w-28 truncate">· {radioGenre}</span> : null}
              </span>
            )}
            {queue.length > 0 && currentIdx >= 0 ? `${currentIdx + 1} de ${queue.length} en la cola` : 'Melodya'}
          </p>
        </div>
        {/* Contrapeso del botón de la izquierda: centra el texto con la portada solo en mobile */}
        <div aria-hidden className="size-12 shrink-0 md:hidden" />
      </div>

      {/* Contenido */}
      <div
        className={cn(
          'relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col overflow-y-auto px-4 pb-6 sm:px-6 md:grid md:gap-10 md:overflow-hidden lg:gap-14',
          // Sin letra: una sola columna, centrada horizontalmente
          hasNoLyrics ? 'md:grid-cols-[minmax(0,30rem)] md:justify-center' : 'md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]'
        )}
      >
        {/* Columna derecha: letra (en mobile no se muestra: se abre en un bottom sheet desde el botón "Ver letra") */}
        {!hasNoLyrics && (
          <div className="order-2 hidden shrink-0 flex-col py-2 md:order-2 md:flex md:min-h-0 md:shrink md:py-10">
            {!isMobile && <div className="mt-1 min-h-0 md:flex-1">{renderLyrics()}</div>}
          </div>
        )}

        {/* Columna izquierda: portada, y debajo título, progreso y controles */}
        <div className="order-1 flex shrink-0 flex-col items-center gap-3 py-3 [@media(max-height:600px)]:gap-2 [@media(max-height:600px)]:py-1 max-md:flex-1 sm:gap-5 sm:py-6 md:order-1 md:min-h-0 md:shrink md:justify-center md:gap-4 md:overflow-y-auto md:overflow-x-hidden md:py-4">
          {/* Portada circular que gira dentro de un aro con un arco dorado (animación de «Reproductor», design-V2) */}
          <div className="np-cover relative aspect-square max-w-full shrink-0">
            <svg className="absolute inset-0 size-full" viewBox="0 0 280 280" fill="none" aria-hidden>
              <circle cx="140" cy="140" r="138" stroke="var(--m-faint)" strokeWidth="1.5" />
              <circle
                cx="140"
                cy="140"
                r="138"
                stroke="var(--m-gold)"
                strokeWidth="3"
                strokeDasharray="190 680"
                strokeLinecap="round"
                className="vinyl-spin"
                data-playing={isPlaying ? 'true' : 'false'}
                style={{ transformOrigin: '140px 140px', animationDuration: '30s' }}
              />
            </svg>
            <div
              className="vinyl-spin absolute inset-[6.4%]"
              data-playing={isPlaying ? 'true' : 'false'}
              style={{ animationDuration: '30s' }}
            >
              <CoverArt
                id={track.id}
                src={track.coverUrl}
                alt={`Portada de ${track.title}`}
                className="np-in size-full border-2 border-background"
                rounded="rounded-full"
              />
            </div>
            {/* Agujero central */}
            <span
              aria-hidden
              className="absolute top-1/2 left-1/2 size-[11.4%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-background shadow-[0_0_0_6px_rgba(19,28,51,.35)]"
            />
          </div>

          <div className="flex w-full flex-col gap-2.5 max-md:flex-1 sm:gap-4 md:gap-3">
            <div className="flex flex-col items-center text-center">
              <h1 className="font-display text-2xl leading-[1.1] font-bold tracking-[-0.02em] text-balance sm:text-3xl [@media(max-height:600px)]:text-xl">{track.title}</h1>
              {/* Autor y «Más de…» comparten fila */}
              <div className="mt-1 flex max-w-full flex-wrap items-center justify-center gap-x-3 gap-y-1">
              {/* Las muestras (voz/instrumental) no tienen ficha de canción: el artista es solo una etiqueta, sin enlace a /songs/:id. */}
              {isSample ? (
                <p className="truncate text-sm font-semibold text-label">{track.artist}</p>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    navigate(`/songs/${track.id}`);
                  }}
                  className="group inline-flex min-w-0 items-center gap-1.5 text-sm font-semibold text-label"
                  aria-label={`Abrir ${track.title}`}
                >
                  <span className="truncate group-hover:underline group-hover:underline-offset-4">{track.artist}</span>
                  <ExternalLink className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
                </button>
              )}
              {/* Más de este artista: filtro real del feed (?author=) — solo para
                  temas de OTROS creadores (los propios ya tenés todo en Biblioteca). */}
              {community?.authorId && !track.own && (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    navigate(`/community?author=${encodeURIComponent(community.authorId!)}`);
                  }}
                  className="artist-more inline-flex items-center gap-1.5 text-xs text-muted-foreground/90"
                  aria-label={`Ver más canciones de ${track.artist} en la comunidad`}
                >
                  <UserRound className="h-3.5 w-3.5" aria-hidden />
                  <span className="underline decoration-dotted underline-offset-4">Más de {track.artist}</span>
                </button>
              )}
              </div>
            </div>

            {/* Progreso */}
            <div className="flex items-center gap-3">
              <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">{fmt(position)}</span>
              <Waveform className="h-10" seed={track.id} position={position} duration={duration || track.durationSec || 0} onSeek={seek} />
              <span className="w-10 text-xs tabular-nums text-muted-foreground">{fmt(duration || track.durationSec || 0)}</span>
            </div>

            {/* Controles principales */}
            <div className="flex items-center justify-center gap-2 sm:gap-4 md:max-lg:gap-2">
              {/* Aleatorio (persistido): “siguiente” elige al azar del resto de la cola */}
              <Button
                variant="ghost"
                size="icon"
                onClick={toggleShuffle}
                aria-pressed={shuffle}
                aria-label={shuffle ? 'Desactivar orden aleatorio' : 'Reproducir en orden aleatorio'}
                title={`Orden aleatorio · atajo S${shuffle ? ' (activo)' : ''}`}
                className={cn('size-11 shrink-0 rounded-full md:max-lg:size-9', shuffle && 'bg-selected text-on-selected hover:bg-selected hover:text-on-selected')}
              >
                <Shuffle className={cn('h-4 w-4', shuffle && 'shuffle-on')} aria-hidden />
              </Button>
              <Button variant="ghost" size="icon" onClick={prev} aria-label="Anterior" className="size-[52px] shrink-0 rounded-full md:max-lg:size-11 [@media(max-height:600px)]:size-11 border-[1.5px] border-line">
                <SkipBack className="h-5 w-5" aria-hidden />
              </Button>
              <button
                onClick={toggle}
                aria-label={isPlaying ? 'Pausar' : 'Reproducir'}
                className={cn(
                  'flex size-20 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-transform active:scale-95 [@media(max-height:600px)]:size-16',
                  isPlaying && 'pulse-ring'
                )}
              >
                {isPlaying ? <Pause className="h-8 w-8 fill-current" aria-hidden /> : <Play className="ml-1 h-8 w-8 fill-current" aria-hidden />}
              </button>
              <Button variant="ghost" size="icon" onClick={next} aria-label="Siguiente" className="size-[52px] shrink-0 rounded-full md:max-lg:size-11 [@media(max-height:600px)]:size-11 border-[1.5px] border-line">
                <SkipForward className="h-5 w-5" aria-hidden />
              </Button>
              {/* Cola de reproducción: bottom sheet en mobile, panel lateral en desktop */}
              <Button
                ref={queueButtonRef}
                variant="ghost"
                size="icon"
                onClick={() => setQueueOpen(true)}
                aria-label={`Ver la cola de reproducción${queue.length > 0 ? ` (${queue.length})` : ''}`}
                aria-haspopup="dialog"
                title={`Cola${queue.length > 0 ? ` (${queue.length})` : ''}`}
                className={cn('size-11 shrink-0 rounded-full md:max-lg:size-9', queueOpen && 'bg-selected text-on-selected hover:bg-selected hover:text-on-selected')}
              >
                <ListMusic className="h-4 w-4" aria-hidden />
              </Button>
            </div>

            {/* Volumen (solo, en su propia fila bajo los controles) + velocidad y acciones debajo. Las dos filas miden lo mismo que
                los tres botones de anterior · reproducir · siguiente (52 + 80 + 52 px y los huecos de esa fila: 200 px, 214 px desde sm). */}
            <div className="flex w-[200px] flex-col items-center gap-3 self-center sm:w-[214px]">
              <div className="flex w-full items-center gap-2" ref={volumeRef} title="Volumen · rueda del ratón">
                <Button variant="ghost" size="icon" onClick={toggleMute} aria-label={muted ? 'Activar sonido' : 'Silenciar'} className="h-9 w-9 rounded-full">
                  {muted || volume === 0 ? <VolumeX className="h-4 w-4" aria-hidden /> : <Volume2 className="h-4 w-4" aria-hidden />}
                </Button>
                <Slider
                  value={[muted ? 0 : volume * 100]}
                  max={100}
                  step={1}
                  onValueChange={(v) => setVolume(v[0] / 100)}
                  className="slider-warm min-w-0 flex-1 cursor-pointer"
                  aria-label="Volumen"
                />
              </div>

              <TooltipProvider delayDuration={300}>
                <div className="grid w-full auto-cols-fr grid-flow-col gap-1.5">
                  {/* Velocidad */}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label="Velocidad de reproducción"
                        className={cn('h-11 [@media(max-height:600px)]:h-9 w-full min-w-0 rounded-full px-0 font-semibold tabular-nums', speed !== 1 && 'bg-selected text-on-selected hover:bg-selected hover:text-on-selected')}
                      >
                        <Gauge className="h-3.5 w-3.5" aria-hidden />
                        {speedLabel(speed)}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="center" className="z-[80] min-w-32">
                      {SPEED_OPTIONS.map((v) => (
                        <DropdownMenuItem key={v} onClick={() => setSpeed(v)} className="cursor-pointer rounded-lg tabular-nums">
                          {v === 1 ? 'Normal (1×)' : speedLabel(v)}
                          {speed === v && <Check className="ml-auto h-3.5 w-3.5 text-amber-strong" aria-hidden />}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>

                  {/* Me gusta (solo pistas de comunidad: los datos viajan en la pista) */}
                  {community && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={toggleLike}
                          aria-pressed={liked}
                          aria-label={liked ? `Quitar me gusta de ${track.title}` : `Me gusta ${track.title}`}
                          className={cn(
                            'like-warm inline-flex h-11 [@media(max-height:600px)]:h-9 w-full min-w-0 items-center justify-center gap-1 rounded-full px-0 text-sm font-semibold tabular-nums transition-all',
                            liked ? 'text-label' : 'text-muted-foreground hover:text-foreground'
                          )}
                        >
                          <Heart key={liked ? 'on' : 'off'} className={cn('h-4 w-4', liked && 'fill-current heart-pop')} aria-hidden />
                          {formatNumber(likesCount)}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top">{liked ? 'Quitar me gusta' : 'Me gusta'}</TooltipContent>
                    </Tooltip>
                  )}

                  {/* Compartir + descargar (en la Papelera no se comparte: el botón se oculta, como en el detalle) */}
                  {!track.trashed && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon" onClick={() => void share()} aria-label="Compartir canción" className="h-11 [@media(max-height:600px)]:h-9 w-full min-w-0 rounded-full">
                        <Share2 className="h-4 w-4" aria-hidden />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">Compartir</TooltipContent>
                  </Tooltip>
                  )}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => void download()}
                        disabled={downloading || (!downloadState.allowed && !downloadGate.locked) || !ownDownloadable}
                        aria-label="Descargar canción"
                        className="relative h-11 [@media(max-height:600px)]:h-9 w-full min-w-0 rounded-full"
                      >
                        {downloading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}
                        {ownDownloadable && <RequiredPlanBadge capability="DOWNLOAD_AUDIO" showCrownOnly className="absolute -right-0.5 -top-0.5 px-1 py-1" />}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">{track?.trashed ? 'No disponible: está en la Papelera' : !ownDownloadable ? 'Solo podés descargar tus propias canciones' : downloadGate.locked ? `${downloadGate.copy?.title ?? 'No incluido en tu plan'} · tocá para ver los planes` : downloadState.reason ?? (downloadState.hint ? `Descargar canción · ${downloadState.hint}` : 'Descargar canción')}</TooltipContent>
                  </Tooltip>
                </div>
              </TooltipProvider>
            </div>

            {/* Mobile: la letra no se muestra en la pantalla; se abre en un bottom sheet (si la canción tiene letra) */}
            {!hasNoLyrics && (
              <button
                ref={lyricsButtonRef}
                type="button"
                onClick={() => setLyricsOpen(true)}
                aria-haspopup="dialog"
                className="relative -ml-4 mt-auto mb-2 flex h-14 w-[calc(100%+1rem)] shrink-0 items-center rounded-r-[28px] bg-voice pl-7 text-left text-base font-bold tracking-wide text-on-voice transition-transform active:scale-[0.98] md:hidden"
              >
                Ver letra
                <span aria-hidden className="absolute top-1/2 right-1 flex size-12 -translate-y-1/2 items-center justify-center rounded-full bg-gold text-on-gold">
                  <Music4 className="h-5 w-5" />
                </span>
              </button>
            )}
          </div>
        </div>
      </div>
      {/* Cola de reproducción: bottom sheet (mobile) / panel derecho (desktop), como la del reproductor inferior. Va por encima del
          reproductor expandido (z-[70]). */}
      <Sheet open={queueOpen} onOpenChange={setQueueOpen}>
        <SheetContent
          side={isMobile ? 'bottom' : 'right'}
          overlayClassName="z-[75]"
          onCloseAutoFocus={(e) => {
            // El Sheet no tiene un SheetTrigger (el botón es propio): sin esto el foco se pierde en <body> al cerrar.
            e.preventDefault();
            queueButtonRef.current?.focus();
          }}
          className={cn(
            'z-[80] flex flex-col gap-0 border-border/70 bg-background/98 p-0',
            isMobile ? 'h-[85dvh] max-h-[85dvh]' : 'h-full w-full md:max-w-md'
          )}
        >
          <SheetHeader className="border-b border-border/70 py-4 pl-5 pr-16">
            <SheetTitle className="flex items-center gap-2.5 font-display text-lg">
              <ListMusic className="h-5 w-5 text-amber-strong" aria-hidden />
              Cola de reproducción
            </SheetTitle>
            <SheetDescription className="flex flex-wrap items-center gap-2 text-xs">
              {queue.length > 0 && (
                <span className="rounded-full bg-amber/15 px-2.5 py-0.5 font-semibold text-amber-strong tabular-nums">
                  {queue.length} {queue.length === 1 ? 'canción' : 'canciones'}
                </span>
              )}
              {shuffle && <span className="chip-shuffle-status">aleatorio activo</span>}
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 pb-safe">
            <QueueList emptyLabel="La cola está vacía." />
          </div>
          {/* Guardar la cola como colección (comparte lógica con el sheet del PlayerBar) */}
          <div className="border-t border-border/70 p-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setExportOpen(true)}
              disabled={queue.length === 0}
              className="w-full rounded-xl border-amber/30 bg-amber/10 text-amber-strong transition-colors hover:bg-amber/20 hover:text-amber-strong"
              aria-label="Guardar la cola como colección en Letristas"
            >
              <BookmarkPlus className="h-4 w-4" aria-hidden />
              Guardar como colección
            </Button>
          </div>
        </SheetContent>
      </Sheet>
      {/* Letra (solo mobile): bottom sheet sobre el reproductor expandido */}
      <Sheet open={lyricsOpen && isMobile && !hasNoLyrics} onOpenChange={setLyricsOpen}>
        <SheetContent
          side="bottom"
          overlayClassName="z-[75]"
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            lyricsButtonRef.current?.focus();
          }}
          className="z-[80] flex h-[85dvh] max-h-[85dvh] flex-col gap-0 border-border/70 bg-background/98 p-0"
        >
          <SheetHeader className="border-b border-border/70 py-4 pl-5 pr-16">
            <SheetTitle className="flex items-center gap-2.5 font-display text-lg">
              <Music4 className="h-5 w-5 text-amber-strong" aria-hidden />
              Letra
            </SheetTitle>
            <SheetDescription className="truncate text-xs">{track.title}</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 px-4 pt-2 pb-safe">{renderLyrics(true)}</div>
        </SheetContent>
      </Sheet>
      <ExportQueueDialog open={exportOpen} onOpenChange={setExportOpen} />
    </div>
  );
}
