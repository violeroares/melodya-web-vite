# Política de tráfico HTTP y errores 429

Contexto: el backend (`melodya.backend`) aplica `generalLimiter` (600 solicitudes / 15 min por IP, ventana fija) a TODO `/api` — incluidos
`/auth/*` y `/files/*` — y `/auth/refresh` tiene además su propio límite (240). Esta app debe consumir poco y **degradar con elegancia** al
recibir un 429. Implementación en `src/lib/api/resilience.ts` (pura, probada) y `src/lib/api/polling.ts`.

## Clasificación de errores

| Error | Tratamiento |
|---|---|
| **401** en una petición | un único refresh compartido → replay una vez (`_retried`); si el replay vuelve a dar 401, se rinde (sin bucle) |
| **401 / 403 del refresh** | **definitivo** → `forceGuest()` (sesión cerrada, estado reseteado) |
| **refresh token vencido** (`expiresAt`) | definitivo, aunque el error sea transitorio |
| **403** normal | permisos: no se reintenta, no toca la sesión |
| **429** | **nunca cierra la sesión**; lee `Retry-After`; activa una compuerta global; React Query no reintenta; los pollers y el refresh proactivo esperan |
| red / timeout / 5xx | transitorios: reintento acotado con backoff exponencial + jitter; la sesión se conserva |
| resto de 4xx | error de la petición, sin reintento |

## Refresh proactivo

* Se agenda con el claim **`exp` del JWT** (el TTL lo fija el backend: `ACCESS_TOKEN_TTL`, 900 s por defecto), no con un TTL supuesto.
  Margen = 20 % de la vida del token entre 5 s y 2 min (TTL 900 s → ≈ 13 min; TTL 60 s → ≈ 48 s). Jitter ≤ 10 s y nunca > margen/2.
* Un solo timer por pestaña. Antes de pedir, el timer revisa el storage: si **otra pestaña ya renovó**, adopta su token sin pedir otro refresh
  (y el evento `storage` hace lo mismo al instante).
* Con la compuerta de 429 activa no se pide nada; tras un fallo transitorio se reintenta con backoff ≥ `Retry-After` + 1,5 s.
* Un 429 del refresh no se reintenta de inmediato (el backend limita antes de rotar, así que el token sigue vigente) y bloquea más
  intentos hasta pasar la espera. Un error de red/5xx tampoco se reenvía a ciegas: si el servidor ya rotó, reusar el token viejo fuera de la
  ventana de gracia (45 s) revocaría toda la familia de sesiones.
* Arranque con 429/red/5xx: la UI arranca como invitado, **los tokens quedan guardados** y se reintenta hidratar con backoff hasta recuperarla.

## React Query

`retry`: solo red (máx. 2) y 5xx (máx. 2; un 500, 1) con `retryDelay` exponencial; **nunca** 401/403/404/429 ni con la compuerta activa.
`refetchInterval` (notificaciones 30 s, WAV 8 s) usa `queryPollDelayMs`: periodo normal, backoff con error, ≥ `Retry-After` con 429.

## Polling (`startPoller`)

Un ciclo en vuelo a la vez; backoff con error; **no se detiene por errores transitorios**, sí por 403/404 o estado terminal; pausa con la pestaña
oculta y consulta al volver; espera a que termine la compuerta de 429. Lo usan `GenerationStatus` (2,5 s) y `useGenerationReconciliation`
(5 s con generaciones activas / 60 s en reposo).

## Imágenes privadas

`useAuthImage` omite el intento anónimo (que daría 401/403) cuando el llamador indica `requireAuth` (portada de una canción PRIVATE) o la URL
ya se aprendió como privada (sessionStorage; se borra al cambiar de usuario). Las descargas autenticadas se deduplican. Los permisos no cambian:
sigue autorizando el backend con el token del usuario.

## Pruebas (sin tráfico hacia api-dev)

`npm test` ejecuta, además de las heredadas: `traffic-resilience` (puras + poller con reloj simulado), `traffic-client-mock` (cliente HTTP real contra
`scripts/mock-api.mjs` en un puerto libre), `auth-session-traffic` (store real con dobles) y `traffic-static` (guardas anti-regresión).
Entorno manual aislado: `npm run dev:mock` (web en :3100 + mock en :4010; no toca `.env` ni el puerto 3000). Control del mock:
`POST :4010/__ctl` (`accessTtlSec`, `refreshMode`, `block`, `limit`, `genMode`, `meMode`…), contadores en `GET :4010/__stats`.

## Pendiente fuera de esta app

* **Backend** (requiere autorización): excluir `/files/*` (o darle techo propio) del `generalLimiter`; `keyGenerator` por usuario o `CF-Connecting-IP`; revisar
  `TRUST_PROXY`/cadena Cloudflare → NAS → backend (si `req.ip` es la IP del proxy, todas las apps comparten contador); exponer `Retry-After` por CORS.
* Reducir duplicados de arranque (varios `/banners?position=…`, `/plans` con clave por usuario).
* Aplicar los mismos cambios a `melodya_web` (Next): el bug del refresh de 2 min y el cierre de sesión por 429 existen allí.
