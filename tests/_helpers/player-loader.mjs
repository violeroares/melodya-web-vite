// Hook de resolución para probar src/stores/player.ts con el runner nativo de Node (sin bundler ni alias `@/`):
// las dependencias de infraestructura del store (sesión, audio-viz, cliente HTTP, imágenes autenticadas) se sustituyen por
// dobles mínimos de tests/_helpers/stubs; `./player-source` se resuelve al archivo real (.ts). Solo afecta a player.ts.
const stub = (name) => new URL(`./stubs/${name}`, import.meta.url).href;
const REPLACEMENTS = {
  './auth': stub('auth.mjs'),
  '@/lib/audio-viz': stub('audio-viz.mjs'),
  '@/lib/api/client': stub('api-client.mjs'),
  '@/lib/api': stub('api.mjs'),
  '@/lib/auth-image': stub('auth-image.mjs'),
  './player-source': new URL('../../src/stores/player-source.ts', import.meta.url).href,
  '@/lib/api/resilience': new URL('../../src/lib/api/resilience.ts', import.meta.url).href,
};

export async function resolve(specifier, context, nextResolve) {
  const parent = String(context.parentURL ?? '').split('?')[0];
  if (parent.endsWith('/src/stores/player.ts') && REPLACEMENTS[specifier]) {
    return { url: REPLACEMENTS[specifier], shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
