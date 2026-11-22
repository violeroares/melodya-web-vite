/**
 * MELODYA WEB — ¿Se está mostrando la landing pública?
 *
 * Única fuente de verdad para dos decisiones que deben coincidir siempre:
 *  • qué vista pinta la ruta «/» (landing para invitados, HomeView con sesión), y
 *  • si el AppShell oculta su navegación (sidebar, header, bottom bar, footer, barra de anuncios, paleta de comandos).
 *
 * Lógica pura, sin React ni dependencias de la aplicación. Sólo la raíz «/» de un INVITADO confirmado es la landing: cualquier otra ruta
 * (pública o privada) conserva el shell completo, y una sesión guardada que se está recuperando tras un error temporal NO es un invitado.
 */

export interface PublicLandingInput {
  path: string;
  /** Usuario con perfil validado (null = sin sesión). */
  user: unknown;
  /** Estado de la sesión del store de autenticación. */
  status: 'idle' | 'loading' | 'guest' | 'authenticated' | string;
  /** Sesión guardada que se recupera tras un error temporal (429 / red / 5xx). */
  sessionRecovering?: boolean;
}

export function isPublicLanding({ path, user, status, sessionRecovering = false }: PublicLandingInput): boolean {
  return path === '/' && !user && status === 'guest' && !sessionRecovering;
}
