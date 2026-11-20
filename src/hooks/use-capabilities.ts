
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { profileApi } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { downloadState, isLocked, type CapabilityKey, type Entitlements } from '@/lib/capabilities';

/** Capacidades del plan efectivo del usuario (viene en GET /users/me). */
export function useEntitlements(): Entitlements | null {
  return useAuthStore((s) => (s.user?.entitlements as Entitlements | undefined) ?? null);
}

/** Consumo y renovación de cupos (E6). Se invalida (`['usage']`) al crear una canción. */
export function useUsage() {
  const status = useAuthStore((s) => s.status);
  return useQuery({ queryKey: ['usage'], queryFn: () => profileApi.usage(), enabled: status === 'authenticated', staleTime: 30_000 });
}

/** Estado del botón «Descargar»: bloqueado por capacidad o cupo (solo si el servidor lo exige) y medidor de descargas. */
export function useDownloadState() {
  const entitlements = useEntitlements();
  const { data: usage } = useUsage();
  return useMemo(() => downloadState(entitlements, usage), [entitlements, usage]);
}

/** ¿Está bloqueada esta capacidad? true solo si el servidor la exige y el plan no la incluye (ver lib/capabilities). */
export function useCapabilityLocked(key: CapabilityKey): boolean {
  const entitlements = useEntitlements();
  return useMemo(() => isLocked(entitlements, key), [entitlements, key]);
}
