
/**
 * «Hecho a partir de»: atribución permanente de un remix a la canción original y a su autor, en una pieza compacta:
 *
 *   (portada circular)  Hecho a partir de
 *                       Nombre de la canción original      ← enlaza al detalle de la original
 *                       Autor original                     ← enlaza a su perfil público
 *
 * No muestra la versión ni la modalidad (Cover / configuración reutilizada); esos datos siguen completos en `SongOrigin`.
 * Si el original ya no es accesible para quien mira, el servidor solo envía `available: false`: se muestra «Canción no disponible» sin título,
 * portada, autor ni enlaces. La portada real del original llega en `origin.song.coverUrl` (el servidor aplica el mismo criterio que el detalle
 * de la comunidad); si el original no tiene portada, CoverArt muestra su alternativa visual.
 *
 * El contador de remixes NO va acá: vive junto a los demás contadores del detalle (SongDetailView).
 */

import { Link } from '@/lib/router';
import { RemixIcon } from '@/features/song/RemixIcon';
import { CoverArt } from '@/components/common';
import type { SongOrigin } from '@/types';
import { originAuthorPath, originSongPath, remixAttributionView } from '@/features/song/remix-attribution';

export function RemixAttribution({ origin }: { origin?: SongOrigin | null }) {
  const view = remixAttributionView(origin);
  if (!view) return null;

  if (!view.available) {
    return (
      <section aria-label="Origen del remix" className="flex max-w-md items-center gap-3" data-testid="remix-origin-unavailable">
        <span aria-hidden className="flex size-12 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted-foreground">
          <RemixIcon className="h-5 w-5" />
        </span>
        <div className="min-w-0 leading-tight">
          <p className="text-xs text-muted-foreground">Hecho a partir de</p>
          <p className="truncate text-sm font-semibold text-muted-foreground">Canción no disponible</p>
        </div>
      </section>
    );
  }

  const songPath = originSongPath(view.songId);
  return (
    <section aria-label="Origen del remix" className="flex max-w-md items-center gap-3" data-testid="remix-origin">
      {/* La portada también lleva al original; no es un punto de tabulación aparte (el título ya lo es). */}
      <Link to={songPath} tabIndex={-1} aria-hidden className="shrink-0 rounded-full" data-testid="remix-origin-cover">
        <CoverArt id={view.songId} src={view.coverUrl} alt="" className="size-12" rounded="rounded-full" />
      </Link>
      <div className="min-w-0 leading-tight">
        <p className="text-xs text-muted-foreground">Hecho a partir de</p>
        <Link
          to={songPath}
          title={view.title}
          data-testid="remix-origin-title"
          className="block truncate rounded text-sm font-semibold text-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber"
        >
          {view.title}
        </Link>
        {view.authorId && view.authorName && (
          <Link
            to={originAuthorPath(view.authorId)}
            data-testid="remix-origin-author"
            className="block truncate rounded text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber"
          >
            {view.authorName}
          </Link>
        )}
      </div>
    </section>
  );
}
