// Doble de lib/auth-image para el reproductor. Por defecto no hay blob autenticado (como antes); una prueba puede fijar
// `authImageState` para simular que la portada se descargó con Authorization y qué MIME real tenía.
export const authImageState = { objectUrl: null, type: undefined };
export const authImageObjectUrl = async () => authImageState.objectUrl;
export const authImageMimeType = (u) => (u && u === authImageState.objectUrl ? authImageState.type : undefined);
