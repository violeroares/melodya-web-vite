
/**
 * MELODYA WEB — Funcionalidades fuera del plan: ¿está bloqueada?, ¿qué plan la habilita? y cómo se pide el aviso de upgrade.
 *
 * Salen de las capacidades EFECTIVAS que informa el servidor (GET /users/me → entitlements): `excluded` = el plan no la incluye (corona, independiente del modo);
 * `locked` = además el servidor la exige hoy (`enforced`), así que la acción se bloquea (ver isLocked). El plan requerido sale del catálogo (GET /plans, con las capacidades de cada plan): no hay ninguna asociación fija
 * entre funcionalidades y planes en la interfaz. El servidor sigue siendo quien valida (403 CAPABILITY_NOT_IN_PLAN).
 */
import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { billingApi } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useUpgradePrompt } from '@/stores/upgrade-prompt';
import { isLocked, isPlanExcluded, type CapabilityKey } from '@/lib/capabilities';
import { upgradeCopy, type CatalogPlanLike, type UpgradeCopy } from '@/lib/plan-gate';
import { useEntitlements } from './use-capabilities';

/** Catálogo público de planes (misma consulta que «Planes y fichas»: comparte caché). Falla en silencio: sin catálogo el aviso es genérico. */
export function usePlanCatalog(): CatalogPlanLike[] {
  const userId = useAuthStore((s) => s.user?.id ?? 'anon');
  const { data } = useQuery({ queryKey: ['plans', userId], queryFn: () => billingApi.plans(), staleTime: 5 * 60_000, retry: false });
  return (data?.items as CatalogPlanLike[] | undefined) ?? [];
}

export interface PlanGate {
  /** El plan efectivo no incluye la capacidad (indicación visual: corona y plan mínimo). No bloquea la acción por sí solo. */
  excluded: boolean;
  /** El plan efectivo no incluye la capacidad Y el servidor la exige hoy: la acción se bloquea y se ofrece el upgrade. Implica `excluded`. */
  locked: boolean;
  /** Texto del aviso y plan mínimo (con la capacidad fuera del plan, se bloquee o no). */
  copy: UpgradeCopy | null;
  /** Abre el aviso de upgrade de esta capacidad. */
  prompt: () => void;
}

export function usePlanGate(key: CapabilityKey): PlanGate {
  const entitlements = useEntitlements();
  const plans = usePlanCatalog();
  const show = useUpgradePrompt((s) => s.show);
  const excluded = isPlanExcluded(entitlements, key);
  const locked = isLocked(entitlements, key);
  const copy = useMemo(() => (excluded ? upgradeCopy(key, plans) : null), [excluded, key, plans]);
  const prompt = useCallback(() => show(key), [show, key]);
  return { excluded, locked, copy, prompt };
}
