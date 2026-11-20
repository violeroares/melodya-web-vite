
/**
 * MELODYA WEB — Hook de grabación de voz en el navegador (flujo estilo Suno).
 *
 * Sigue las especificaciones de docs/Muestras mediante el boton grabar.docx:
 *  • getUserMedia: echoCancellation + noiseSuppression + autoGainControl,
 *    sampleRate 48 kHz, mono (channelCount 1).
 *  • MediaRecorder: 'audio/webm;codecs=opus' con fallbacks (webm → mp4 → ogg).
 *  • Duración recomendada: mínima configurable (10s muestra / 4s frase),
 *    tope automático en 90s para no dejar grabaciones infinitas.
 *
 * El resultado es un File listo para samplesApi.create() — el backend acepta
 * audio/webm (Opus) por magic bytes, sin conversión.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type RecorderState = 'idle' | 'requesting' | 'recording' | 'stopping' | 'ready';

export interface RecorderDevice {
  deviceId: string;
  label: string;
}

export interface VoiceRecorderResult {
  state: RecorderState;
  /** Segundos transcurridos de la grabación en curso. */
  elapsed: number;
  /** Nivel de entrada 0..1 (para el medidor en vivo). */
  level: number;
  devices: RecorderDevice[];
  deviceId: string;
  error: string | null;
  /** Archivo listo para subir (tras stop). */
  file: File | null;
  /** URL de objeto para pre-escuchar (revocar con reset()). */
  previewUrl: string | null;
  setDeviceId: (id: string) => void;
  start: () => Promise<void>;
  stop: () => void;
  /** Descarta la toma actual (y revoca la URL). */
  reset: () => void;
}

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/ogg;codecs=opus',
];

function pickMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const mime of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    } catch {
      /* seguimos con el siguiente */
    }
  }
  return '';
}

function extFor(mime: string): string {
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mp4')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  return 'webm';
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const USER_MESSAGE: Record<string, string> = {
  NotAllowedError: 'No pudimos acceder a tu micrófono. Revisá que el navegador tenga permiso para usarlo y volvé a intentar.',
  NotFoundError: 'No encontramos un micrófono conectado. Conectá uno o subí un archivo de audio.',
  NotReadableError: 'Tu micrófono está siendo usado por otra aplicación. Cerrala y volvé a intentar.',
  OverconstrainedError: 'Tu micrófono no soporta la configuración ideal de grabación. Probá con otro dispositivo.',
  SecurityError: 'El navegador bloqueó el micrófono en esta página. Abrí la web en una ventana normal con HTTPS.',
};

export function useVoiceRecorder(opts?: { maxSec?: number }): VoiceRecorderResult {
  const maxSec = opts?.maxSec ?? 90;

  const [state, setState] = useState<RecorderState>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [devices, setDevices] = useState<RecorderDevice[]>([]);
  const [deviceId, setDeviceIdState] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const ctxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);

  const teardown = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (ctxRef.current && ctxRef.current.state !== 'closed') {
      void ctxRef.current.close().catch(() => undefined);
    }
    ctxRef.current = null;
    setLevel(0);
  }, []);

  // Al desmontar (p. ej. se cierra el diálogo): se suelta el micrófono, el recorder no vuelve a disparar `finish` sobre un
  // componente muerto y la URL de pre-escucha se revoca.
  const previewUrlRef = useRef<string | null>(null);
  useEffect(() => {
    previewUrlRef.current = previewUrl;
  }, [previewUrl]);
  useEffect(
    () => () => {
      const recorder = recorderRef.current;
      if (recorder) {
        recorder.onstop = null;
        recorder.ondataavailable = null;
        if (recorder.state !== 'inactive') {
          try {
            recorder.stop();
          } catch {
            /* ya estaba detenido */
          }
        }
      }
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      teardown();
    },
    [teardown],
  );

  const finish = useCallback(() => {
    const mime = recorderRef.current?.mimeType || pickMime();
    const blob = new Blob(chunksRef.current, { type: mime || 'audio/webm' });
    chunksRef.current = [];
    if (blob.size > 0) {
      const url = URL.createObjectURL(blob);
      setPreviewUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return url;
      });
      setFile(new File([blob], `voz-${stamp()}.${extFor(mime)}`, { type: mime || 'audio/webm' }));
    }
    setState('ready');
    teardown();
  }, [teardown]);

  const start = useCallback(async () => {
    setError(null);
    if (state === 'recording' || state === 'requesting') return;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setError('Tu navegador no soporta grabación de audio. Podés subir un archivo en su lugar.');
      return;
    }
    setState('requesting');
    try {
      // Descartamos una toma previa si había.
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
      setFile(null);

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        },
        video: false,
      });
      streamRef.current = stream;

      // Lista de micrófonos (los labels llegan tras otorgar el permiso).
      try {
        const all = await navigator.mediaDevices.enumerateDevices();
        setDevices(
          all
            .filter((d) => d.kind === 'audioinput')
            .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Micrófono ${i + 1}` })),
        );
        if (!deviceId) {
          const track = stream.getAudioTracks()[0];
          const current = track?.getSettings().deviceId;
          if (current) setDeviceIdState(current);
        }
      } catch {
        /* sin lista de dispositivos: seguimos con el default */
      }

      const mime = pickMime();
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 128_000 } : undefined);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = finish;
      recorder.start(250);

      // Medidor de nivel en vivo (AnalyserNode).
      try {
        const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new Ctx();
        ctxRef.current = ctx;
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        src.connect(analyser);
        const buf = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / buf.length);
          setLevel((prev) => prev * 0.7 + Math.min(1, rms * 2.5) * 0.3);
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch {
        /* sin medidor: la grabación sigue */
      }

      startedAtRef.current = Date.now();
      setElapsed(0);
      setState('recording');
      timerRef.current = setInterval(() => {
        const secs = (Date.now() - startedAtRef.current) / 1000;
        setElapsed(secs);
        if (secs >= maxSec) {
          // Tope automático: cerramos limpio como si apretara stop.
          if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
        }
      }, 100);
    } catch (err) {
      const name = (err as { name?: string })?.name ?? '';
      setError(USER_MESSAGE[name] ?? 'No pudimos empezar a grabar. Revisá el micrófono y volvé a intentar.');
      setState('idle');
      teardown();
    }
  }, [deviceId, maxSec, previewUrl, state, teardown, finish]);

  const stop = useCallback(() => {
    if (state !== 'recording') return;
    setState('stopping');
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    } else {
      finish();
    }
  }, [state, finish]);

  const reset = useCallback(() => {
    if (state === 'recording') return;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setFile(null);
    setElapsed(0);
    setError(null);
    setState('idle');
  }, [state, previewUrl]);

  const setDeviceId = useCallback((id: string) => {
    setDeviceIdState(id);
    // Cambiar el micrófono con una grabación en curso: corta y vuelve a idle
    // (la UI pide explícitamente re-grabar).
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setState('idle');
      setElapsed(0);
    }
  }, []);

  return { state, elapsed, level, devices, deviceId, error, file, previewUrl, setDeviceId, start, stop, reset };
}
