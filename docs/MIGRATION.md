# Migración Next.js → Vite: inventario, dependencias, diferencias y pendientes

Origen: `melodya_web` v0.28.0 (Next 16, **una sola ruta** `app/page.tsx` con router propio por hash). El código existente es la fuente de verdad.

## 1. Qué se migró

Se copiaron `src/` (178 archivos), `public/` y `tests/` y se adaptó solo lo específico del framework:

| Área | Next (original) | Vite (nuevo) |
|---|---|---|
| Entrada | `app/layout.tsx` + `app/page.tsx` | `index.html` + `src/main.tsx` + `src/routes.tsx` |
| Enrutado | router propio por hash (`/#/songs/1`) | React Router, URLs limpias (`/songs/1`), vistas `lazy` |
| Fuentes | `next/font/google` | `@fontsource/*` (autoalojadas; mismas variables CSS) |
| Tema | `next-themes` | `src/lib/theme.tsx` (misma API, sin parpadeo) |
| Variable de entorno | `NEXT_PUBLIC_API_BASE_URL` | `VITE_API_BASE_URL` |
| Metadatos | `export const metadata` (estáticos) | `index.html` + servidor OG para `/songs/:id` y `/user/:id` |
| Tailwind | `@tailwindcss/postcss` | `@tailwindcss/vite` |
| Compartir | `${origin}/#/songs/:id` | `songUrl(id)` → `{origen}/songs/:id` (`src/lib/links.ts`) |
| Reset de contraseña | token en `#/reset-password?token=` | `/reset-password#token=` (+ acepta `?token=` y traduce el enlace actual del backend) |
| TypeScript | `ignoreBuildErrors: true` | `tsc -b` estricto sin errores |
| Salida | `output: "standalone"` | `dist/` estático + `server/server.mjs` (OG) |

Sin cambios (reutilizados tal cual): stores (auth, player, upgrade-prompt), `lib/api/*`, hooks, toda la UI (`components/`, `features/`), estilos
y los contratos con el backend (Axios + Bearer + refresh único en vuelo, Socket.IO, streaming/descarga de audio, subidas).

## 2. Dependencias

1. **Reutilizadas directamente:** `react`, `react-dom`, todos los `@radix-ui/*`, `@tanstack/react-query`, `zustand`, `axios`, `react-hook-form`, `socket.io-client`,
   `recharts`, `sonner`, `lucide-react`, `cmdk`, `vaul`, `embla-carousel-react`, `input-otp`, `react-day-picker`, `react-resizable-panels`, `class-variance-authority`,
   `clsx`, `tailwind-merge`, `tw-animate-css`, `tailwindcss`, `typescript`, `eslint`.
2. **Con adaptación:** `@tailwindcss/postcss` → `@tailwindcss/vite`; `next/font` → `@fontsource/{figtree,bricolage-grotesque,geist-mono}`; `next-themes` → `lib/theme.tsx`;
   router por hash → `react-router-dom`.
3. **Específicas de Next, eliminadas:** `next`, `next-auth`, `next-intl`, `next-themes`, `eslint-config-next`, `sharp` (solo para `next/image`), `bun-types`, `next.config.ts`, `next-env.d.ts`, el proxy `BO_PROXY` al backoffice (solo sandbox).
4. **No utilizadas por el código (tampoco en la web Next), no copiadas:** `@dnd-kit/*`, `@hookform/resolvers`, `@mdxeditor/editor`, `@reactuses/core`, `@tanstack/react-table`, `date-fns` (la usa `react-day-picker` internamente),
   `framer-motion`, `react-markdown`, `react-syntax-highlighter`, `tailwindcss-animate`, `uuid`. (`scripts/unused-deps.mjs` lo comprueba.) Si se planean usar, se agregan al implementarlas.
5. **Nuevas:** `vite`, `@vitejs/plugin-react`, `@tailwindcss/vite`, `react-router-dom`, `@fontsource/*`, `typescript-eslint`, `eslint-plugin-react-hooks@7`, `globals`, `@types/node`.

Total: 50 dependencias + 14 de desarrollo (original: 64 + 9).

## 3. Diferencias de comportamiento a tener presentes

* **URLs con hash ya no existen.** Los enlaces `/#/songs/…` compartidos antes **no** abren la canción en esta web (decisión pedida). Única excepción: `/#/reset-password?token=…` (el correo actual del backend), que se traduce al cargar.
* **Producción necesita un proceso Node** si se quiere Open Graph (o un proxy que haga lo mismo). Solo estático ⇒ sin vistas previas dinámicas.
* **404 HTTP:** el servidor responde 200 con la SPA para cualquier ruta (y la SPA pinta su 404), igual que Next con una sola ruta.
* **Sin SSR del contenido:** el HTML inicial solo trae metadatos; la UI se pinta en el cliente (igual que antes: la app ya era 100 % cliente).
* La aplicación **no** usa `StrictMode` (igual que el original, `reactStrictMode: false`).

## 4. Pendiente / no verificado (no declarar equivalencia completa)

**Verificado en navegador** (dev y build de producción, contra un backend **simulado**): carga y recarga en rutas profundas, Atrás/Adelante, 404, rutas privadas (aviso a invitados y render con sesión),
redirección de rutas legacy en español, tres formatos de enlace de recuperación (incluyendo pegar el fragmento con la pantalla ya abierta), reproductor persistente (mismo `<audio>`, posición y
volumen conservados entre rutas, con rutas `lazy`), tema claro/oscuro persistente, diseño móvil sin scroll horizontal, creación/biblioteca/perfil/notificaciones renderizan.

**No verificado (requiere backend real o dispositivos):**
* Flujos con datos reales: login/registro/refresh reales, generación de música (formulario completo, letras, voces, referencias de audio, remix, «otra versión», reintentos, borradores y recuperación),
  biblioteca (CRUD, playlists/proyectos, papelera, versiones), descargas MP3/WAV, comentarios/likes/seguir, suscripciones y pagos, subida de archivos y grabación de voz.
  La **lógica** de estos flujos está cubierta por las 777 pruebas heredadas (todas pasan), pero **no se ejecutó de punta a punta**.
* Socket.IO real (una sola conexión por `useRealtime` en el shell persistente: es la estructura, no se midió contra el backend).
* Comparación visual píxel a píxel y de rendimiento con la web Next (no se compilaron ni ejecutaron lado a lado; solo se reutilizó el mismo CSS/componentes).
* Open Graph en WhatsApp real y App Links / Universal Links (ver `README.md` y `MOBILE-LINKS.md`).
* CORS del backend para `http://localhost:3100` (no se tocó el backend).

**Heredado, no corregido:** con una respuesta de `GET /songs/:id` de forma inesperada la vista de detalle cae al *ErrorBoundary* (comportamiento original).
