
/**
 * MELODYA WEB — LyricsStudio: asistente de letras a pantalla completa.
 *
 * Funcionalidades:
 *  - Genera letras mediante POST /assistant/lyrics (con Idempotency-Key). Un 202, un timeout, un corte de red o
 *    un error HTTP NO son "Letra lista": quedan como solicitud pendiente que se recupera con la MISMA clave o,
 *    si se conoce operation.id, con GET /generations/{id} (lógica pura en lib/assistant-lyrics/flow).
 *  - Permite definir género, energía, tono, duración, idioma, estructura,
 *    palabras que deben aparecer y letrista.
 *  - Editor con inserción rápida de etiquetas de sección en español
 *    ([Verso 1], [Coro], [Puente]…) y detección bilingüe (ES/EN).
 *  - Ajustes rápidos y "Mejorar" sobre la letra actual, con historial de
 *    versiones para volver atrás.
 *  - Importa una letra existente (pegada o desde .txt/.md) y la formatea con Melodya.
 *  - Guarda letras en Mis Letras, copia y limpia (la biblioteca vive en Biblioteca → Letras).
 *
 * La estructura y las etiquetas las resuelve el backend (SYSTEM_LYRICS): este
 * componente ya NO agrega instrucciones de estructura a la idea.
 */

import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Wand2,
  Loader2,
  Check,
  Save,
  PenLine,
  Sparkles,
  RefreshCw,
  FileText,
  Copy,
  Eraser,
  Upload,
  BookOpen,
  ArrowLeft,
  Search,
  ClipboardPaste,
  Plus,
  Music2,
  ListMusic,
  Undo2,
  ArrowRight,
  ChevronDown,
  Mic2,
  Guitar,
  Heart,
  Disc3,
  Flame,
  Mountain,
  PartyPopper,
  type LucideIcon,
} from 'lucide-react';

import { assistantApi, generationApi, lyricsApi, songwritersApi, type AssistantLyricsRequest } from '@/lib/api';
import { toUserMessage } from '@/lib/errors';
import { useAuthStore } from '@/stores/auth';
import {
  createLyricsController,
  describePending,
  editorSignature,
  improveLyricsTooLong,
  newIdempotencyKey,
  runPolling,
  type CheckOutcome,
  type KeyValueStorage,
  type OperationSnapshot,
  type SubmitOutcome,
} from '@/lib/assistant-lyrics/flow';
import { useToast } from '@/hooks/use-toast';
import { useCapabilityLocked } from '@/hooks/use-capabilities';
import { LOCK_REASON } from '@/lib/capabilities';
import { useUpgradePrompt } from '@/stores/upgrade-prompt';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { CanvasTextarea } from '@/components/common/CanvasTextarea';
import { useDebounce } from '@/hooks';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { Chip } from '@/components/common';
import { ExpandableLyrics } from '@/features/creator/PlanetEditors';

import {
  IMPORT_INSTRUCTIONS,
  IMPORT_MAX_CHARS,
  LyricsImportDialog,
  type ImportMode,
  type LyricsImportDraft,
} from './LyricsImportDialog';
import { LIMITS } from './song-model';

export interface StudioOutcome {
  title: string;
  lyrics: string;
}

interface GenerateOpts {
  instruction?: string;
  mode?: 'create' | 'improve';
  /** Letra importada: reemplaza a la del editor (y no viaja la idea del panel). */
  existing?: StudioOutcome;
}

function randomUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function safeSessionStorage(): KeyValueStorage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Constantes                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Máximo de la letra para generar la canción (serie V6). El backend la RECHAZA (422) si lo supera; no la recorta. La web no
 * elige el modelo, así que no puede saber si otro modelo admite menos: ese caso lo informa el backend al crear.
 */
const LYRICS_SOFT_LIMIT = LIMITS.lyrics;
/** Instrucción por defecto de "Mejorar" cuando el usuario no escribe una. */
const DEFAULT_IMPROVE_INSTRUCTION =
  'Mejorá las imágenes, la métrica, las rimas y la naturalidad de las frases.';
/** Extensiones de archivo que se pueden importar (se leen en el navegador). */
const IMPORT_FILE_EXTENSIONS = ['.txt', '.md'];
/** Versiones previas que se conservan para "Deshacer". */
const MAX_HISTORY = 10;

const STRUCTURE_PRESETS = [
  {
    id: 'free',
    label: 'Libre',
    value: undefined,
    description: 'Melodya decide la estructura según la canción.',
  },
  {
    id: 'classic',
    label: 'Clásica',
    value: ['verse', 'chorus', 'verse', 'chorus', 'bridge', 'chorus'],
    description: 'Verso · coro · verso · coro · puente · coro',
  },
  {
    id: 'short',
    label: 'Corta',
    value: ['verse', 'chorus', 'chorus'],
    description: 'Directa y breve',
  },
  {
    id: 'story',
    label: 'Historia',
    value: ['verse', 'verse', 'chorus', 'verse', 'chorus', 'outro'],
    description: 'Más espacio para desarrollar la historia',
  },
  {
    id: 'build',
    label: 'Creciente',
    value: ['intro', 'verse', 'pre-chorus', 'chorus', 'verse', 'chorus', 'bridge', 'chorus', 'outro'],
    description: 'Empieza simple y crece hacia el final',
  },
  {
    id: 'hook',
    label: 'Hook primero',
    value: ['hook', 'verse', 'chorus', 'verse', 'chorus', 'bridge', 'chorus'],
    description: 'Arranca con una frase fuerte y memorable',
  },
];

const LANGUAGES = [
  { id: 'español', label: 'Español' },
  { id: 'español rioplatense', label: 'Español (rioplatense)' },
  { id: 'inglés', label: 'Inglés' },
  { id: 'portugués', label: 'Portugués' },
];

/** El backend recibe el estilo en `genre` (máx. 120 caracteres). */
const STYLE_MAX_CHARS = 120;

/** Atajos para empezar: se suman al texto del estilo, no son campos aparte. */
const STYLE_SUGGESTIONS = [
  'Pop',
  'Rock',
  'Cumbia',
  'Balada',
  'Trap',
  'Reggaetón',
  'Folklore',
  'Cuarteto',
];

/** Ícono de cada atajo de estilo: aparece dentro del chip cuando está elegido (design-V2, configuracion-estilo). */
const STYLE_ICONS: Record<string, LucideIcon> = {
  Pop: Mic2,
  Rock: Guitar,
  Cumbia: Music2,
  Balada: Heart,
  Trap: Disc3,
  Reggaetón: Flame,
  Folklore: Mountain,
  Cuarteto: PartyPopper,
};

const DURATIONS = [
  { id: 'short', label: 'Corta', hint: '~1 min', seconds: 60 },
  { id: 'medium', label: 'Media', hint: '~2 min', seconds: 120 },
  { id: 'long', label: 'Larga', hint: '~3 min', seconds: 180 },
];

/** Ajustes DESPUÉS de generar: se aplican sobre la letra actual. */
const REFINE_ACTIONS = [
  { label: 'Estribillo más pegadizo', instruction: 'Hacé el estribillo más corto, pegadizo y fácil de recordar.' },
  { label: 'Versos más cortos', instruction: 'Acortá los versos para que sean más cantables y bailables.' },
  { label: 'Más imágenes concretas', instruction: 'Reemplazá frases abstractas o genéricas por imágenes y detalles concretos de la idea.' },
  { label: 'Más emotiva', instruction: 'Hacé la letra más emotiva y sincera, sin caer en clichés.' },
  { label: 'Más humor', instruction: 'Agregá humor y picardía sin perder la idea central.' },
  { label: 'Rimas más naturales', instruction: 'Corregí las rimas forzadas; si una rima suena artificial, reescribí la frase.' },
];

/* -------------------------------------------------------------------------- */
/* Etiquetas estructurales (español, como las escribe el backend)               */
/* -------------------------------------------------------------------------- */

