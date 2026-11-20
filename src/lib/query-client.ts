/**
 * MELODYA WEB — QueryClient compartido de TanStack Query.
 * Vive en un módulo propio para que tanto el provider (routes.tsx) como
 * helpers fuera de componentes (src/lib/like.ts) usen LA MISMA instancia
 * (invalidaciones de caché desde acciones no-React, sin romper las
 * rules-of-hooks).
 *
 * Política de reintentos (lib/api/resilience.ts):
 *  • 401: lo resuelve el interceptor de axios (refresh único → reintento); React Query no reintenta.
 *  • 403 / 404 / 4xx: no se reintentan (reintentar no cambia el resultado).
 *  • 429: NO se reintenta de inmediato (cada reintento cuenta contra el límite); las consultas con `refetchInterval` esperan al
 *    menos Retry-After.
 *  • Red / timeout / 5xx: hasta 2 reintentos (1 vez en un 500) con backoff exponencial + jitter.
 */
import { QueryClient } from '@tanstack/react-query';
import { queryRetryDelayMs, shouldRetryQuery } from '@/lib/api/resilience';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 20_000,
      refetchOnWindowFocus: false,
      retry: shouldRetryQuery,
      retryDelay: queryRetryDelayMs,
    },
  },
});
