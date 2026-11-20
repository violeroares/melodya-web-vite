# Enlaces compartibles y apps nativas (Android App Links / iOS Universal Links)

> **Estado:** el contrato de URLs de la web está implementado y probado. La integración con las apps **no está hecha ni verificada**:
> requiere datos reales de las apps (package name, huella SHA-256 del certificado, Team ID, Bundle ID) que **no se inventaron**,
> un dominio HTTPS de producción y pruebas en dispositivos. No se modificó ninguna app móvil.

## Contrato de URLs (único, centralizado en `src/lib/links.ts`)

| Contenido | URL | Público | Notas |
|---|---|---|---|
| Canción | `https://app.melodya.com.ar/songs/:id` | sí (si la canción es pública) | metadatos OG dinámicos |
| Creador | `https://app.melodya.com.ar/user/:id` | sí | metadatos OG dinámicos |
| Radio de la comunidad | `/community?radio=<sort>[&genre=<g>]` | sí | |
| Recuperar contraseña | `/reset-password#token=<token>` | sí | token en el **fragmento** |
| Resto (`/create`, `/library/*`, `/profile/*`, `/notifications`, `/plans`, `/community`) | rutas limpias | según ruta | |

El origen sale de `VITE_PUBLIC_ORIGIN` (en producción `https://app.melodya.com.ar`; vacío en desarrollo = origen actual). Ningún
componente incrusta el dominio de producción (hay una prueba que lo verifica).

### Formato del enlace de recuperación (decisión)

`/reset-password#token=…` (fragmento) en lugar de `?token=…`:

* el fragmento **no viaja al servidor** ni en el `Referer` (no queda en logs de acceso, proxies ni analíticas);
* Android (`Intent.data`) e iOS (`NSUserActivity.webpageURL`) **conservan el fragmento** al abrir la app;
* la web también acepta `?token=` en la query.

**Pendiente en el backend (no modificado):** hoy `email-outbox.service.js` arma `${WEB_URL}/#/reset-password?token=…` (formato de la web
con hash). La web Vite lo traduce al cargar (`migrateLegacyResetLink`, única compatibilidad con `#/`) para que los correos ya
enviados sigan funcionando. Para que Android/iOS puedan interceptarlo con App Links/Universal Links, el backend debería emitir
`${WEB_URL}/reset-password#token=…` y `WEB_URL` apuntar al dominio de esta web. Cuando eso ocurra se elimina el shim.

## Android App Links (a hacer por el equipo Android)

1. Servir por **HTTPS, sin redirecciones** `https://app.melodya.com.ar/.well-known/assetlinks.json` (`Content-Type: application/json`):
   ```json
   [{ "relation": ["delegate_permission/common.handle_all_urls"],
      "target": { "namespace": "android_app", "package_name": "<PACKAGE_NAME_REAL>",
                  "sha256_cert_fingerprints": ["<SHA256_REAL_DEL_CERTIFICADO_DE_FIRMA>"] } }]
   ```
   (incluir la huella de **release** y, si se prueba con firma de Play App Signing, la de Google.)
2. En el `AndroidManifest.xml`, un `intent-filter` con `android:autoVerify="true"`, `ACTION_VIEW`, categorías `DEFAULT` y `BROWSABLE`,
   `scheme="https"`, `host="app.melodya.com.ar"` y `pathPrefix` para `/songs`, `/user` y `/reset-password`.
3. Verificar con `adb shell pm get-app-links <package>` y con la API *Digital Asset Links* de Google.

## iOS Universal Links (a hacer por el equipo iOS)

1. Servir `https://app.melodya.com.ar/.well-known/apple-app-site-association` (**sin extensión**, `application/json`, sin redirecciones):
   ```json
   { "applinks": { "details": [ { "appIDs": ["<TEAM_ID_REAL>.<BUNDLE_ID_REAL>"],
       "components": [ { "/": "/songs/*" }, { "/": "/user/*" }, { "/": "/reset-password" } ] } ] } }
   ```
2. Entitlement *Associated Domains*: `applinks:app.melodya.com.ar`.
3. Manejar `application(_:continue:restorationHandler:)` / `onOpenURL` con `NSUserActivityTypeBrowsingWeb` y leer el fragmento para el token.
4. Probar con `swcutil` / Notes (los Universal Links no se activan si se pegan en Safari; hay que tocarlos desde otra app).

## Cómo los sirve esta web

Los archivos van en `public/.well-known/` (Vite los copia a `dist/.well-known/`). `server/server.mjs` los entrega estáticos, sin
redirecciones, y fuerza `application/json` para `apple-app-site-association`. **Este repo no incluye esos archivos** porque
requieren valores reales de las apps.

## Comportamiento esperado (a verificar con las apps reales)

| Situación | Resultado esperado |
|---|---|
| App instalada y dominio verificado | el enlace abre la app en la canción / creador / pantalla de contraseña |
| App no instalada | se abre la web (con la vista previa OG correcta al compartirse) |
| Sesión | la web y las apps **no comparten sesión** (cada una usa sus tokens del backend); el enlace público no la requiere |
| Enlace de recuperación | el token viaja en el fragmento; la app lo envía al mismo endpoint `POST /auth/reset-password` |