type LyricsTagDefinition = {
  /** Texto de la etiqueta: [base] o [base N] si es numerada. */
  base: string;
  /** Nombres (ES/EN, en minúscula) que cuentan como "ya presente". */
  aliases: string[];
  label: string;
  description: string;
  numbered?: boolean;
};

const LYRICS_TAGS: LyricsTagDefinition[] = [
  { base: 'Intro', aliases: ['intro'], label: 'Intro', description: 'Inicio de la canción.' },
  { base: 'Verso', aliases: ['verso', 'verse'], label: 'Verso', numbered: true, description: 'Parte narrativa o principal de la historia.' },
  { base: 'Pre-Coro', aliases: ['pre-coro', 'pre-chorus'], label: 'Pre-coro', description: 'Prepara y lleva al estribillo.' },
  { base: 'Coro', aliases: ['coro', 'chorus', 'estribillo'], label: 'Estribillo', description: 'La parte más repetitiva y memorable.' },
  { base: 'Post-Coro', aliases: ['post-coro', 'post-chorus'], label: 'Post-coro', description: 'Frase o sección que sigue al estribillo.' },
  { base: 'Puente', aliases: ['puente', 'bridge'], label: 'Puente', description: 'Rompe la repetición y aporta contraste.' },
  { base: 'Breakdown', aliases: ['breakdown'], label: 'Breakdown', description: 'Reducción o cambio fuerte de energía.' },
  { base: 'Build', aliases: ['build', 'build up'], label: 'Build', description: 'Aumenta progresivamente la tensión.' },
  { base: 'Drop', aliases: ['drop'], label: 'Drop', description: 'Entrada fuerte del ritmo o instrumental.' },
  { base: 'Solo', aliases: ['solo'], label: 'Solo', description: 'Momento instrumental destacado.' },
  { base: 'Instrumental', aliases: ['instrumental', 'instrumental break'], label: 'Instrumental', description: 'Sección sin letra cantada.' },
  { base: 'Hook', aliases: ['hook'], label: 'Hook', description: 'Frase corta y memorable.' },
  { base: 'Coro final', aliases: ['coro final', 'final chorus'], label: 'Estribillo final', description: 'Último estribillo, normalmente con más intensidad.' },
  { base: 'Outro', aliases: ['outro'], label: 'Outro', description: 'Cierre de la canción.' },
  { base: 'Fade Out', aliases: ['fade out'], label: 'Fade Out', description: 'Final que se desvanece progresivamente.' },
];

/* -------------------------------------------------------------------------- */
/* Detección de estructura (acepta etiquetas en español e inglés)               */
/* -------------------------------------------------------------------------- */

const STRUCTURE_TAG_REGEX =
  /\[(intro|verse|verso|pre-?chorus|pre-?coro|chorus|coro|estribillo|post-?chorus|post-?coro|bridge|puente|breakdown|build(?: up)?|drop|break|interlude|interludio|instrumental(?: break)?|solo|outro|final chorus|coro final|fade out|hook)[^\]]*\]/gi;

const ANY_TAG_REGEX = /\[[^\]]+\]/g;

