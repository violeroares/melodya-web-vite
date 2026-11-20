/**
 * MELODYA WEB (Vite) — Open Graph dinámico en el HTML INICIAL (sin SSR de React).
 *
 * Una SPA entrega siempre el mismo index.html; los crawlers (WhatsApp, Facebook, X, Telegram, Slack, Google…) no ejecutan
 * JavaScript, así que cambiar <meta> desde el navegador no sirve. Este módulo resuelve los metadatos de /songs/:id y
 * /user/:id consultando los endpoints PÚBLICOS del backend (GET /community/songs/:id, GET /community/users/:id; ambos
 * `optionalAuth`) e inyecta las etiquetas en el HTML antes de enviarlo. React se hidrata después como siempre.
 *
 * Sin dependencias: solo Node (fetch, URL). Todo el contenido proviene de usuarios, así que SE ESCAPA siempre.
 */

export const SITE_NAME = 'Melodya';
export const DEFAULT_TITLE = 'Melodya — De una idea a una canción.';
export const DEFAULT_DESCRIPTION = 'Tenés una idea. Melodya te ayuda a convertirla en música.';

/** ids del backend: se validan antes de armar cualquier URL hacia el backend (evita path injection / SSRF). */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const isValidId = (id) => typeof id === 'string' && ID_RE.test(id);

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Una línea, sin saltos ni espacios repetidos, recortada con «…». */
export function clip(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Convierte una URL relativa del backend (/api/files/:id/stream) en absoluta contra el origen del backend. */
export function absoluteFileUrl(url, apiBase) {
  if (!url || typeof url !== 'string') return null;
  if (/^https?:\/\//i.test(url)) return url;
  try {
    const origin = new URL(apiBase).origin;
    return `${origin}${url.startsWith('/') ? '' : '/'}${url}`;
  } catch {
    return null;
  }
}

/** Metadatos de una canción pública. `song` = data de GET /community/songs/:id. */
export function buildSongMeta(song, { apiBase, origin }) {
  const title = clip(song.title, 90) || 'Canción';
  const author = clip(song.author?.name, 60);
  const bits = [song.description, song.styleSummary].map((s) => clip(s, 160)).filter(Boolean);
  const description = clip(
    [author ? `Canción de ${author} en Melodya` : 'Canción en Melodya', bits[0] || (song.genre ? clip(song.genre, 40) : '')]
      .filter(Boolean)
      .join(' · ') || DEFAULT_DESCRIPTION,
    200,
  );
  return {
    kind: 'song',
    title: `${title}${author ? ` — ${author}` : ''} · ${SITE_NAME}`,
    ogTitle: `${title}${author ? ` — ${author}` : ''}`,
    description,
    image: absoluteFileUrl(song.coverUrl, apiBase),
    imageAlt: `Portada de ${title}`,
    url: `${origin}/songs/${encodeURIComponent(song.id)}`,
    ogType: 'music.song',
    card: 'summary_large_image',
  };
}

/** Metadatos de un perfil público. `user` = data de GET /community/users/:id. */
export function buildProfileMeta(user, { apiBase, origin }) {
  const name = clip(user.name, 60) || 'Creador';
  const description = clip(user.bio, 200) || `Descubrí las canciones de ${name} en Melodya.`;
  const image = absoluteFileUrl(user.avatarUrl, apiBase) ?? absoluteFileUrl(user.coverImageUrl, apiBase);
  return {
    kind: 'profile',
    title: `${name} · ${SITE_NAME}`,
    ogTitle: `${name} en ${SITE_NAME}`,
    description,
    image,
    imageAlt: `Foto de ${name}`,
    url: `${origin}/user/${encodeURIComponent(user.id)}`,
    ogType: 'profile',
    card: image ? 'summary' : 'summary_large_image',
  };
}

/** Bloque de etiquetas (ya escapadas). */
export function renderMetaBlock(meta, { fallbackImage }) {
  const image = meta.image ?? fallbackImage ?? null;
  const e = escapeHtml;
  const lines = [
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:type" content="${e(meta.ogType)}" />`,
    `<meta property="og:title" content="${e(meta.ogTitle)}" />`,
    `<meta property="og:description" content="${e(meta.description)}" />`,
    `<meta property="og:url" content="${e(meta.url)}" />`,
    `<meta property="og:locale" content="es_AR" />`,
  ];
  if (image) {
    lines.push(`<meta property="og:image" content="${e(image)}" />`);
    if (image.startsWith('https://')) lines.push(`<meta property="og:image:secure_url" content="${e(image)}" />`);
    lines.push(`<meta property="og:image:alt" content="${e(meta.imageAlt)}" />`);
  }
  lines.push(
    `<meta name="twitter:card" content="${image ? meta.card : 'summary'}" />`,
    `<meta name="twitter:title" content="${e(meta.ogTitle)}" />`,
    `<meta name="twitter:description" content="${e(meta.description)}" />`,
  );
  if (image) lines.push(`<meta name="twitter:image" content="${e(image)}" />`);
  lines.push(`<link rel="canonical" href="${e(meta.url)}" />`);
  return lines.join('\n    ');
}

const OG_BLOCK_RE = /<!--og:start-->[\s\S]*?<!--og:end-->/;
const TITLE_RE = /<title>[\s\S]*?<\/title>/;
const DESC_RE = /<meta name="description" content="[^"]*" \/>/;

/** Reemplaza <title>, <meta name=description> y el bloque OG de index.html por los de `meta`. */
export function injectMeta(html, meta, opts = {}) {
  const block = `<!--og:start-->\n    ${renderMetaBlock(meta, opts)}\n    <!--og:end-->`;
  let out = html.replace(TITLE_RE, () => `<title>${escapeHtml(meta.title)}</title>`);
  out = out.replace(DESC_RE, () => `<meta name="description" content="${escapeHtml(meta.description)}" />`);
  return OG_BLOCK_RE.test(out) ? out.replace(OG_BLOCK_RE, () => block) : out.replace('</head>', () => `${block}\n  </head>`);
}

/** Qué ruta pública tiene metadatos dinámicos. */
export function matchOgRoute(pathname) {
  const m = /^\/(songs|user)\/([^/]+)\/?$/.exec(pathname);
  if (!m) return null;
  let id;
  try {
    id = decodeURIComponent(m[2]);
  } catch {
    return null;
  }
  if (!isValidId(id)) return null;
  return { type: m[1] === 'songs' ? 'song' : 'profile', id };
}

/** Caché en memoria con TTL y tope (evita que un crawler agote el backend y que un id inventado crezca sin límite). */
export function createTtlCache({ ttlMs = 60_000, max = 500 } = {}) {
  const map = new Map();
  return {
    get(key) {
      const hit = map.get(key);
      if (!hit) return undefined;
      if (hit.exp < Date.now()) {
        map.delete(key);
        return undefined;
      }
      return hit.value;
    },
    set(key, value, ttl = ttlMs) {
      if (map.size >= max) map.delete(map.keys().next().value);
      map.set(key, { value, exp: Date.now() + ttl });
    },
  };
}

/**
 * Consulta el backend y devuelve `meta` o null (no existe / es privada / el backend no responde).
 * Nunca lanza: ante cualquier problema la página se sirve con los metadatos genéricos de Melodya.
 */
export async function resolveMeta(route, { apiBase, origin, fetchImpl = fetch, timeoutMs = 3000, cache }) {
  const key = `${route.type}:${route.id}`;
  const cached = cache?.get(key);
  if (cached !== undefined) return cached;
  const path = route.type === 'song' ? `/community/songs/${route.id}` : `/community/users/${route.id}`;
  let meta = null;
  let ttl;
  try {
    const res = await fetchImpl(`${apiBase}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) {
      const body = await res.json();
      const data = body?.data ?? body;
      if (data && typeof data === 'object' && data.id) {
        meta = route.type === 'song' ? buildSongMeta(data, { apiBase, origin }) : buildProfileMeta(data, { apiBase, origin });
      }
    } else if (res.status >= 500) {
      ttl = 5_000; // error del backend: reintentar pronto
    }
  } catch {
    ttl = 5_000;
  }
  cache?.set(key, meta, ttl);
  return meta;
}
