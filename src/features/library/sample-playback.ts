/**
 * MELODYA WEB — Biblioteca: estado visible del botón Play/Pausa de una muestra.
 *
 * El reproductor es único (playerStore); el botón no guarda estado propio: lo calcula con la pista actual y `isPlaying`.
 * Sin React ni alias de módulos, para poder probarlo con el runner nativo de Node.
 */
export interface PlaybackSnapshot {
  track: { id: string } | null;
  isPlaying: boolean;
}

/** ¿Está sonando ESTA pista? Una pista cargada pero en pausa no cuenta. */
export function isTrackPlaying(state: PlaybackSnapshot, id: string): boolean {
  return state.track?.id === id && state.isPlaying;
}

/** Icono y etiqueta accesible del botón: el icono muestra la acción que ocurrirá al pulsarlo, y la etiqueta dice lo mismo. */
export function playButtonView(playing: boolean, name: string): { icon: 'pause' | 'play'; label: string } {
  return playing ? { icon: 'pause', label: `Pausar ${name}` } : { icon: 'play', label: `Reproducir ${name}` };
}
