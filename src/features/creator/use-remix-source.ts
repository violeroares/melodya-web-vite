
/**
 * Remix: reúne la plantilla segura del servidor y, si la canción es PROPIA, la configuración original (misma lectura que «Otra versión»).
 * Devuelve la forma de `VersionSource` para que el creador use el mismo circuito (hidratación, edición, espera, errores).
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { songsApi } from '@/lib/api';
import { ApiError } from '@/lib/api/client';
import type { CapabilityLocks } from '@/lib/capabilities';
import type { RemixMode, RemixTemplate } from '@/types';
import { BLANK_ORIGIN, blankHydration, type Hydration } from './version-source';
import { useVersionSource, type VersionSource } from './use-version-source';
import { BLOCKED_TEXT, adaptOwnerHydration, classifyTemplateError, modeAvailability, songFromTemplate, type RemixBlockedKind } from './remix-source';
import { emptySong } from './song-model';

const retryTransient = (count: number, err: unknown): boolean => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2;

export interface RemixSource extends VersionSource {
  template: RemixTemplate | null;
  isOwner: boolean;
  blockedKind: RemixBlockedKind | null;
}

function detailsCode(err: unknown): string | undefined {
  if (!(err instanceof ApiError)) return undefined;
  const d = err.details as { code?: unknown } | undefined;
  return typeof d?.code === 'string' ? d.code : undefined;
}

export function useRemixSource(args: { songId: string | null; mode: RemixMode; from: string | null; locks: CapabilityLocks; enabled?: boolean }): RemixSource {
  const { songId, mode, from, locks, enabled = true } = args;
  // Sin la capacidad del plan no se pide nada: ni la plantilla ni la configuración de la canción.
  const on = Boolean(songId) && enabled;
  // «En blanco» del selector no es una versión: no viaja a la plantilla.
  const versionParam = from && from !== BLANK_ORIGIN ? from : null;

  const tplQ = useQuery({
    queryKey: ['remix-template', songId, versionParam],
    queryFn: () => songsApi.remixTemplate(songId as string, versionParam),
    enabled: on,
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: retryTransient,
  });
  const template = tplQ.data ?? null;
  const isOwner = Boolean(template?.isOwner);
  // Solo la canción propia recupera su configuración original (las ajenas nunca exponen GenerationInput).
  const own = useVersionSource({ songId: isOwner ? songId : null, from, locks });

  const hydration = useMemo<Hydration>(() => {
    if (!template) return { ...blankHydration(), song: { ...emptySong, remix: { mode } } };
    if (isOwner) return adaptOwnerHydration(own.hydration, template, mode);
    return songFromTemplate(template, mode);
  }, [template, isOwner, own.hydration, mode]);

  const blockedKind: RemixBlockedKind | null = (() => {
    if (tplQ.isError) {
      const e = tplQ.error;
      return e instanceof ApiError ? classifyTemplateError(e.status, e.code, detailsCode(e)) : 'error';
    }
    if (template) {
      const avail = modeAvailability(template, mode);
      if (!avail.ok) return avail.kind;
    }
    return null;
  })();

  const blocked: VersionSource['blocked'] = blockedKind
    ? { kind: blockedKind === 'error' ? 'error' : 'not-found', message: BLOCKED_TEXT[blockedKind] }
    : isOwner && own.status === 'blocked' ? own.blocked : null;

  const loading = on && !tplQ.isError && (tplQ.isPending || (isOwner && own.loading));
  const status: VersionSource['status'] = blocked ? 'blocked' : loading ? 'loading' : 'ready';

  const retry = () => {
    if (tplQ.isError) void tplQ.refetch();
    own.retry();
  };

  return {
    status,
    blocked,
    song: isOwner ? own.song : null,
    options: isOwner ? own.options : [],
    originId: isOwner ? own.originId : null,
    hydration,
    loading,
    retry,
    template,
    isOwner,
    blockedKind,
  };
}
