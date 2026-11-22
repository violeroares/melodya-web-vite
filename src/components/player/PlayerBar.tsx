'use client';

/**
 * MELODYA WEB — PlayerBar global: un único <audio> persistente entre vistas.
 * Play/pausa, seek, volumen, velocidad (0.75×–1.5×), siguiente/anterior,
 * cola visible (sheet) y atajos de teclado: Espacio = play/pausa, ←/→ = ±5s,
 * M = silenciar, N/P = siguiente/anterior, L = me gusta (si no se está
 * escribiendo). Tras recargar, la última pista vuelve pausada donde quedó (sesión persistida)
 * y avisamos con un toast "seguimos donde quedaste".
 * Tocá la portada (o el chevron) para abrir el reproductor expandido.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Pause, SkipBack, SkipForward, Volume2, VolumeX, X, ListMusic, Keyboard, Gauge, Check, ChevronsUp, Shuffle, BookmarkPlus, Timer, Trash2 } from 'lucide-react';
import { usePlayerStore } from '@/stores/player';
import { cn } from '@/lib/utils';
import { CoverArt, EqualizerBars } from '@/components/common';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useToast } from '@/hooks/use-toast';
import { usePlanGate } from '@/hooks/use-plan-gate';
import { LOCKED_CONTROL, RequiredPlanBadge } from '@/components/common/PlanGate';
import { LOCK_REASON } from '@/lib/capabilities';
import { useRadioWatcher } from '@/hooks/use-radio';
import { ExpandedPlayer } from './ExpandedPlayer';
import { QueueList } from './QueueList';
import { toggleCurrentTrackLike, toastLikeOutcome } from '@/lib/like';
import { navigate } from '@/lib/router';
import { EXPAND_PLAYER_EVENT, OPEN_QUEUE_EVENT } from '@/components/common/CommandPalette';
import { Radio } from 'lucide-react';
import { ExportQueueDialog } from './ExportQueueDialog';
import { ShortcutsDialog } from './ShortcutsDialog';
import { Waveform } from './Waveform';

const SPEED_OPTIONS = [0.75, 1, 1.25, 1.5];

function speedLabel(v: number) {
  return `${v === 1 ? '1' : v.toFixed(2).replace(/0$/, '')}×`;
}

/** `withBottomNav`: en móvil el reproductor se apoya sobre el BottomNav (76px). Sin él (landing pública, que no lo muestra) baja al borde. */
export function PlayerBar({ withBottomNav = true }: { withBottomNav?: boolean } = {}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const volumeRef = useRef<HTMLDivElement | null>(null);
  const { track, queue, isPlaying, position, duration, volume, muted, speed, shuffle, sleepAt, sleepEndOfTrack, sessionRestored, setAudio, toggle, seek, setVolume, setSpeed, toggleMute, toggleShuffle, next, prev, stop, retryWithAuth, acknowledgeRestore } =
    usePlayerStore();
  const [queueOpen, setQueueOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const saveQueueGate = usePlanGate('LYRIC_PERSONAS'); // E5: la colección se guarda como letrista; sin la capacidad se muestra el aviso de upgrade
  const saveQueueLocked = saveQueueGate.locked;
  const [expanded, setExpanded] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const { toast } = useToast();
  const radioMode = usePlayerStore((s) => s.radioMode);
  const radioGenre = usePlayerStore((s) => s.radioGenre);
  const playbackError = usePlayerStore((s) => s.playbackError);

  useRadioWatcher();

  useEffect(() => {
    if (audioRef.current) setAudio(audioRef.current);
  }, [setAudio]);

  /* Si no se pudo cargar el audio autenticado (sesión vencida, sin permiso…) se avisa con el motivo real. */
  useEffect(() => {
    if (playbackError) toast({ title: 'No pudimos reproducir el audio', description: playbackError, variant: 'destructive' });
  }, [playbackError, toast]);

  /* Aviso una sola vez: la sesión del player se restauró tras recargar. */
  useEffect(() => {
    if (sessionRestored && track) {
      acknowledgeRestore();
      toast({
        title: 'Seguimos donde quedaste 🎧',
        description: `"${track.title}", pausada en el minuto en que la dejaste.`,
      });
    }
  }, [sessionRestored, track, acknowledgeRestore, toast]);

  /* Rueda del ratón sobre el volumen: ±5% (listener nativo no pasivo para
     poder evitar el scroll de la página). Al subir con mute activado, se
     reactiviza el sonido. */
  useEffect(() => {
    const el = volumeRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { volume, muted, setVolume, toggleMute } = usePlayerStore.getState();
      const delta = e.deltaY < 0 ? 0.05 : -0.05;
      if (muted && delta > 0) toggleMute();
      setVolume(Math.min(1, Math.max(0, volume + delta)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [track]);

  /* La command palette puede pedir abrir el reproductor expandido. */
  useEffect(() => {
    const onExpand = () => setExpanded(true);
    const onQueue = () => setQueueOpen(true);
    window.addEventListener(EXPAND_PLAYER_EVENT, onExpand);
    window.addEventListener(OPEN_QUEUE_EVENT, onQueue);
    return () => {
      window.removeEventListener(EXPAND_PLAYER_EVENT, onExpand);
      window.removeEventListener(OPEN_QUEUE_EVENT, onQueue);
    };
  }, []);

  /* ── Atajos de teclado globales (sin robar teclas cuando se escribe) ── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as Partial<HTMLElement> | null;
      // `t` puede ser `document` (eventos sintéticos): acceso defensivo.
      const typing =
        !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable === true || t.getAttribute?.('role') === 'textbox');
      if (typing) return;
      // ? = hoja completa de atajos (funciona siempre, sin tema en curso).
      if (e.key === '?') {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      if (!usePlayerStore.getState().track) return;
      /* ⇧+↑/↓ = volumen ±5 % (Shift cambia el significado de las flechas);
         subir con mute activado reactiva el sonido. */
      if (e.shiftKey && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) {
        e.preventDefault();
        const { volume, muted, setVolume, toggleMute } = usePlayerStore.getState();
        const delta = e.code === 'ArrowUp' ? 0.05 : -0.05;
        if (muted && delta > 0) toggleMute();
        setVolume(Math.min(1, Math.max(0, volume + delta)));
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        usePlayerStore.getState().toggle();
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        const { position, duration, seek } = usePlayerStore.getState();
        const max = duration > 0 ? Math.max(0, duration - 0.25) : position + 5;
        seek(Math.min(position + 5, max));
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        const { position, seek } = usePlayerStore.getState();
        seek(Math.max(0, position - 5));
      } else if (e.code === 'KeyM') {
        usePlayerStore.getState().toggleMute();
      } else if (e.code === 'KeyN') {
        usePlayerStore.getState().next();
      } else if (e.code === 'KeyP') {
        usePlayerStore.getState().prev();
      } else if (e.code === 'KeyQ') {
        // Q = abrir/cerrar la cola de reproducción.
        e.preventDefault();
        setQueueOpen((o) => !o);
      } else if (e.code === 'KeyS') {
        // S = activar/desactivar el orden aleatorio.
        usePlayerStore.getState().toggleShuffle();
      } else if (e.code === 'KeyL') {
        // Me gusta del tema en curso (solo pistas con metadatos de comunidad).
        const st = usePlayerStore.getState();
        if (!st.track?.community) return;
        void toggleCurrentTrackLike().then((outcome) => {
          if (outcome === 'guest') {
            toast({
              title: 'Ingresá para reaccionar',
              description: 'Creá tu cuenta gratis y dejá tu me gusta a otros melodiosos.',
            });
            navigate('/login');
            return;
          }
          if (outcome === 'ok' && st.track) toastLikeOutcome('ok', st.track.title);
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onTimeUpdate = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    /* Durante un seek Safari/iOS puede reportar todavía la posición anterior: se espera al «seeked» para no pisar la onda. */
    if (el.seeking) return;
    usePlayerStore.getState().syncTime(el.currentTime, el.duration || track?.durationSec || 0);
  }, [track?.durationSec]);

  const fmt = (s: number) => {
    if (!Number.isFinite(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const currentIdx = queue.findIndex((t) => track && t.id === track.id && t.audioUrl === track.audioUrl);

  /* Timer de sueño activo: chip con cuenta regresiva. Con el player pausado
     no hay timeupdate, así que un tick de 1s mantiene el chip al día. */
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!sleepAt) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [sleepAt]);
  // eslint-disable-next-line react-hooks/purity -- el tiempo restante se recalcula en cada tick de 1 s (setTick), a propósito
  const sleepRemaining = sleepAt ? Math.max(0, sleepAt - Date.now()) : 0;
  const sleepChipLabel = sleepEndOfTrack
    ? 'fin de la canción'
    : sleepAt
      ? `${Math.floor(sleepRemaining / 60000)}:${String(Math.floor((sleepRemaining % 60000) / 1000)).padStart(2, '0')}`
      : null;

  /* Vaciar la cola (queda el tema en curso) + deshacer desde el toast. */
  const onClearQueue = () => {
    const removed = usePlayerStore.getState().clearQueue();
    if (!removed) return;
    toast({
      title: 'Cola vaciada',
      description: `Se quitaron ${removed} ${removed === 1 ? 'canción' : 'canciones'}. Seguís escuchando el actual.`,
      action: (
        <button
          type="button"
          onClick={() => {
            if (usePlayerStore.getState().undoClearQueue()) {
              toast({ title: 'Cola restaurada', description: 'Volvimos a armar la cola como estaba.' });
            }
          }}
          className="toast-action-warm"
        >
          Deshacer
        </button>
      ),
    });
  };

  return (
    <>
      {/* El <audio> vive SIEMPRE en la misma posición del árbol (estable entre renders).
          crossOrigin="anonymous" desde el NACIMIENTO del elemento: cuando el API vive
          en otro origen (ej. localhost:4000) el stream se pide en modo CORS y el
          backend responde con Access-Control-Allow-Origin → el visualizador
          (Web Audio AnalyserNode) puede leer el audio sin que Chrome lo silencie
          ("MediaElementAudioSource outputs zeroes due to CORS access restrictions").
          Debe estar ANTES de asignar el src: un recurso ya cargado sin CORS queda
          "tainted" y corta el sonido al activar el visualizador. */}
      <audio ref={audioRef} crossOrigin="anonymous" onTimeUpdate={onTimeUpdate} onSeeked={onTimeUpdate} onError={() => void retryWithAuth()} preload="metadata" />
      {track && (
      <div
        role="region"
        aria-label="Reproductor"
        className={cn('pointer-events-none fixed inset-x-0 z-40 md:bottom-3', withBottomNav ? 'bottom-[76px]' : 'bottom-3')}
      >
        <div className="pointer-events-auto flex h-[72px] items-center gap-3 pr-3 sm:mr-4 sm:gap-4 sm:rounded-r-[36px] sm:bg-voice sm:pr-6 sm:text-on-voice sm:shadow-lg">
          {/* Tarjeta de la canción (design-V2): pegada al borde izquierdo, abre el reproductor expandido */}
          <div className="relative flex h-16 min-w-0 flex-1 items-center overflow-hidden rounded-r-[32px] bg-voice text-on-voice sm:w-56 sm:flex-initial sm:rounded-none lg:w-80 xl:w-[26rem] 2xl:w-[30rem] sm:bg-transparent">
            <button
              className="group flex h-full min-w-0 flex-1 items-center gap-3 pl-5 pr-2 text-left sm:pr-4 focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-gold"
              onClick={() => setExpanded(true)}
              aria-label={`Abrir reproductor expandido: ${track.title}`}
            >
              <div className="relative shrink-0">
                <CoverArt id={track.id} src={track.coverUrl} alt={track.title} className="size-11 transition-transform duration-200" rounded="rounded-full" />
                {isPlaying && (
                  <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-background">
                    <EqualizerBars className="h-2.5 scale-90" />
                  </span>
                )}
              </div>
              <div className="min-w-0 flex-1 leading-tight">
                <p className="truncate font-display text-[15px] font-bold">{track.title}</p>
                <p className="truncate text-xs opacity-80">{track.artist}</p>
              </div>
              <ChevronsUp className="hidden h-4 w-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-70 sm:block" aria-hidden />
            </button>
            {/* Mobile: reproducir/pausar y cerrar viven dentro de la cápsula (design-V2, "Pestañas") */}
            <div className="flex shrink-0 items-center gap-2 pr-3 sm:hidden">
              <button
                type="button"
                onClick={toggle}
                aria-label={isPlaying ? 'Pausar' : 'Reproducir'}
                className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-transform active:scale-95 focus-visible:outline-2 focus-visible:outline-on-voice"
              >
                {isPlaying ? <Pause className="h-5 w-5 fill-current" aria-hidden /> : <Play className="ml-0.5 h-5 w-5 fill-current" aria-hidden />}
              </button>
              {/* Cola de reproducción (como al inicio del proyecto: el ícono vive en el reproductor mobile) */}
              <button
                type="button"
                onClick={() => setQueueOpen(true)}
                aria-label={`Ver cola de reproducción${queue.length > 0 ? ` (${queue.length})` : ''}`}
                aria-haspopup="dialog"
                className="flex size-9 shrink-0 items-center justify-center rounded-full text-on-voice transition-colors hover:bg-on-voice/10 focus-visible:outline-2 focus-visible:outline-on-voice"
              >
                <ListMusic className="h-4 w-4" aria-hidden />
              </button>
              <button
                type="button"
                onClick={stop}
                aria-label="Cerrar reproductor"
                className="flex size-[34px] shrink-0 items-center justify-center rounded-full border border-on-voice/30 text-on-voice transition-colors hover:bg-on-voice/10 focus-visible:outline-2 focus-visible:outline-on-voice"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
            {/* Progreso: línea dorada en la base de la tarjeta (con la radio encendida fluye un shimmer ámbar) */}
            <span
              aria-hidden
              className={cn('pointer-events-none absolute bottom-0 left-5 h-[3px] sm:hidden origin-left rounded-full bg-gold transition-transform duration-300', radioMode && 'radio-thread')}
              style={{ width: 'calc(100% - 2.5rem)', transform: `scaleX(${duration > 0 ? Math.min(1, position / duration) : 0})` }}
            />
          </div>

          {/* Controles + progreso */}
          <div className="hidden min-w-0 flex-none items-center gap-2 sm:flex sm:flex-[2] sm:justify-center sm:gap-3">
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                onClick={toggleShuffle}
                aria-pressed={shuffle}
                aria-label={shuffle ? 'Desactivar orden aleatorio' : 'Reproducir en orden aleatorio'}
                title={`Orden aleatorio · atajo S${shuffle ? ' (activo)' : ''}`}
                className={cn('hidden h-9 w-9 rounded-full md:inline-flex','sm:text-on-voice sm:hover:bg-on-voice/10 sm:hover:text-on-voice', shuffle && 'sm:bg-on-voice sm:text-voice sm:hover:bg-on-voice sm:hover:text-voice')}
              >
                <Shuffle className={cn('h-4 w-4', shuffle && 'shuffle-on')} aria-hidden />
              </Button>
              <Button variant="ghost" size="icon" className="hidden size-10 rounded-full border-[1.5px] border-line sm:inline-flex sm:border-on-voice/30 sm:text-on-voice sm:hover:bg-on-voice/10 sm:hover:text-on-voice" onClick={prev} aria-label="Anterior">
                <SkipBack className="h-4 w-4" aria-hidden />
              </Button>
              <button
                onClick={toggle}
                aria-label={isPlaying ? 'Pausar' : 'Reproducir'}
                className={cn(
                  'flex size-12 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-transform active:scale-95 focus-visible:outline-2 focus-visible:outline-on-voice',
                  isPlaying && 'pulse-ring'
                )}
              >
                {isPlaying ? <Pause className="h-5 w-5 fill-current" aria-hidden /> : <Play className="ml-0.5 h-5 w-5 fill-current" aria-hidden />}
              </button>
              <Button variant="ghost" size="icon" className="hidden size-10 rounded-full border-[1.5px] border-line sm:inline-flex sm:border-on-voice/30 sm:text-on-voice sm:hover:bg-on-voice/10 sm:hover:text-on-voice" onClick={next} aria-label="Siguiente">
                <SkipForward className="h-4 w-4" aria-hidden />
              </Button>
            </div>

            <span className="hidden w-9 text-right text-[11px] tabular-nums text-muted-foreground xl:inline sm:text-on-voice/70">{fmt(position)}</span>
            <Waveform onVoice className="hidden h-8 min-w-[3.5rem] max-w-[22rem] flex-1 md:block" seed={track.id} position={position} duration={duration || track.durationSec || 0} onSeek={seek} />
            <span className="hidden w-9 text-[11px] tabular-nums text-muted-foreground xl:inline sm:text-on-voice/70">{fmt(duration || track.durationSec || 0)}</span>
          </div>

          {/* Volumen + velocidad + cola + cerrar */}
          <div className="hidden shrink-0 items-center gap-1.5 sm:flex lg:min-w-64">
            <TooltipProvider delayDuration={300}>
              {/* Timer de sueño activo: chip con cuenta regresiva → reproductor expandido */}
              {sleepChipLabel && (
                <button
                  type="button"
                  onClick={() => setExpanded(true)}
                  className="sleep-chip mr-0.5 hidden shrink-0 items-center gap-1.5 rounded-full border border-amber/40 bg-amber/10 px-2.5 py-1 text-[11px] font-bold text-amber-strong xl:inline-flex"
                  aria-label={`Timer de sueño activo: pausa en ${sleepChipLabel}. Tocá para ver las opciones.`}
                  title="Timer de sueño activo · tocá para cambiarlo o desactivarlo"
                >
                  <Timer className="h-3 w-3" aria-hidden />
                  <span className="tabular-nums">{sleepChipLabel}</span>
                </button>
              )}
              {radioMode && (
                <span
                  className="mr-0.5 hidden items-center gap-1.5 rounded-full border border-amber/40 bg-amber/10 px-2.5 py-1 text-[11px] font-semibold text-amber-strong xl:inline-flex"
                  title={`Radio de la comunidad${radioGenre ? ` · ${radioGenre}` : ''}: se van sumando canciones solas`}
                >
                  <Radio className="h-3 w-3 animate-pulse" aria-hidden />
                  Radio{radioGenre ? <span className="max-w-24 truncate">· {radioGenre}</span> : null}
                </span>
              )}
              <div className="flex items-center gap-1" ref={volumeRef} title="Volumen · rueda del ratón">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-9 w-9 rounded-full sm:text-on-voice sm:hover:bg-on-voice/10 sm:hover:text-on-voice" onClick={toggleMute} aria-label={muted ? 'Activar sonido' : 'Silenciar'}>
                      {muted || volume === 0 ? <VolumeX className="h-4 w-4" aria-hidden /> : <Volume2 className="h-4 w-4" aria-hidden />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">Volumen · atajo M · rueda del ratón</TooltipContent>
                </Tooltip>
                <Slider
                  value={[muted ? 0 : volume * 100]}
                  max={100}
                  step={1}
                  onValueChange={(v) => setVolume(v[0] / 100)}
                  className="slider-warm w-16 flex-1 max-lg:hidden lg:w-20 [&_[data-slot=slider-track]]:bg-on-voice/25!"
                  aria-label="Volumen"
                />
              </div>
              {/* Velocidad de reproducción */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label="Velocidad de reproducción"
                        className={cn('h-9 rounded-full px-2.5 font-semibold tabular-nums max-md:hidden','sm:text-on-voice sm:hover:bg-on-voice/10 sm:hover:text-on-voice', speed !== 1 && 'sm:bg-on-voice sm:text-voice sm:hover:bg-on-voice sm:hover:text-voice')}
                      >
                        <Gauge className="h-3.5 w-3.5" aria-hidden />
                        {speedLabel(speed)}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-32">
                      {SPEED_OPTIONS.map((v) => (
                        <DropdownMenuItem key={v} onClick={() => setSpeed(v)} className="cursor-pointer rounded-lg tabular-nums">
                          {v === 1 ? 'Normal (1×)' : speedLabel(v)}
                          {speed === v && <Check className="ml-auto h-3.5 w-3.5 text-amber-strong" aria-hidden />}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TooltipTrigger>
                <TooltipContent side="top">Velocidad de reproducción</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn('h-9 w-9 rounded-full','sm:text-on-voice sm:hover:bg-on-voice/10 sm:hover:text-on-voice', queueOpen && 'sm:bg-on-voice sm:text-voice sm:hover:bg-on-voice sm:hover:text-voice')}
                    onClick={() => setQueueOpen(true)}
                    aria-label="Ver cola de reproducción"
                  >
                    <ListMusic className="h-4 w-4" aria-hidden />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  Cola de reproducción · {queue.length > 0 && currentIdx >= 0 ? `${currentIdx + 1} de ${queue.length}` : queue.length}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          {/* Radio en mobile (la cola se abre desde el reproductor expandido) */}
          {radioMode && (
            <span className="flex items-center gap-1 rounded-full border border-amber/40 bg-amber/10 px-2 py-0.5 text-[10px] font-bold text-amber-strong sm:hidden" aria-label="Radio de la comunidad encendida">
              <Radio className="h-3 w-3 animate-pulse" aria-hidden />
              FM
            </span>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="hidden h-9 w-9 rounded-full opacity-60 hover:opacity-100 sm:inline-flex sm:text-on-voice sm:hover:bg-on-voice/10 sm:hover:text-on-voice"
            onClick={stop}
            aria-label="Cerrar reproductor"
          >
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </div>
      )}

      {/* ── Cola de reproducción ── */}
      <Sheet open={queueOpen} onOpenChange={setQueueOpen}>
        <SheetContent
          side="right"
          className="flex w-full flex-col gap-0 border-border/70 bg-background/98 p-0 md:max-w-md"
        >
          <SheetHeader className="border-b border-border/70 py-4 pl-5 pr-16">
            <SheetTitle className="flex items-center gap-2.5 font-display text-lg">
              <ListMusic className="h-5 w-5 text-amber-strong" aria-hidden />
              Cola de reproducción
              <span className="ml-auto flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-full text-muted-foreground hover:text-amber-strong"
                  onClick={() => setShortcutsOpen(true)}
                  aria-label="Ver atajos de teclado"
                  title="Atajos de teclado (?)"
                >
                  <Keyboard className="h-4 w-4" aria-hidden />
                </Button>
                {queue.length > 1 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-full text-muted-foreground hover:text-destructive"
                    onClick={onClearQueue}
                    aria-label="Vaciar la cola (conserva la canción en curso)"
                    title="Vaciar la cola (queda la canción actual)"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                )}
              </span>
            </SheetTitle>
            {/* Los atajos viven en el botón del teclado de arriba (modal de atajos). Debajo del título: cantidad de temas y aviso de aleatorio. */}
            <SheetDescription className="flex flex-wrap items-center gap-2 text-xs">
              {queue.length > 0 && (
                <span className="rounded-full bg-amber/15 px-2.5 py-0.5 font-semibold text-amber-strong tabular-nums">
                  {queue.length} {queue.length === 1 ? 'canción' : 'canciones'}
                </span>
              )}
              {shuffle && <span className="chip-shuffle-status">aleatorio activo</span>}
              <span className="sr-only">Los atajos de teclado están en el botón del teclado.</span>
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 pb-safe">
            <QueueList />
          </div>
          {/* Guardar la cola como colección (POST /lyric-personas con songIds) */}
          <div className="border-t border-border/70 p-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => (saveQueueLocked ? saveQueueGate.prompt() : setExportOpen(true))}
              disabled={queue.length === 0}
              aria-disabled={saveQueueLocked || undefined}
              title={saveQueueLocked ? LOCK_REASON.LYRIC_PERSONAS : undefined}
              className={cn('w-full rounded-xl border-amber/30 bg-amber/10 text-amber-strong transition-colors hover:bg-amber/20 hover:text-amber-strong', saveQueueLocked && LOCKED_CONTROL)}
              aria-label="Guardar la cola como colección en Letristas"
            >
              <BookmarkPlus className="h-4 w-4" aria-hidden />
              Guardar como colección
              <RequiredPlanBadge capability="LYRIC_PERSONAS" />
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      <ExportQueueDialog open={exportOpen} onOpenChange={setExportOpen} />

      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />

      {/* ── Reproductor expandido ("Sonando ahora") ── */}
      <ExpandedPlayer open={expanded} onClose={() => setExpanded(false)} audioRef={audioRef} />
    </>
  );
}
