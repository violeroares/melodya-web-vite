/**
 * Claves de localStorage que `resetUserSessionState` BORRA al cerrar sesión (datos de usuario que no deben quedar visibles para la
 * siguiente cuenta).
 *
 * Los BORRADORES locales (`melodya.draft.v1.<userId>.*`), las solicitudes pendientes (`melodya.pending.v1.<userId>.*`) y el borrador
 * legado (`melodya.creator.solar.v1`) NO están en esta lista a propósito: conservar el trabajo del usuario al cerrar sesión es una
 * decisión de producto, y el aislamiento entre cuentas lo garantiza su clave con `userId` (no el borrado). Ver docs/borradores-locales.md.
 *
 * (Se quitó `melodya.creator.draft`: era una clave que ningún código escribe; el borrador real usaba otra, así que ese borrado nunca
 * protegió nada.)
 */
export const USER_STORAGE_KEYS = [
  'melodya.player.recent', // "escuchadas recientemente"
  'melodya.player.session', // pista/cola del reproductor
] as const;
