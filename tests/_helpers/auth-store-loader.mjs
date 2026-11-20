// Hook de resolución para probar src/stores/auth.ts REAL con el runner nativo de Node (sin bundler ni alias `@/`): API, cliente HTTP, router
// y reseteo de sesión se sustituyen por dobles de tests/_helpers/stubs/auth-store-doubles.mjs. Solo afecta a auth.ts.
const doubles = new URL('./stubs/auth-store-doubles.mjs', import.meta.url).href;
const REPLACEMENTS = {
  '@/lib/api': `${doubles}?api`,
  '@/lib/api/client': `${doubles}?client`,
  '@/lib/router': `${doubles}?router`,
  '@/lib/session-reset': `${doubles}?reset`,
};

export async function resolve(specifier, context, nextResolve) {
  const parent = String(context.parentURL ?? '').split('?')[0];
  if (parent.endsWith('/src/stores/auth.ts') && REPLACEMENTS[specifier]) {
    return { url: REPLACEMENTS[specifier], shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
