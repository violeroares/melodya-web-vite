/**
 * MELODYA WEB — Letra de la pista del reproductor.
 *
 * Solo las canciones tienen letra y ficha en /songs/:id. Las muestras (voz o instrumental, `kind: 'sample'`) son otro
 * recurso: no se les pide letra (su id no es el de una canción y daría 404). Ausente `kind` = canción.
 * Sin React ni alias de módulos.
 */
export interface LyricsTrack {
  id: string;
  kind?: 'song' | 'sample';
  isPublic?: boolean;
}

export function trackSupportsLyrics(track: Pick<LyricsTrack, 'kind'> | null | undefined): boolean {
  return track?.kind !== 'sample';
}

export interface LyricsLookup {
  /** GET /community/songs/:id → letra de una canción pública. */
  communityLyrics: (id: string) => Promise<string | null | undefined>;
  /** GET /songs/:id → letra de la versión actual de una canción propia. */
  songLyrics: (id: string) => Promise<string | null | undefined>;
}

/** Letra de una canción; `null` sin consultar nada si la pista no es una canción. */
export async function fetchTrackLyrics(track: LyricsTrack, lookup: LyricsLookup): Promise<string | null> {
  if (!trackSupportsLyrics(track)) return null;
  const text = track.isPublic ? await lookup.communityLyrics(track.id) : await lookup.songLyrics(track.id);
  return text ?? null;
}