function detectStructure(lyrics: string): string[] {
  if (!lyrics.trim()) return [];
  return lyrics.match(STRUCTURE_TAG_REGEX) ?? [];
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

/** Cuántas etiquetas de este tipo hay ya en la letra. */
function countTags(lyrics: string, item: LyricsTagDefinition): number {
  return (lyrics.match(ANY_TAG_REGEX) ?? []).filter((raw) => {
    const inner = raw.slice(1, -1).trim().toLowerCase();
    return item.aliases.some(
      (a) =>
        inner === a ||
        inner.startsWith(`${a} - `) ||
        (item.numbered && new RegExp(`^${a}\\s+\\d+`).test(inner)),
    );
  }).length;
}

/** [Verso 1] → si ya hay 2 versos, inserta [Verso 3]. */
function buildTag(item: LyricsTagDefinition, lyrics: string): string {
  if (!item.numbered) return `[${item.base}]`;
  return `[${item.base} ${countTags(lyrics, item) + 1}]`;
}

/* -------------------------------------------------------------------------- */
/* Inserción de etiquetas                                                      */
/* -------------------------------------------------------------------------- */

function insertTagAtCursor(
  textarea: HTMLTextAreaElement,
  lyrics: string,
  tag: string,
): { value: string; cursor: number } {
  const start = textarea.selectionStart ?? lyrics.length;
  const end = textarea.selectionEnd ?? start;

  const before = lyrics.slice(0, start);
  const selected = lyrics.slice(start, end);
  const after = lyrics.slice(end);

  const needsBeforeBreak =
    before.length > 0 && !before.endsWith('\n') && !before.endsWith('\n\n');
  const needsAfterBreak = after.length > 0 && !after.startsWith('\n');

  const prefix = needsBeforeBreak ? '\n\n' : '';
  const suffix = needsAfterBreak ? '\n\n' : '';

  const inserted = `${prefix}${tag}\n${selected}${suffix}`;
  const value = `${before}${inserted}${after}`;
  const cursor = before.length + prefix.length + tag.length + 1 + selected.length;

  return { value, cursor };
}

/* -------------------------------------------------------------------------- */
/* Componente                                                                   */
/* -------------------------------------------------------------------------- */

export function LyricsStudio({
  open,
  onOpenChange,
  initialIdea,
  initialGenre,
  initialLyrics,
  initialLyricsTitle,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialIdea?: string;
  initialGenre?: string;
  /** Letra existente que se abre directo en el editor (Biblioteca → Mejorar con Melodya). */
  initialLyrics?: string;
  initialLyricsTitle?: string;
  onApply: (outcome: StudioOutcome) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  // E5: sin asistente de letras en el plan, el estudio sigue sirviendo para pegar, subir y guardar letras propias, pero no escribe ni mejora.
  const lyricsAiLocked = useCapabilityLocked('LYRICS_AI');
  const showUpgrade = useUpgradePrompt((st) => st.show);

  const lyricsTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Inicialización lazy (el estudio puede recibir estos valores al abrirse).
  const [idea, setIdea] = useState(() => initialIdea ?? '');
  const [style, setStyle] = useState(() => initialGenre ?? '');

  const [duration, setDuration] = useState('');
  const [mustInclude, setMustInclude] = useState('');
  const [structure, setStructure] = useState<string>('free');
  const [language, setLanguage] = useState('español rioplatense');
  const [personaId, setPersonaId] = useState('none');

  const initialOutcome: StudioOutcome | null = initialLyrics?.trim()
    ? { title: initialLyricsTitle?.trim() || 'Sin título', lyrics: initialLyrics }
    : null;
  const [result, setResult] = useState<StudioOutcome | null>(() => initialOutcome);
  const [editing, setEditing] = useState<StudioOutcome | null>(() => initialOutcome);
  const [history, setHistory] = useState<StudioOutcome[]>([]);
  const [refineText, setRefineText] = useState('');

  const [saving, setSaving] = useState(false);

  // Solicitudes al asistente sin resultado confirmado: la lógica vive en lib/assistant-lyrics/flow (probada con node --test).
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const [controller] = useState(() =>
    createLyricsController({
      post: (body, key) => assistantApi.lyricsAttempt(body as AssistantLyricsRequest, key),
      getOperation: (id) => generationApi.get(id) as unknown as Promise<OperationSnapshot>,
      getStorage: safeSessionStorage,
      makeKey: () => newIdempotencyKey(randomUUID),
    }),
  );
  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const generating = snap.busy;
  const pending = snap.pending;
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const lastOptsRef = useRef<GenerateOpts | null>(null);
  const editingRef = useRef<StudioOutcome | null>(null);

  // Importación de una letra existente (pegar / archivo): `importSeed` remonta el diálogo.
  const [importOpen, setImportOpen] = useState(false);
  const [importSeed, setImportSeed] = useState(0);
  const [importDraft, setImportDraft] = useState<LyricsImportDraft>({ title: '', text: '' });
  // 'saved' = listado amplio de letras guardadas, solo para elegir una (la biblioteca vive en Biblioteca → Letras).
  const [view, setView] = useState<'studio' | 'saved'>('studio');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /* ------------------------------------------------------------------------ */
  /* Letristas                                                                  */
  /* ------------------------------------------------------------------------ */

  const [savedSearch, setSavedSearch] = useState('');
  const savedSearchTerm = useDebounce(savedSearch.trim(), 300);

  const { data: savedLyrics, isLoading: savedLoading } = useQuery({
    queryKey: ['lyrics', 'studio', view, savedSearchTerm],
    queryFn: () => lyricsApi.list({ pageSize: 50, ...(savedSearchTerm ? { search: savedSearchTerm } : {}) }),
    enabled: open && view === 'saved',
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  const { data: personas } = useQuery({
    queryKey: ['personas', 'studio'],
    queryFn: () => songwritersApi.list({ pageSize: 50 }),
    enabled: open,
    staleTime: 60_000,
  });

  /* ------------------------------------------------------------------------ */
  /* Abrir/cerrar                                                               */
  /* ------------------------------------------------------------------------ */

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      // Al abrir desde CreatorWizard completamos solo los campos vacíos.
      if (!idea.trim() && initialIdea?.trim()) setIdea(initialIdea);
      if (!style.trim() && initialGenre?.trim()) setStyle(initialGenre);
    }
    onOpenChange(nextOpen);
  };

  /* ------------------------------------------------------------------------ */
  /* Generación                                                                 */
  /* ------------------------------------------------------------------------ */

  useEffect(() => {
    editingRef.current = editing;
  }, [editing]);

  /** Aplica una letra VÁLIDA al editor (con historial para volver atrás). */
  const acceptOutcome = (outcome: StudioOutcome, title: string, description: string) => {
    const previous = editingRef.current;
    if (previous?.lyrics?.trim()) {
      setHistory((h) => [...h, previous].slice(-MAX_HISTORY));
    }
    setResult(outcome);
    setEditing(outcome);
    toast({ title, description });
  };

  const buildBody = (opts: GenerateOpts): AssistantLyricsRequest => {
    const isImprove = opts.mode === 'improve';
    const effectiveIdea = opts.existing ? '' : idea.trim();
    const base = opts.existing ?? editing;
    const preset = STRUCTURE_PRESETS.find((p) => p.id === structure);
    const durationSec = DURATIONS.find((d) => d.id === duration)?.seconds;

    // La estructura, el tono, la duración y las palabras obligatorias viajan
    // como parámetros propios (el backend arma el prompt). Al "mejorar" una
    // letra existente NO se manda estructura: se conserva la actual.
    return {
      ...(effectiveIdea.length >= 3 ? { idea: effectiveIdea } : {}),
      // Mejorar: la letra y el título viajan aparte (no dentro de la idea).
      ...(isImprove && base
        ? {
            existingLyrics: base.lyrics,
            existingTitle: base.title,
            ...(opts.instruction ? { instruction: opts.instruction } : {}),
          }
        : {}),
      genre: style.trim() || undefined,
      language,
      ...(!isImprove && preset?.value ? { structure: preset.value } : {}),
      ...(personaId !== 'none' ? { lyricPersonaId: personaId } : {}),
      ...(!isImprove && durationSec ? { durationSec } : {}),
      ...(!isImprove && mustInclude.trim() ? { mustInclude: mustInclude.trim() } : {}),
    };
  };

  /** Traduce el resultado del controlador a lo que ve la persona. Solo un 200 con letra válida es "Letra lista". */
  const announce = (out: SubmitOutcome, opts: GenerateOpts): boolean => {
    const isImprove = opts.mode === 'improve';
    switch (out.kind) {
      case 'superseded':
        return false; // la letra ya la entregó la consulta por GET (o se descartó la solicitud)
      case 'completed':
        if (out.editorChanged) {
          // Modificaste el editor mientras esperabas (o no hay línea base fiable): no se pisa. Queda en el aviso.
          toast({ title: 'Tu letra está lista', description: 'Modificaste el editor mientras esperabas, así que no la aplicamos sola. Aceptala desde el aviso.' });
          return false;
        }
        acceptOutcome(
          { title: out.title, lyrics: out.lyrics },
          opts.existing ? '✨ Letra importada' : isImprove ? '✨ Letra mejorada' : '✨ Letra lista',
          opts.existing
            ? 'Revisala en el editor y guardala cuando te guste.'
            : isImprove
            ? 'Si no te convence, podés volver a la versión anterior.'
            : 'Creada con Melodya. Editala a tu gusto o usala así.',
        );
        return true;
      case 'unauthenticated':
        toast({ title: 'Tu sesión todavía se está cargando', description: 'Probá de nuevo en unos segundos.' });
        return false;
      case 'blocked':
        toast({
          title: 'Tenés una solicitud sin resolver',
          description: 'Primero recuperá esa letra (Consultar ahora) o descartá la referencia desde el aviso. No enviamos nada nuevo para no crear una segunda solicitud.',
          variant: 'destructive',
        });
        return false;
      case 'resume':
        toast({ title: 'Consultando tu solicitud', description: 'Ya la teníamos: vemos su estado sin generar otra.' });
        return false;
      case 'pending':
        toast({
          title: out.uncertain ? 'Resultado pendiente de confirmación' : out.cause === 'accepted' ? 'Tu letra todavía no está lista' : 'No pudimos confirmar el resultado',
          description: out.uncertain
            ? 'No pudimos confirmar el estado de esta solicitud y no la pedimos de nuevo por tu cuenta. Podés ver su estado en el aviso.'
            : out.cause === 'accepted'
            ? 'Tu solicitud quedó registrada y consultamos su estado. No hace falta volver a generarla.'
            : 'Tu solicitud pudo haber llegado. Reintentá desde el aviso: recuperamos la misma, no se crea otra.',
        });
        return false;
      case 'rate-limited':
        toast({
          title: 'Llegaste al límite de solicitudes',
          description: out.kept
            ? 'Tu solicitud anterior sigue sin confirmar y la conservamos. Reintentá más tarde desde el aviso: es la misma, no se crea otra.'
            : 'Probá de nuevo en un rato.',
          variant: out.kept ? undefined : 'destructive',
        });
        return false;
      case 'rejected':
        toast({
          title: 'No pudimos generar la letra',
          description:
            out.reason === 'key-conflict'
              ? 'Esa solicitud ya existía con otros datos. Volvé a intentar.'
              : out.reason === 'pricing-not-configured'
              ? 'Todavía no podemos generar esta letra: falta terminar la configuración del servicio de letras. No se descontaron fichas. Si el problema continúa, avisale al equipo de Melodya.'
              : out.reason === 'no-lyrics-provider'
              ? 'En este momento no hay un servicio de letras disponible para esta acción. No se descontaron fichas. Probá de nuevo en unos minutos.'
              : out.message ?? (out.reason === 'insufficient-credits' ? 'No tenés fichas suficientes.' : 'Revisá los datos e intentá de nuevo.'),
          variant: out.kept ? undefined : 'destructive',
        });
        return false;
      case 'failed':
        toast({
          title: 'La letra no se pudo generar',
          description:
            out.reason === 'not-active'
              ? 'La operación se canceló antes de terminar. Podés generar una nueva.'
              : 'El proveedor no devolvió una letra. Podés volver a intentarlo.',
          variant: 'destructive',
        });
        return false;
      default:
        return false; // busy / no-request: no hay nada que mostrar
    }
  };

  const generate = async (opts: GenerateOpts = {}): Promise<boolean> => {
    if (generating) return false;
    if (lyricsAiLocked) {
      showUpgrade('LYRICS_AI'); // respaldo: las entradas al asistente ya muestran el aviso de upgrade antes de abrirlo
      return false;
    }

    const isImprove = opts.mode === 'improve';
    const effectiveIdea = opts.existing ? '' : idea.trim();

    // Al mejorar, la letra existente es el insumo: la idea del panel es opcional.
    if (!isImprove && effectiveIdea.length < 3) {
      toast({
        title: 'Contanos tu idea primero',
        description: 'Aunque sea una frase corta: de qué va la canción.',
      });
      return false;
    }

    // Mejorar: el backend admite hasta 5000 caracteres de letra existente. Se avisa ANTES de enviar; no se recorta ni se toca el editor.
    if (isImprove && improveLyricsTooLong((opts.existing ?? editingRef.current)?.lyrics ?? '')) {
      toast({
        title: 'La letra es demasiado larga para mejorarla',
        description: `Para mejorarla con Melodya puede tener hasta ${LIMITS.lyrics.toLocaleString('es-AR')} caracteres. Acortala o mejorala por partes: no la modificamos.`,
        variant: 'destructive',
      });
      return false;
    }

    lastOptsRef.current = opts;
    return announce(
      await controller.submit(buildBody(opts), userId, editorSignature(editingRef.current), () => editorSignature(editingRef.current)),
      opts,
    );
  };

  /** Reintento EXPLÍCITO de la última solicitud: mismo body exacto ⇒ misma clave ⇒ misma operación. */
  const retrySame = async () => {
    announce(
      await controller.retry(userId, editorSignature(editingRef.current), () => editorSignature(editingRef.current)),
      lastOptsRef.current ?? {},
    );
  };

  const discardReference = () => {
    controller.discard();
    setConfirmingDiscard(false);
    toast({
      title: 'Descartamos la referencia local',
      description: 'No cancelamos nada en Melodya: si la solicitud seguía en curso, puede terminar igual, pero ya no podremos recuperarla desde acá.',
    });
  };

  const applyRecovered = () => {
    if (!snap.recovered) return;
    acceptOutcome(snap.recovered, '✨ Letra recuperada aplicada', 'Podés volver a la versión anterior desde el historial.');
    controller.finishRecovered();
  };

  const keepMyVersion = () => {
    controller.finishRecovered();
    toast({ title: 'Conservamos tu versión', description: 'Descartamos la letra recuperada.' });
  };

  // Resultado de cada consulta GET /generations/{id}. Un ref evita reiniciar el ciclo de consulta en cada render.
  const handleCheck = (outcome: CheckOutcome) => {
    if (outcome.kind === 'completed') {
      if (outcome.editorChanged) {
        // El editor cambió mientras la operación estaba pendiente: NO se pisa. Espera una aceptación explícita.
        controller.holdRecovered({ title: outcome.title, lyrics: outcome.lyrics });
        toast({ title: 'Recuperamos tu letra', description: 'Modificaste el editor mientras esperabas, así que no la aplicamos sola. Aceptala desde el aviso.' });
      } else {
        acceptOutcome({ title: outcome.title, lyrics: outcome.lyrics }, '✨ Letra lista', 'Recuperamos tu letra: ya estaba terminada.');
        controller.finishRecovered();
      }
    } else if (outcome.kind === 'failed') {
      toast({
        title: 'La letra no se pudo generar',
        description: outcome.reason === 'canceled' ? 'La operación se canceló antes de terminar.' : 'El proveedor no devolvió una letra. Podés volver a intentarlo.',
        variant: 'destructive',
      });
    }
  };
  const handleCheckRef = useRef(handleCheck);
  useEffect(() => {
    handleCheckRef.current = handleCheck;
  });

  // Tras recargar la pestaña o al hidratarse el usuario: recupera SOLO la solicitud guardada de esta identidad.
  useEffect(() => {
    controller.restore(userId, editorSignature(editingRef.current));
  }, [controller, userId]);

  // Con operation.id conocido se consulta GET /generations/{id} (espera creciente, acotado). No crea nada.
  const pollOperationId = pending?.operationId ?? null;
  const pollActive = pending?.polling === true;
  useEffect(() => {
    if (!open || !pollOperationId || !pollActive) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | undefined;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, ms);
      });
    void runPolling({
      controller,
      getEditorSignature: () => editorSignature(editingRef.current),
      sleep,
      isCancelled: () => cancelled,
      onOutcome: (o) => handleCheckRef.current(o),
    });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      wake?.();
    };
  }, [open, controller, pollOperationId, pollActive, snap.pollEpoch]);

  /* ------------------------------------------------------------------------ */
  /* Elegir una letra guardada: va directo al editor, sin procesar               */
  /* ------------------------------------------------------------------------ */

  const openSaved = (l: { title: string; lyrics: string }) => {
    const outcome = { title: l.title, lyrics: l.lyrics };
    const previous = editing;
    if (previous?.lyrics.trim()) setHistory((h) => [...h, previous].slice(-MAX_HISTORY));
    setEditing(outcome);
    setResult(outcome);
    setView('studio');
  };

  /* ------------------------------------------------------------------------ */
  /* Importar una letra existente (pegada o desde archivo)                       */
  /* ------------------------------------------------------------------------ */

  const openImport = (draft: LyricsImportDraft = { title: '', text: '' }) => {
    setImportDraft(draft);
    setImportSeed((n) => n + 1);
    setImportOpen(true);
  };

  /** Un atajo suma (o quita) su texto del campo Estilo; el resultado es un único string. */
  const toggleStyleChip = (chip: string) => {
    const parts = style.split(',').map((x) => x.trim()).filter(Boolean);
    const has = parts.some((x) => x.toLowerCase() === chip.toLowerCase());
    const next = has
      ? parts.filter((x) => x.toLowerCase() !== chip.toLowerCase())
      : [...parts, chip];
    setStyle(next.join(', ').slice(0, STYLE_MAX_CHARS));
  };

  const handleImportFile = async (file: File | undefined) => {
    if (!file) return;
    if (!IMPORT_FILE_EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext))) {
      toast({
        title: 'Formato no soportado',
        description: 'Por ahora solo podés subir archivos .txt o .md.',
        variant: 'destructive',
      });
      return;
    }
    try {
      const text = await file.text();
      openImport({ title: file.name.replace(/\.(txt|md)$/i, ''), text: text.replace(/^\uFEFF/, '') });
    } catch {
      toast({
        title: 'No pudimos leer el archivo',
        description: 'Probá de nuevo o pegá la letra directamente.',
        variant: 'destructive',
      });
    }
  };

  const submitImport = async ({ title, lyrics, mode }: { title: string; lyrics: string; mode: ImportMode }) => {
    if (lyrics.length > IMPORT_MAX_CHARS) {
      toast({
        title: 'La letra es demasiado larga',
        description: `Puede tener hasta ${IMPORT_MAX_CHARS.toLocaleString('es-AR')} caracteres.`,
      });
      return;
    }
    if (mode === 'as-is') {
      if (generating) return;
      // Sin asistente: no hay solicitud ni costo; va al editor con el mismo historial para poder volver atrás.
      acceptOutcome(
        { title: title || 'Sin título', lyrics },
        '📋 Letra pegada',
        'Quedó tal como la pegaste. Revisala en el editor y guardala cuando te guste.',
      );
      setImportOpen(false);
      return;
    }
    const ok = await generate({
      mode: 'improve',
      instruction: IMPORT_INSTRUCTIONS[mode],
      existing: { title: title || 'Sin título', lyrics },
    });
    if (ok) setImportOpen(false);
  };

  /* ------------------------------------------------------------------------ */
  /* Mejorar / ajustar la letra actual                                           */
  /* ------------------------------------------------------------------------ */

  const improveLyrics = (instruction?: string) => {
    if (!editing?.lyrics.trim()) return;

    // Sin instrucción específica se mantiene el pedido genérico de siempre; si el
    // usuario escribe una, esa tiene prioridad. La letra existente viaja como
    // borrador aparte (generate → existingLyrics), no embebida en la idea.
    void generate({
      mode: 'improve',
      instruction: instruction?.trim() || DEFAULT_IMPROVE_INSTRUCTION,
    });
  };

  const applyRefineText = () => {
    if (!refineText.trim()) return;
    improveLyrics(refineText);
    setRefineText('');
  };

  /* ------------------------------------------------------------------------ */
  /* Guardar / aplicar / copiar / limpiar / deshacer                              */
  /* ------------------------------------------------------------------------ */

  const saveLyric = async () => {
    const current = editing ?? result;
    if (!current || !current.lyrics.trim()) return;

    setSaving(true);

    try {
      await lyricsApi.create({
        title: current.title || 'Letra sin título',
        lyrics: current.lyrics,
        idea: idea || undefined,
        genre: style.trim() || undefined,
        tags: style.trim() && style.trim().length <= 40 ? [style.trim().toLowerCase()] : undefined,
      });

      void qc.invalidateQueries({ queryKey: ['lyrics'] });
      toast({
        title: 'Letra guardada 📝',
        description: `“${current.title}” está en tu biblioteca.`,
      });
    } catch (err) {
      toast({
        title: 'No pudimos guardar',
        description: toUserMessage(err),
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const apply = () => {
    const current = editing ?? result;
    if (!current || !current.lyrics.trim()) return;
    // Se devuelve la letra completa, incluyendo las etiquetas de sección.
    onApply(current);
  };

  const copyLyrics = async () => {
    if (!editing) return;

    try {
      await navigator.clipboard.writeText(`${editing.title}\n\n${editing.lyrics}`);
      toast({ title: 'Letra copiada 📋', description: 'Pegala donde quieras.' });
    } catch {
      toast({
        title: 'No pudimos copiar',
        description: 'Tu navegador bloqueó el portapapeles.',
        variant: 'destructive',
      });
    }
  };

  const clearEditor = () => {
    if (
      editing?.lyrics.trim() &&
      !window.confirm('¿Limpiar el editor? Vas a perder la letra actual.')
    ) {
      return;
    }
    setEditing(null);
    setResult(null);
    setHistory([]);
  };

  const undo = () => {
    const previous = history[history.length - 1];
    if (!previous) return;
    setHistory((h) => h.slice(0, -1));
    setEditing(previous);
    setResult(previous);
  };

  /* ------------------------------------------------------------------------ */
  /* Insertar etiqueta                                                          */
  /* ------------------------------------------------------------------------ */

  const insertLyricsTag = (item: LyricsTagDefinition) => {
    if (!editing) return;

    const tag = buildTag(item, editing.lyrics);
    const textarea = lyricsTextareaRef.current;

    if (!textarea) {
      const separator = editing.lyrics.trim() ? '\n\n' : '';
      setEditing({ ...editing, lyrics: `${editing.lyrics.trimEnd()}${separator}${tag}\n` });
      return;
    }

    const { value, cursor } = insertTagAtCursor(textarea, editing.lyrics, tag);
    setEditing({ ...editing, lyrics: value });

    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(cursor, cursor);
    });
  };

  /* ------------------------------------------------------------------------ */
  /* Datos derivados del editor                                                 */
  /* ------------------------------------------------------------------------ */

  const detectedSections = detectStructure(editing?.lyrics ?? '');

  const uniqueDetectedSections = detectedSections.filter(
    (tag, index, array) =>
      array.findIndex((item) => normalizeTag(item) === normalizeTag(tag)) === index,
  );

  const wordCount = editing?.lyrics.trim() ? editing.lyrics.trim().split(/\s+/).length : 0;
  const characterCount = editing?.lyrics.length ?? 0;
  const overLimit = characterCount > LYRICS_SOFT_LIMIT;

  /* ------------------------------------------------------------------------ */
  /* Render                                                                     */
  /* ------------------------------------------------------------------------ */

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="
          flex h-[94vh] max-w-[96vw] flex-col gap-0
          overflow-hidden rounded-[28px_28px_14px_14px] border-0
          bg-background p-0
          studio-dialog
          md:h-[92vh]
        "
      >
        {/* Header ---------------------------------------------------------- */}

        <div className="flex items-center gap-3 border-b border-border px-5 py-4 pr-16 sm:px-7 sm:pr-16">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full gradient-warm text-primary-foreground">
            <PenLine className="h-5 w-5" aria-hidden />
          </span>

          <div className="min-w-0 flex-1">
            <DialogTitle className="font-display truncate text-xl font-bold">
              Estudio de letras
            </DialogTitle>
            <DialogDescription className="truncate text-xs">
              Creá, editá y estructurá tu letra con ayuda de Melodya.
            </DialogDescription>
          </div>
        </div>

        {view === 'studio' ? (
        <div className="grid min-h-0 flex-1 auto-rows-min gap-0 overflow-y-auto md:auto-rows-auto md:grid-cols-[minmax(300px,2fr)_minmax(0,3fr)] md:overflow-visible">
            {/* ============================================================ */}
            {/* PANEL IZQUIERDO                                               */}
            {/* ============================================================ */}

            <div className="min-h-0 space-y-5 border-border/70 p-5 sm:p-7 md:overflow-y-auto md:border-r">
              {/* Idea ----------------------------------------------------- */}

              <div className="space-y-2">
                <Label htmlFor="ly-idea" className="text-sm font-semibold">
                  Tu idea{' '}
                  <span className="text-amber-strong" aria-hidden>
                    ·
                  </span>
                </Label>

                <CanvasTextarea
                  id="ly-idea"
                  value={idea}
                  onChange={(e) => setIdea(e.target.value)}
                  placeholder="Ej: una canción para mi vieja, que le gusta cantar cocinando…"
                  maxLength={2000}
                />

                <p className="text-[11px] text-muted-foreground">
                  Contale a Melodya qué querés transmitir. Cuantos más datos reales (nombres,
                  anécdotas, frases), mejor sale la letra.
                </p>
              </div>

              {/* ¿Ya tenés una letra? ------------------------------------- */}

              <div className="@container flex flex-col items-start gap-2 border-y border-border/70 py-4">
                <p className="text-sm font-semibold">¿Ya tenés una letra?</p>

                <p className="text-[11px] text-muted-foreground">
                  Podés traer una letra que ya escribiste y Melodya la prepara para tu canción.
                </p>

                <div className="grid w-full grid-cols-1 items-start gap-2 @md:grid-cols-3">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-auto min-h-11 w-full min-w-0 flex-row justify-start gap-2 whitespace-nowrap rounded-full border border-border/70 bg-surface-2/40 p-1.5 pr-3 text-left text-sm font-bold leading-tight transition-colors hover:border-amber/40 hover:bg-surface-2 @md:text-sm"
                    onClick={() => openImport()}
                    disabled={generating}
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-[#131C33]" aria-hidden><ClipboardPaste className="h-4 w-4" aria-hidden /></span>
                    Pegar letra
                  </Button>

                  <div className="flex min-w-0 flex-col gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-auto min-h-11 w-full min-w-0 flex-row justify-start gap-2 whitespace-nowrap rounded-full border border-border/70 bg-surface-2/40 p-1.5 pr-3 text-left text-sm font-bold leading-tight transition-colors hover:border-amber/40 hover:bg-surface-2 @md:text-sm"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={generating}
                    >
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-gold text-[#131C33]" aria-hidden><Upload className="h-4 w-4" aria-hidden /></span>
                      Subir archivo
                    </Button>
                    <p className="text-center text-[10px] text-muted-foreground">Archivos .txt o .md.</p>
                  </div>

                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-auto min-h-11 w-full min-w-0 flex-row justify-start gap-2 whitespace-nowrap rounded-full border border-border/70 bg-surface-2/40 p-1.5 pr-3 text-left text-sm font-bold leading-tight transition-colors hover:border-amber/40 hover:bg-surface-2 @md:text-sm"
                    onClick={() => setView('saved')}
                    disabled={generating}
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-voice text-on-voice" aria-hidden><BookOpen className="h-4 w-4" aria-hidden /></span>
                    Mis letras
                  </Button>

                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".txt,.md,text/plain,text/markdown"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      void handleImportFile(file);
                    }}
                  />
                </div>

              </div>

              {/* Estilo ------------------------------------------------- */}

              <div className="space-y-2">
                <Label htmlFor="ly-style" className="text-sm font-medium">
                  Estilo <span className="text-muted-foreground">(opcional)</span>
                </Label>

                <CanvasTextarea
                  id="ly-style"
                  value={style}
                  onChange={(e) => setStyle(e.target.value)}
                  placeholder="Describí cómo querés que suene: cumbia argentina alegre, con acordeón y percusión…"
                  className="h-[72px]"
                  maxLength={STYLE_MAX_CHARS}
                />

                <p className="text-[11px] text-muted-foreground">
                  Escribilo como quieras: género, ritmo, clima, instrumentos. {style.length}/{STYLE_MAX_CHARS}
                </p>

                <p className="text-xs font-medium text-muted-foreground">Más usados</p>

                <div className="flex flex-wrap gap-1.5">
                  {STYLE_SUGGESTIONS.map((g) => {
                    const active = style.split(',').some((x) => x.trim().toLowerCase() === g.toLowerCase());
                    const Icon = STYLE_ICONS[g];
                    return (
                      <Chip key={g} active={active} className="px-2.5 py-1 text-[11px]" onClick={() => toggleStyleChip(g)}>
                        {active && Icon && <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                        {g}
                      </Chip>
                    );
                  })}
                </div>
              </div>

              {/* Duración ------------------------------------------------ */}

              <div className="@container space-y-2">
                <Label className="text-sm font-medium">
                  Duración <span className="text-muted-foreground">(opcional)</span>
                </Label>

                {/* Medios círculos como los de «Energía» (design-V2, configuracion-estilo): base redondeada, sin borde arriba, el tamaño crece de corta a larga */}
                <div className="flex items-start justify-center gap-2 @sm:gap-4" role="radiogroup" aria-label="Duración">
                  {DURATIONS.map((d, n) => {
                    const w = 96 + n * 8; // ancho máximo; se achica en proporción si no hay lugar
                    const active = duration === d.id;
                    return (
                      <div key={d.id} className="flex min-w-0 flex-col items-center gap-1.5" style={{ flex: '1 1 0', maxWidth: w }}>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={active}
                          onClick={() => setDuration(duration === d.id ? '' : d.id)}
                          style={{ aspectRatio: '2 / 1', borderRadius: '0 0 50% 50% / 0 0 100% 100%', paddingBottom: '7%' }}
                          className={cn(
                            'flex w-full flex-col items-center justify-end leading-tight border-[1.5px] border-t-0 text-[11px] transition-colors @sm:text-[12.5px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground',
                            active ? 'border-primary bg-primary font-bold text-[#131C33]' : 'border-foreground/50 font-medium text-foreground hover:bg-foreground/10'
                          )}
                        >
                          {d.label}
                          <span className={cn('text-[9.5px] font-normal @sm:text-[10.5px]', active ? 'text-[#131C33]/80' : 'text-muted-foreground')}>{d.hint}</span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Estructura / Idioma / Letrista (en una sola fila cuando hay lugar) ---- */}

              <div className="@container space-y-2">
                <div className="grid grid-cols-1 gap-3 @sm:grid-cols-3">
                  <div className="min-w-0 space-y-2">
                    <Label className="text-sm font-medium">Estructura</Label>

                    <Select value={structure} onValueChange={setStructure}>
                      <SelectTrigger className="w-full min-w-0 rounded-xl text-sm" aria-label="Estructura">
                        <SelectValue />
                      </SelectTrigger>

                      <SelectContent>
                        {STRUCTURE_PRESETS.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="min-w-0 space-y-2">
                    <Label className="text-sm font-medium">Idioma</Label>

                    <Select value={language} onValueChange={setLanguage}>
                      <SelectTrigger className="w-full min-w-0 rounded-xl text-sm" aria-label="Idioma">
                        <SelectValue />
                      </SelectTrigger>

                      <SelectContent>
                        {LANGUAGES.map((l) => (
                          <SelectItem key={l.id} value={l.id}>
                            {l.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="min-w-0 space-y-2">
                    <Label className="text-sm font-medium">Letrista</Label>

                    <Select value={personaId} onValueChange={setPersonaId}>
                      <SelectTrigger className="w-full min-w-0 rounded-xl text-sm" aria-label="Letrista">
                        <SelectValue />
                      </SelectTrigger>

                      <SelectContent>
                        <SelectItem value="none">Estilo libre</SelectItem>

                        {(personas?.items ?? []).map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <p className="text-[11px] text-muted-foreground">
                  {STRUCTURE_PRESETS.find((p) => p.id === structure)?.description}
                </p>
              </div>

              {/* Sin letristas ------------------------------------------- */}

              {(personas?.items ?? []).length === 0 && (
                <button
                  type="button"
                  onClick={() => handleOpenChange(false)}
                  className="studio-cap flex min-h-16 items-center rounded-r-[32px] bg-[var(--m-capsule-tint)] py-3 pr-6 pl-5 text-left text-sm font-medium leading-snug text-foreground transition-[filter] hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground sm:pl-7"
                >
                  <span className="min-w-0 flex-1">Creá letristas en tu biblioteca para que Melodya escriba con TU estilo.</span>
                  <span aria-hidden className="ml-3 flex size-8 shrink-0 items-center justify-center rounded-full bg-gold text-[#131C33]">
                    <ArrowRight className="h-4 w-4" />
                  </span>
                </button>
              )}

              {/* Generar -------------------------------------------------- */}

              {lyricsAiLocked && (
                <p role="note" className="rounded-lg border border-amber/30 bg-amber/5 px-3 py-2 text-xs leading-relaxed text-amber-strong">{LOCK_REASON.LYRICS_AI}</p>
              )}

              <Button
                type="button"
                onClick={() => void generate()}
                disabled={generating || lyricsAiLocked}
                size="lg"
                className=" w-full rounded-full gradient-warm font-semibold text-primary-foreground hover:text-primary-foreground"
              >
                {generating ? (
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden />
                ) : (
                  <Wand2 className="mr-2 h-5 w-5" aria-hidden />
                )}

                {generating ? 'Escribiendo…' : result ? 'Regenerar letra' : 'Generar letra'}
              </Button>

            </div>

            {/* ============================================================ */}
            {/* PANEL DERECHO — EDITOR                                       */}
            {/* ============================================================ */}

            <div className="flex min-h-[18rem] flex-col p-5 sm:p-7 md:min-h-0 md:overflow-y-auto">
              {/* Solicitud pendiente de confirmación ------------------------ */}

              {snap.recovered && (
                <div role="status" aria-live="polite" className="mb-4 rounded-2xl border border-amber/40 bg-amber/5 p-4">
                  <p className="text-sm font-semibold text-amber-strong">Recuperamos tu letra</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Modificaste el editor mientras esperabas, así que no la aplicamos sola. Si la aplicás, la versión actual queda en el historial para volver atrás.
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button type="button" size="sm" className="rounded-full" onClick={applyRecovered}>
                      Aplicar letra recuperada
                    </Button>
                    <Button type="button" size="sm" variant="ghost" className="rounded-full text-muted-foreground" onClick={keepMyVersion}>
                      Conservar mi versión (se descarta la recuperada)
                    </Button>
                  </div>
                </div>
              )}

              {/* Solicitud pendiente de confirmación ------------------------ */}

              {pending && !snap.recovered && !generating && (
                <div role="status" aria-live="polite" className="mb-4 rounded-2xl border border-amber/40 bg-amber/5 p-4">
                  <p className="text-sm font-semibold text-amber-strong">{describePending(pending).title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{describePending(pending).text}</p>

                  {pending.lastCheckFailed && (
                    <p className="mt-1 text-xs text-muted-foreground">No pudimos consultar el estado en este momento.</p>
                  )}
                  {pending.operationId && !pending.polling && !pending.checking && (
                    <p className="mt-1 text-xs text-muted-foreground">La consulta automática está detenida. La solicitud sigue guardada: podés consultar ahora.</p>
                  )}

                  {confirmingDiscard ? (
                    <div className="mt-3">
                      <p className="text-xs font-medium text-destructive">
                        Si descartás la referencia, ya no vas a poder recuperar esta solicitud desde acá. No se cancela nada en Melodya: la operación puede seguir ejecutándose.
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Button type="button" size="sm" variant="destructive" className="rounded-full" onClick={discardReference}>
                          Sí, descartar la referencia
                        </Button>
                        <Button type="button" size="sm" variant="ghost" className="rounded-full" onClick={() => setConfirmingDiscard(false)}>
                          Cancelar
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {pending.operationId && pending.polling && (
                        <Button type="button" size="sm" variant="outline" className="rounded-full" onClick={() => controller.pausePolling()}>
                          Pausar consulta
                        </Button>
                      )}
                      {pending.operationId && !pending.polling && (
                        <Button type="button" size="sm" variant="outline" className="rounded-full" onClick={() => controller.resumePolling()} disabled={pending.checking}>
                          {pending.checking ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden />}
                          Consultar ahora
                        </Button>
                      )}
                      {!pending.operationId && pending.canRetry && (
                        <Button type="button" size="sm" variant="outline" className="rounded-full" onClick={() => void retrySame()}>
                          <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                          Reintentar la misma solicitud
                        </Button>
                      )}
                      <Button type="button" size="sm" variant="ghost" className="rounded-full text-muted-foreground" onClick={() => setConfirmingDiscard(true)}>
                        Descartar referencia local…
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {/* Generando ------------------------------------------------ */}

              {generating && (
                <div
                  role="status"
                  aria-live="polite"
                  className="flex flex-1 flex-col items-center justify-center gap-4 rounded-[28px_28px_14px_14px] border-[1.5px] border-dashed border-line bg-[var(--m-input)] p-6 text-center"
                >
                  {/* Núcleo de voz girando (design-V2, «Melodya escribiendo»): aro tenue con un arco dorado que da vueltas y la chispa al centro */}
                  <span aria-hidden className="relative block size-24 shrink-0">
                    <svg
                      className="absolute inset-0 size-full animate-spin motion-reduce:animate-none"
                      style={{ animationDuration: '2.4s' }}
                      viewBox="0 0 96 96"
                      fill="none"
                    >
                      <circle cx="48" cy="48" r="44" stroke="var(--m-faint)" strokeWidth="3" />
                      <circle cx="48" cy="48" r="44" stroke="var(--m-gold)" strokeWidth="3" strokeLinecap="round" strokeDasharray="77 200" />
                    </svg>
                    <span className="absolute inset-[21%] flex items-center justify-center rounded-full bg-voice">
                      <Sparkles className="h-[26px] w-[26px] text-gold" />
                    </span>
                  </span>

                  <p className="max-w-[250px] font-display text-[19px] leading-tight font-semibold">Melodya está escribiendo tu letra…</p>

                  <p className="max-w-xs text-sm text-muted-foreground">Puede tomar unos segundos. La inspiración no se apura.</p>
                </div>
              )}

              {/* Vacío ---------------------------------------------------- */}

              {!generating && !editing && (
                <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-[28px_28px_14px_14px] border-[1.5px] border-dashed border-line bg-[var(--m-input)] p-6 text-center">
                  {/* Núcleo de voz (design-V2, «Melodya la escribe»): aro tenue y círculo de voz con la chispa dorada */}
                  <span aria-hidden className="relative block size-24 shrink-0">
                    <svg className="absolute inset-0 size-full" viewBox="0 0 96 96" fill="none">
                      <circle cx="48" cy="48" r="44" stroke="var(--m-faint)" strokeWidth="3" />
                    </svg>
                    <span className="absolute inset-[21%] flex items-center justify-center rounded-full bg-voice">
                      <FileText className="h-[26px] w-[26px] text-gold" />
                    </span>
                  </span>

                  <p className="max-w-[250px] font-display text-[19px] leading-tight font-semibold">Tu letra va a aparecer acá.</p>

                  <p className="max-w-xs text-sm text-muted-foreground">
                    Contá tu idea a la izquierda y tocá <span className="font-semibold text-foreground">Generar letra</span>.
                  </p>
                </div>
              )}

              {/* Editor --------------------------------------------------- */}

              {!generating && editing && (
                <>
                  {/* Título ------------------------------------------------ */}

                  <div className="mb-3 flex items-center gap-2">
                    <Input
                      value={editing.title}
                      onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                      className="h-12 flex-1 rounded-xl border-transparent bg-transparent px-0 font-display text-2xl font-bold focus-visible:bg-surface-2 sm:text-3xl"
                      aria-label="Título de la letra"
                    />

                    {result && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 rounded-full"
                        aria-label="Volver a la letra generada"
                        title="Descartar ediciones"
                        onClick={() => setEditing(result)}
                      >
                        <RefreshCw className="h-4 w-4" aria-hidden />
                      </Button>
                    )}
                  </div>

                  {/* Estructura detectada --------------------------------- */}

                  <div className="mb-5 shrink-0">
                    <div className="flex items-center gap-2.5">
                      <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-[#131C33]">
                        <ListMusic className="h-4 w-4" />
                      </span>

                      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <p className="text-sm font-bold">Estructura detectada</p>

                        <span className="text-[11px] text-muted-foreground">
                          {detectedSections.length}{' '}
                          {detectedSections.length === 1 ? 'sección' : 'secciones'}
                        </span>
                      </div>
                    </div>

                    {/* Los chips arrancan alineados con el icono (a la izquierda del todo) */}
                    {uniqueDetectedSections.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {uniqueDetectedSections.map((tag) => (
                          <Chip key={tag} className="px-3.5 py-1.5 text-[11px]">
                            {tag}
                          </Chip>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                        Todavía no hay etiquetas estructurales. Podés agregarlas desde la guía
                        de abajo.
                      </p>
                    )}
                  </div>

                  {/* Editor ------------------------------------------------ */}

                  <ExpandableLyrics
                    id="ly-editor"
                    textareaRef={lyricsTextareaRef}
                    value={editing.lyrics}
                    onChange={(v) => setEditing({ ...editing, lyrics: v })}
                    description={`${editing.lyrics.trim() ? editing.lyrics.trim().split(/\s+/).length : 0} palabras`}
                    ariaLabel="Letra editable"
                    grow
                    placeholder={`[Intro]

Una frase para abrir la canción...

[Verso 1]

Escribí acá tu primer verso...

[Pre-Coro]

Prepará la subida...

[Coro]

El estribillo que queremos recordar...`}
                  />

                  {/* Ajustar con Melodya --------------------------------- */}

                  <div className="mt-6 shrink-0 space-y-2">
                    <div className="flex items-center gap-2.5">
                      <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-[#131C33]">
                        <Wand2 className="h-4 w-4" />
                      </span>
                      <p className="text-sm font-bold">Ajustar con Melodya</p>
                    </div>

                    <div className="flex flex-wrap gap-1.5">
                      {REFINE_ACTIONS.map((a) => (
                        <Chip
                          key={a.label}
                          className="px-2.5 py-1 text-[11px]"
                          onClick={() => improveLyrics(a.instruction)}
                        >
                          {a.label}
                        </Chip>
                      ))}
                    </div>

                    <div className="flex gap-2">
                      {/* Mismo aspecto que la «Búsqueda rápida» del header: píldora con icono a la izquierda */}
                      <label className="group flex h-11 min-w-0 flex-1 items-center gap-2 rounded-full border-[1.5px] border-line bg-[var(--m-input)] px-4 text-muted-foreground transition-colors focus-within:border-foreground focus-within:ring-4 focus-within:ring-[var(--m-focus-ring)] hover:border-foreground">
                        <Wand2 className="h-4 w-4 shrink-0" aria-hidden />
                        <input
                          data-canvas-field
                          value={refineText}
                          onChange={(e) => setRefineText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              applyRefineText();
                            }
                          }}
                          placeholder="Ej: cambiá el puente por algo más gracioso"
                          className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                          maxLength={300}
                          aria-label="Qué querés cambiar de la letra"
                        />
                      </label>

                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-11 rounded-full"
                        onClick={applyRefineText}
                        disabled={generating || lyricsAiLocked || !refineText.trim()}
                      >
                        Aplicar
                      </Button>
                    </div>
                  </div>

                  {/* Guía de etiquetas ----------------------------------- */}

                  <details className="group studio-cap mt-6 shrink-0 overflow-hidden rounded-r-[36px] bg-voice text-on-voice shadow-lg">
                    <summary className="flex min-h-[72px] cursor-pointer list-none items-center justify-between gap-3 py-3 pr-6 pl-5 text-sm font-bold sm:pl-7">
                      <span className="flex items-center gap-2.5">
                        <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-[#131C33]">
                          <Sparkles className="h-4 w-4" />
                        </span>
                        Guía de estructura
                      </span>

                      <span className="flex items-center gap-2">
                        <span className="text-[10px] font-normal text-on-voice/70">Insertar etiquetas</span>
                        <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-gold text-[#131C33]">
                          <ChevronDown className="h-4 w-4 transition-transform duration-200 group-open:rotate-180" />
                        </span>
                      </span>
                    </summary>

                    <div className="pb-4 pr-6 pl-5 sm:pl-7">
                      <p className="mb-3 text-[11px] leading-relaxed text-on-voice/80">
                        Elegí una etiqueta para insertarla en la posición actual del cursor. También
                        podés escribirlas manualmente.
                      </p>

                      <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
                        {LYRICS_TAGS.map((item) => {
                          const active = countTags(editing.lyrics, item) > 0;

                          return (
                            <Chip
                              key={item.base}
                              active={active}
                              onClick={() => insertLyricsTag(item)}
                              className={cn('min-h-0 px-3.5 py-1.5 text-[11px]', !active && 'border-on-voice/30 text-on-voice hover:bg-on-voice/10')}
                            >
                              <Plus className="h-3 w-3" aria-hidden />[{item.base}]
                            </Chip>
                          );
                        })}
                      </div>

                      <div className="mt-3">
                        <p className="text-[11px] leading-relaxed text-gold">
                          <span className="font-bold">Consejo:</span> usá{' '}
                          <span className="font-mono text-on-voice">[Verso]</span> para los
                          versos, <span className="font-mono text-on-voice">[Coro]</span> para el
                          estribillo y <span className="font-mono text-on-voice">[Puente]</span>{' '}
                          para una parte de contraste. También podés sumar una pista, por ejemplo{' '}
                          <span className="font-mono text-on-voice">[Intro - guitarras]</span>.
                        </p>
                      </div>
                    </div>
                  </details>

                  {/* Herramientas ----------------------------------------- */}

                  <div className="mt-3 flex shrink-0 flex-wrap items-center justify-between gap-3">
                    <div
                      className="flex flex-wrap items-center gap-1"
                      role="group"
                      aria-label="Herramientas de la letra"
                    >
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-11 rounded-full px-4 text-sm font-semibold text-foreground"
                        onClick={() => void copyLyrics()}
                      >
                        <Copy className="mr-2 h-4 w-4" aria-hidden />
                        Copiar
                      </Button>

                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-11 rounded-full px-4 text-sm font-semibold text-foreground"
                        onClick={clearEditor}
                      >
                        <Eraser className="mr-2 h-4 w-4" aria-hidden />
                        Limpiar
                      </Button>

                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-11 rounded-full px-4 text-sm font-semibold text-foreground"
                        onClick={() => improveLyrics()}
                        disabled={generating || lyricsAiLocked || !editing.lyrics.trim()}
                      >
                        <Wand2 className="mr-2 h-4 w-4" aria-hidden />
                        Mejorar
                      </Button>

                      {history.length > 0 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-11 rounded-full px-4 text-sm font-semibold text-foreground"
                          onClick={undo}
                          title="Volver a la versión anterior"
                        >
                          <Undo2 className="mr-2 h-4 w-4" aria-hidden />
                          Versión anterior
                        </Button>
                      )}
                    </div>

                    <p className={cn('text-xs', overLimit ? 'text-destructive' : 'text-muted-foreground')}>
                      {wordCount > 0
                        ? `${wordCount} palabras · ${characterCount.toLocaleString('es-AR')} caracteres`
                        : ''}
                    </p>
                  </div>

                  {overLimit && (
                    <p className="mt-1.5 text-[11px] text-destructive">
                      La letra supera los {LYRICS_SOFT_LIMIT.toLocaleString('es-AR')} caracteres que admite la
                      generación de la canción: no se recorta sola y no podrás usarla así. Acortala o dividila (podés guardarla igual).
                    </p>
                  )}

                  {/* Acciones ------------------------------------------------ */}

                  <div className="mt-3 flex flex-wrap items-center justify-end gap-2.5">
                    <Button
                      type="button"
                      variant="outline"
                      className="rounded-full"
                      onClick={() => void saveLyric()}
                      disabled={saving}
                    >
                      {saving ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                      ) : (
                        <Save className="mr-2 h-4 w-4" aria-hidden />
                      )}
                      Guardar
                    </Button>

                    <Button
                      type="button"
                      className=" rounded-full gradient-warm font-semibold text-primary-foreground hover:text-primary-foreground"
                      onClick={apply}
                      disabled={!editing.lyrics.trim()}
                    >
                      <Check className="mr-2 h-4 w-4" aria-hidden />
                      Usar esta letra
                    </Button>
                  </div>
                </>
              )}
            </div>
        </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-7">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mb-4 rounded-full"
              onClick={() => setView('studio')}
            >
              <ArrowLeft className="mr-1.5 h-4 w-4" aria-hidden />
              Volver al estudio
            </Button>

            <div className="relative mb-4">
              <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                value={savedSearch}
                onChange={(e) => setSavedSearch(e.target.value)}
                placeholder="Buscar en mis letras"
                aria-label="Buscar en mis letras"
                className="h-11 w-full rounded-full pl-10 text-sm font-normal"
              />
            </div>

            {savedLoading ? (
              <div className="flex justify-center py-16">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
              </div>
            ) : (savedLyrics?.items ?? []).length === 0 ? (
              <div className="flex min-h-64 flex-col items-center justify-center gap-4 rounded-[28px_28px_14px_14px] border-[1.5px] border-dashed border-line bg-[var(--m-input)] p-6 text-center">
                <span aria-hidden className="relative block size-24 shrink-0">
                  <svg className="absolute inset-0 size-full" viewBox="0 0 96 96" fill="none">
                    <circle cx="48" cy="48" r="44" stroke="var(--m-faint)" strokeWidth="3" />
                  </svg>
                  <span className="absolute inset-[21%] flex items-center justify-center rounded-full bg-voice">
                    <BookOpen className="h-[26px] w-[26px] text-gold" />
                  </span>
                </span>

                <p className="max-w-[250px] font-display text-[19px] leading-tight font-semibold">
                  {savedSearchTerm ? 'No encontramos letras con esa búsqueda.' : 'Todavía no tenés letras guardadas.'}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-[minmax(0,1fr)] gap-3 md:grid-cols-2">
                {(savedLyrics?.items ?? []).map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => openSaved(l)}
                    className="flex w-full min-w-0 items-center gap-3.5 rounded-[28px] border-[1.5px] border-line bg-surface p-3 pr-4 text-left transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'flex size-[52px] shrink-0 items-center justify-center rounded-full',
                        l.source === 'MANUAL' ? 'bg-foreground text-background' : 'bg-primary text-[#131C33]'
                      )}
                    >
                      <FileText className="h-[22px] w-[22px]" />
                    </span>

                    <span className="flex min-w-0 flex-1 flex-col leading-snug">
                      <span className="truncate font-display text-base font-bold">{l.title}</span>
                      <span className="truncate text-[13px] text-muted-foreground">{l.lyrics.replace(/\s+/g, ' ')}</span>
                      <span className="text-xs text-muted-foreground/85">
                        {l.source === 'MANUAL' ? 'Mía' : 'Melodya'}
                        {l.genre ? ` · ${l.genre}` : ''}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

      </DialogContent>

      <LyricsImportDialog
        key={importSeed}
        open={importOpen}
        onOpenChange={setImportOpen}
        draft={importDraft}
        pending={generating}
        onSubmit={(input) => void submitImport(input)}
      />
    </Dialog>
  );
}
