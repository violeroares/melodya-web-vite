import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/auth';
import { refreshCommercialState } from '@/lib/commercial-state';
import { onPageRestored } from '@/lib/page-restore';

/** Ejecuta `onRestore` cuando la página vuelve del bfcache (p. ej. al regresar de Melodya Store). Sin restauración no hace nada. */
export function usePageRestore(onRestore: () => void): void {
  const ref = useRef(onRestore);
  useEffect(() => {
    ref.current = onRestore;
  });
  useEffect(() => onPageRestored(() => ref.current()), []);
}

/**
 * Al volver del bfcache (con o sin compra en Store) vuelve a leer lo que pudo cambiar mientras la página estaba congelada y el socket cerrado:
 * notificaciones y estado comercial (mismo mecanismo y la misma deduplicación que usa el socket al reconectar: no se lanzan pasadas en paralelo).
 */
export function useRefreshOnPageRestore(): void {
  const qc = useQueryClient();
  const status = useAuthStore((s) => s.status);
  usePageRestore(() => {
    if (status !== 'authenticated') return;
    void qc.invalidateQueries({ queryKey: ['notifications'] });
    void refreshCommercialState(qc, () => useAuthStore.getState().loadMe());
  });
}
