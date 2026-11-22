/**
 * MELODYA WEB — Papelera general: lógica pura (sin React ni red), para poder probarla.
 * Los cinco tipos usan borrado LÓGICO en el backend (deletedAt): enviar a la Papelera no borra nada y restaurar no reconstruye nada.
 */

export const TRASH_TYPE_KEYS = ['songs', 'lyrics', 'projects', 'songwriters', 'samples'] as const;
export type TrashType = (typeof TRASH_TYPE_KEYS)[number];

export const TRASH_TYPE_LABELS: Record<TrashType, string> = {
  songs: 'Canciones',
  lyrics: 'Letras',
  projects: 'Álbumes',
  songwriters: 'Letristas',
  samples: 'Audios y voces',
};

/** Cómo se nombra un elemento restaurado en el aviso («Canción restaurada»). */
export const TRASH_RESTORED_TITLE: Record<TrashType, string> = {
  songs: 'Canción restaurada',
  lyrics: 'Letra restaurada',
  projects: 'Álbum restaurado',
  songwriters: 'Letrista restaurado',
  samples: 'Elemento restaurado',
};

export const TRASH_EMPTY: Record<TrashType, { title: string; description: string }> = {
  songs: { title: 'No hay canciones en la Papelera.', description: 'Las canciones que envíes a la Papelera aparecen acá y podés restaurarlas cuando quieras.' },
  lyrics: { title: 'No hay letras en la Papelera.', description: 'Las letras que envíes a la Papelera aparecen acá y podés restaurarlas cuando quieras.' },
  projects: { title: 'No hay álbumes en la Papelera.', description: 'Los álbumes que envíes a la Papelera aparecen acá. Sus canciones nunca se mueven.' },
  songwriters: { title: 'No hay letristas en la Papelera.', description: 'Los letristas que envíes a la Papelera aparecen acá y vuelven con sus referencias.' },
  samples: { title: 'No hay audios ni voces en la Papelera.', description: 'Lo que envíes a la Papelera aparece acá con su audio conservado.' },
};

/** Segunda parte de /library/trash[/tipo]; cualquier otra cosa cae en «songs». */
export function trashTypeFromPath(path: string): TrashType {
  const seg = path.replace(/^\/library\/trash\/?/, '').split('/')[0];
  return (TRASH_TYPE_KEYS as readonly string[]).includes(seg) ? (seg as TrashType) : 'songs';
}

export const trashPathFor = (type: TrashType): string => `/library/trash/${type}`;

/** Un 404 al enviar/restaurar significa que otra sesión ya lo hizo: se refresca en silencio, no es un error para el usuario. */
export function isAlreadyGone(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: unknown }).status === 404;
}

/**
 * Aviso a mostrar ANTES de restaurar (null = se restaura sin confirmar).
 *  • Canción pública: vuelve a la Comunidad con su estado anterior.
 *  • Voz clonada: restaurar el registro NO garantiza que la voz externa siga vigente en Suno; no se simula que lo esté.
 */
export function restoreWarning(type: TrashType, item: { visibility?: string | null; sunoPersonaId?: string | null }): string | null {
  if (type === 'songs' && item.visibility === 'PUBLIC') {
    return 'Era pública: al restaurarla vuelve a la Comunidad, con sus me gusta y comentarios.';
  }
  if (type === 'samples' && item.sunoPersonaId) {
    return 'Restaurar la grabación no garantiza que la voz clonada siga vigente en Suno. Si caducó, vas a tener que volver a clonarla.';
  }
  return null;
}

/** Claves de react-query a refrescar al enviar o restaurar un elemento de este tipo (siempre incluye la Papelera). */
export function keysToInvalidate(type: TrashType): ReadonlyArray<readonly string[]> {
  const own: Record<TrashType, ReadonlyArray<readonly string[]>> = {
    songs: [['songs'], ['community']],
    lyrics: [['lyrics']],
    projects: [['projects'], ['project-songs']],
    songwriters: [['songwriters']],
    samples: [['samples'], ['voice-sessions']],
  };
  return [...own[type], ['trash']];
}

/** Detalle de una canción de la Papelera: el MISMO que abre Biblioteca (#/songs/:id), en solo lectura y con «Restaurar». */
export const songDetailPath = (id: string): string => `/songs/${encodeURIComponent(id)}`;
