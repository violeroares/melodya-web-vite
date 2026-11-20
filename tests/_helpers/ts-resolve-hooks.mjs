// Hook de resolución para los tests: los módulos puros de `src` importan a sus vecinos sin extensión (como los resuelve el bundler);
// Node, al cargar .ts directamente, necesita la extensión. Solo se usa en pruebas; el código de la aplicación no cambia.
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && /^\.{1,2}\//.test(specifier) && !/\.\w+$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    throw err;
  }
}
