# Melodya Web — versión React + Vite + TypeScript (experimental)

Réplica de `melodya_web` (Next.js) con **React 19 + Vite 7 + TypeScript + React Router (BrowserRouter / data router)** y Tailwind 4.
Sirve para comparar ambas arquitecturas antes del lanzamiento público. **Sin Next.js** (ni `next`, `next-auth`, `next-intl`,
`next-themes`, `eslint-config-next`, `next/font|image|link|navigation`). Un test lo verifica.

Documentos: [`docs/MIGRATION.md`](docs/MIGRATION.md) (inventario, dependencias, diferencias, pendientes) ·
[`docs/MOBILE-LINKS.md`](docs/MOBILE-LINKS.md) (App Links / Universal Links).

## Iniciar

```bash
npm install
cp .env.example .env.local      # y ajustá VITE_API_BASE_URL (backend local o de pruebas, con /api)
npm run dev                     # http://localhost:3100  (puerto 3100, strictPort)
```

| Script | Qué hace |
|---|---|
| `npm run dev` | Vite en `:3100` (incluye Open Graph dinámico en `/songs/:id` y `/user/:id`) |
| `npm run build` | `tsc -b` (estricto) + `vite build` → `dist/` |
| `npm start` | `node server/server.mjs`: sirve `dist/` con URLs limpias **y Open Graph en el HTML inicial** |
| `npm run preview` | previsualiza `dist/` con Vite (también con OG) |
| `npm run lint` / `npm run typecheck` / `npm test` | ESLint · `tsc -b` · 788 pruebas `node:test` |

> En Windows, si esbuild falla con «Acceso denegado» al borrar su temporal, definí `TEMP`/`TMP` a una carpeta del proyecto (p. ej. `.tmp`, ya ignorada por git).

### Configuración para un backend de pruebas

| Variable | Dónde | Descripción |
|---|---|---|
| `VITE_API_BASE_URL` | navegador (obligatoria) | URL del backend **con `/api`**. Sin ella la app muestra la pantalla de configuración y no envía nada. Socket.IO usa el mismo origen. |
| `VITE_PUBLIC_ORIGIN` | navegador | Origen para enlaces compartibles. Vacío = origen actual. Producción: `https://app.melodya.com.ar`. |
| `OG_API_BASE_URL` | solo servidor | Backend que consulta el servidor OG (por defecto `VITE_API_BASE_URL`). |
| `OG_PUBLIC_ORIGIN` | solo servidor | Origen de `og:url`/canonical. **Definilo en producción** (si no se deduce del `Host`). |
| `PORT` | solo servidor | Puerto de `npm start` (3100). |

El backend debe permitir CORS desde `http://localhost:3100` (no se modificó ningún backend). No se incluyen secretos ni `.env` de otros proyectos.

`scripts/mock-api.mjs` es un backend **simulado solo para pruebas locales** (contratos públicos + un login ficticio + audio WAV de prueba).
No forma parte de la app.

## Arquitectura

```
index.html ── src/main.tsx ── (migra enlace legacy de reset) ── RouterProvider(router)
src/routes.tsx
└─ RootLayout  (se monta UNA vez)
   ├─ QueryClientProvider · ThemeProvider · Toaster · bootstrap de sesión (BootSplash)
   ├─ AppShell: Header · Sidebar/BottomNav · PlayerBar (<audio>) · Socket.IO (useRealtime) · avisos
   │    └─ ViewErrorBoundary → <Outlet/>     ← lo ÚNICO que cambia al navegar
   └─ useGenerationReconciliation · título del documento · scroll al navegar
```

* **Reproductor persistente:** el `<audio>`, la cola y el volumen viven en Zustand/`AppShell`, **fuera** del `<Outlet/>`. Las vistas se cargan con
  `lazy` del router: la navegación espera el chunk sin desmontar el shell. Un solo `useRealtime` ⇒ una sola conexión Socket.IO.
* **Fachada de router (`src/lib/router.tsx`):** conserva `useRoute / navigate / Link / matchPath / goBack` del código original; por eso los 35 archivos
  que navegan siguen usando la misma API sin reescribirse. `navigate()` funciona fuera de React (stores, handlers) vía el router registrado.
* **Rutas:** `/`, `/login`, `/register`, `/forgot-password`, `/reset-password`, `/create`, `/library[/*]`, `/songs/:id`, `/community`,
  `/user/:id`, `/plans`, `/notifications`, `/profile[/*]`, `*` (404). Privadas (`/create`, `/library`, `/notifications`, `/profile`) muestran el aviso de acceso a invitados, igual que Next.
  Sin `#`; no hay segundo router. Rutas antiguas en español con path limpio (`/ingresar`…) redirigen a su equivalente.
* **Enlaces:** `src/lib/links.ts` es el único lugar que arma `/songs/:id`, `/user/:id`, radio y reset (ver [`docs/MOBILE-LINKS.md`](docs/MOBILE-LINKS.md)).

## Open Graph dinámico

Una SPA entrega siempre el mismo HTML, y los crawlers no ejecutan JavaScript. Solución elegida (sin SSR de React, sin dependencias):
`server/og.mjs` consulta los endpoints **públicos** del backend (`GET /community/songs/:id`, `GET /community/users/:id`, ambos `optionalAuth`)
e **inyecta en el `index.html` inicial** `<title>`, `description`, `og:*`, `twitter:*` y `canonical`, con todo el contenido de usuarios escapado.
Lo usan `server/server.mjs` (producción) y un plugin de Vite (dev/preview). Caché en memoria 60 s, timeout 3 s, ids validados;
si la canción es privada/no existe/el backend cae, devuelve 200 con los metadatos genéricos de Melodya (la SPA decide qué mostrar al dueño).

**Por qué esta opción:** React Router *framework mode* (SSR) obligaría a reestructurar toda la app (loaders, módulos de ruta, SSR de stores y audio) para obtener
metadatos en solo dos rutas; este servidor de ~200 líneas lo resuelve sin tocar el código de la app.
Costo: la web en producción pasa a ser un proceso Node (no solo archivos estáticos) o, alternativamente, la misma lógica en un proxy/edge.

**Estado: verificado en HTML crudo** (pedido HTTP crudo con UA de WhatsApp/Facebook/Twitterbot contra el build de producción y contra un backend simulado). **No verificado** con
WhatsApp real: requiere dominio HTTPS público, y las portadas de producción deben ser accesibles (el backend ya sirve sin sesión las portadas de canciones públicas y avatares de autores públicos).
Un avatar de un creador sin canciones públicas no es público en el backend ⇒ la vista previa de ese perfil usaría el ícono de Melodya.

## Pruebas y calidad

`tsc -b` estricto (sin `ignoreBuildErrors`; `noImplicitAny` apagado como en el original), ESLint limpio (exenciones puntuales de `react-hooks/purity` en 4 lecturas de reloj, justificadas en línea) y 788 pruebas
(777 heredadas de Next —4 adaptadas a rutas/variables— + 11 nuevas de enlaces y OG).
