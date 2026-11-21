// Hook de resolución para probar src/lib/auth-image.ts REAL con el runner nativo de Node (sin bundler ni alias `@/`): la sesión y el cliente
// HTTP se sustituyen por dobles mínimos (tests/_helpers/stubs); resilience.ts (módulo puro) se carga real. Solo afecta a auth-image.ts.
const stub = (name) => new URL(`./stubs/${name}`, import.meta.url).href;
const REPLACEMENTS = {
  '@/stores/auth': stub('auth.mjs'),
  '@/lib/api/client': stub('api-client.mjs'),
  '@/lib/api/resilience': new URL('../../src/lib/api/resilience.ts', import.meta.url).href,
};

export async function resolve(specifier, context, nextResolve) {
  const parent = String(context.parentURL ?? '').split('?')[0];
  if (parent.endsWith('/src/lib/auth-image.ts') && REPLACEMENTS[specifier]) {
    return { url: REPLACEMENTS[specifier], shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
