/**
 * Plugin de Vite: el servidor de desarrollo (`npm run dev`) y `vite preview` entregan el MISMO HTML con Open Graph que
 * server/server.mjs, para poder verificar los metadatos sin build. Solo actúa en /songs/:id y /user/:id.
 */
import { loadEnv } from 'vite';
import { createTtlCache, injectMeta, matchOgRoute, resolveMeta } from './og.mjs';

export function ogPlugin() {
  const cache = createTtlCache();
  let env = {};

  const middleware = (getHtml) => async (req, res, next) => {
    try {
      if (req.method !== 'GET') return next();
      const url = new URL(req.url ?? '/', 'http://localhost');
      const route = matchOgRoute(url.pathname);
      const apiBase = (env.OG_API_BASE_URL || env.VITE_API_BASE_URL || '').trim().replace(/\/+$/, '');
      if (!route || !apiBase) return next();
      const origin = (env.OG_PUBLIC_ORIGIN || `http://${req.headers.host}`).replace(/\/+$/, '');
      const meta = await resolveMeta(route, { apiBase, origin, cache });
      if (!meta) return next();
      const html = injectMeta(await getHtml(req.url), meta, { fallbackImage: `${origin}/icon-512.png` });
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(html);
    } catch (err) {
      next(err);
    }
  };

  return {
    name: 'melodya-og',
    config(_, { mode }) {
      env = loadEnv(mode, process.cwd(), '');
    },
    configureServer(server) {
      server.middlewares.use(
        middleware(async (reqUrl) => {
          const fs = await import('node:fs/promises');
          const raw = await fs.readFile(new URL('../index.html', import.meta.url), 'utf8');
          return server.transformIndexHtml(reqUrl, raw);
        }),
      );
    },
    configurePreviewServer(server) {
      server.middlewares.use(
        middleware(async () => {
          const fs = await import('node:fs/promises');
          return fs.readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
        }),
      );
    },
  };
}
