/**
 * MELODYA WEB — Restauración de la página desde el Back-Forward Cache (bfcache).
 *
 * Al salir hacia Melodya Store (`window.location.assign`) el navegador puede conservar esta página congelada, con todo su estado de React, y restaurarla
 * tal cual al volver con «atrás». En ese caso NO hay recarga: los estados «cargando» siguen activos y lo que ocurrió afuera (una compra, avisos que llegaron
 * con el socket cerrado) no se ve. La única señal es `pageshow` con `persisted === true`; sin restauración (recarga normal) ese evento no cuenta.
 *
 * Módulo puro: el destino de los eventos es inyectable para las pruebas.
 */
export interface PageShowTarget {
  addEventListener(type: 'pageshow', listener: (event: { persisted?: boolean }) => void): void;
  removeEventListener(type: 'pageshow', listener: (event: { persisted?: boolean }) => void): void;
}

/** Llama a `onRestore` cada vez que la página se restaura desde el bfcache. Devuelve la función que quita el aviso. */
export function onPageRestored(onRestore: () => void, target: PageShowTarget | undefined = typeof window === 'undefined' ? undefined : window): () => void {
  if (!target) return () => {};
  const listener = (event: { persisted?: boolean }) => {
    if (event.persisted) onRestore();
  };
  target.addEventListener('pageshow', listener);
  return () => target.removeEventListener('pageshow', listener);
}
