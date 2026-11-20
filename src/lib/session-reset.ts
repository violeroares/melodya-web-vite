
/**
 * MELODYA WEB — Reset de estado de usuario (logout / cambio de cuenta).
 *
 * El SPA no se recarga al cerrar sesión: sin este reset, todo el estado que
 * vive fuera del authStore sobrevive al logout y se "filtra" al siguiente
 * usuario del mismo navegador:
 *   • Caché de React Query (biblioteca, proyectos, perfil, comunidad…) con el
 *     staleTime por defecto: el usuario nuevo ve los datos del anterior hasta
 *     que cada query refresque (o nunca, si la vista ya estaba montada).
 *   • Reproductor: el audio del usuario anterior sigue sonando, y su cola /
 *     "escuchadas recientemente" quedan en localStorage.
 *   • Object URLs de imágenes privadas (avatares, portadas PRIVADAS bajadas
 *     con fetch autenticado) cacheados en memoria.
 *
 * Los borradores del creador y las solicitudes pendientes NO se borran acá: se conservan al cerrar sesión y están aislados por cuenta
 * (la clave y el registro llevan el userId; ver draft-store.ts y user-storage-keys.ts).
 *
 * Se invoca al hacer login/logout (y en el 401 definitivo del refresh), así el
 * usuario que entra arranca desde cero — equivalente a un Ctrl+F5 sin recargar.
 */
import { queryClient } from './query-client';
import { usePlayerStore } from '@/stores/player';
import { clearAuthImageCache } from './auth-image';
import { USER_STORAGE_KEYS } from './user-storage-keys';

export async function resetUserSessionState(): Promise<void> {
  /* 1) React Query: cancelar todo lo en vuelo y vaciar la caché completa
   *    (queries + mutaciones). Las vistas vuelven a sus skeletons. */
  await queryClient.cancelQueries();
  queryClient.clear();

  /* 2) Reproductor: corta el audio, vacía cola/historial/radio y borra su
   *    sesión persistida. (Volumen/velocidad son preferencias del dispositivo:
   *    se conservan.) */
  usePlayerStore.getState().hardReset();

  /* 3) Object URLs de imágenes privadas: se revocan para liberar memoria y
   *    que no queden accesibles blobs del usuario anterior. */
  clearAuthImageCache();

  /* 4) Datos de usuario en localStorage. */
  if (typeof window !== 'undefined') {
    for (const key of USER_STORAGE_KEYS) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        /* storage no disponible: no rompe nada */
      }
    }
  }
}
