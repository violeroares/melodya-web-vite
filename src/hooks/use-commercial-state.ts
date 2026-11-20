import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/auth';
import { refreshCommercialState } from '@/lib/commercial-state';

/** Función estable para refrescar el estado comercial tras una acción del usuario (compra, upgrade, cambio programado, cancelación, reanudación). */
export function useRefreshCommercialState(): () => Promise<void> {
  const qc = useQueryClient();
  return useCallback(() => refreshCommercialState(qc, () => useAuthStore.getState().loadMe()), [qc]);
}
