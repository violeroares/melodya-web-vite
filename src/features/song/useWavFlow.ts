
/**
 * Conecta la descarga WAV continua (lib/wav-flow) con la pantalla de la canción: pedir → esperar → descargar la versión elegida, sin que el usuario
 * tenga que volver a abrir el menú. No agrega polling ni sockets: el seguimiento es el listado de versiones que la pantalla ya consulta cada 8 s mientras
 * haya un WAV en preparación; cada dato nuevo (`dataUpdatedAt`) se le pasa al flujo, que decide si descargar, detenerse o seguir esperando.
 *
 * El flujo se crea por canción y se cancela al cambiar de canción o cerrar la pantalla (cleanup del efecto): no quedan descargas ni avisos pendientes.
 */
import { useEffect, useReducer, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { songsApi } from '@/lib/api';
import { downloadSongAudio } from '@/lib/song-download';
import { toUserMessage } from '@/lib/errors';
import { useToast } from '@/hooks/use-toast';
import { createWavFlow, type WavFlow, type WavFlowEvent, type WavPhase, type WavRequestInput } from '@/lib/wav-flow';
import type { WavStateLike } from '@/lib/capabilities';

type VersionsData = Awaited<ReturnType<typeof songsApi.versions>>;
const versionsKey = (songId: string) => ['song', songId, 'versions'] as const;

export function useWavFlow({ songId, versions, dataUpdatedAt }: { songId: string; versions: ReadonlyArray<{ id: string; wav?: WavStateLike | null }> | undefined; dataUpdatedAt: number }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, repaint] = useReducer((n: number) => n + 1, 0);
  const [flow, setFlow] = useState<WavFlow | null>(null);
  // Siempre el `toast` vigente sin recrear el flujo (y sin perder los intentos en curso) en cada render.
  const toastRef = useRef(toast);
  useEffect(() => { toastRef.current = toast; });

  useEffect(() => {
    const refresh = () => { void qc.invalidateQueries({ queryKey: versionsKey(songId) }); };
    const notify = (e: WavFlowEvent) => {
      const t = toastRef.current;
      if (e.type === 'preparing') t({ title: 'Estamos preparando tu WAV', description: 'Puede demorar unos minutos. Se descargará solo cuando esté listo.' });
      else if (e.type === 'started') { t({ title: 'Descarga iniciada 💾', description: `WAV de la versión ${e.versionNumber}` }); refresh(); }
      else if (e.type === 'failed') {
        t({ title: 'No pudimos preparar el WAV', description: `${e.message ?? 'Probá de nuevo más tarde.'}${e.retryable ? ' Podés reintentarlo desde el menú.' : ''}`, variant: 'destructive' });
        refresh();
      } else if (e.type === 'stalled') {
        t({ title: 'No pudimos seguir el estado del WAV', description: 'Revisá tu conexión. Cuando esté listo, descargalo desde el menú de la versión.' });
        refresh();
      } else if (e.type === 'gave-up') {
        t({ title: 'Seguimos preparando tu WAV', description: 'Está tardando más de lo habitual. Cuando esté listo, descargalo desde el menú de la versión.' });
        refresh();
      } else {
        t({ title: 'No pudimos completar la descarga del WAV', description: toUserMessage(e.error), variant: 'destructive' });
        refresh();
      }
    };
    const f = createWavFlow({
      requestWav: async (sid, vid) => {
        const next = await songsApi.retryWav(sid, vid);
        // El estado REAL que devolvió el servidor entra ya a la consulta de versiones: la interfaz no espera al próximo sondeo ni queda desfasada.
        qc.setQueryData<VersionsData>(versionsKey(sid), (old) => (old ? { ...old, items: old.items.map((v) => (v.id === vid ? { ...v, wav: next } : v)) } : old));
        refresh();
        return next;
      },
      download: async (input) => {
        const out = await downloadSongAudio(input);
        void qc.invalidateQueries({ queryKey: ['usage'] });
        return out;
      },
      onChange: repaint,
      report: notify,
    });
    setFlow(f);
    return () => { f.dispose(); setFlow((cur) => (cur === f ? null : cur)); };
  }, [songId, qc]);

  // Al volver a la pestaña el sondeo se reanuda: se le da al flujo un margen nuevo antes de darlo por detenido (el listener se quita al cerrar o cambiar de canción).
  useEffect(() => {
    if (!flow || typeof document === 'undefined') return undefined;
    const onVisible = () => { if (document.visibilityState === 'visible') flow.touch(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [flow]);

  // Cada dato nuevo del servidor se le pasa al flujo (descarga automática al quedar listo, detención si falla, tope de espera).
  useEffect(() => {
    flow?.onVersions(songId, versions ?? []);
    // `versions` se lee en el momento del dato nuevo; el disparador es el dato (dataUpdatedAt), no cada render.
  }, [flow, songId, dataUpdatedAt]);

  return {
    /** Fase del intento del usuario para esa versión (o null): `requesting` · `preparing` · `downloading`. */
    phaseOf: (versionId: string | undefined): WavPhase | null => (versionId ? flow?.get(versionId)?.phase ?? null : null),
    request: (input: WavRequestInput) => { void flow?.request(input); },
  };
}
