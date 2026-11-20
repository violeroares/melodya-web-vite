/**
 * Entorno de pruebas AISLADO: Vite en el puerto 3100 apuntando a un backend simulado local (127.0.0.1:4010).
 *
 *   node scripts/dev-mock.mjs        (o: npm run dev:mock)
 *
 * No modifica `.env` ni `vite.config.ts`: la URL del API se inyecta SOLO en el entorno de este proceso (las variables de proceso tienen
 * prioridad sobre los archivos .env en Vite) y el puerto se pasa en línea. Tu configuración normal (puerto 3000 + api-dev) no cambia.
 * Control del mock en caliente: POST http://127.0.0.1:4010/__ctl · contadores: GET http://127.0.0.1:4010/__stats
 */
import { createServer } from 'vite';
import { startMockApi } from './mock-api.mjs';

const mock = await startMockApi({ port: Number(process.env.MOCK_PORT || 4010) });
process.env.VITE_API_BASE_URL = mock.apiBase;
process.env.OG_API_BASE_URL = mock.apiBase;

const server = await createServer({ server: { port: Number(process.env.MOCK_WEB_PORT || 3100), strictPort: true } });
await server.listen();
console.log(`web (aislada) → ${server.resolvedUrls?.local?.[0] ?? 'http://localhost:3100/'}   ·   mock API → ${mock.apiBase}   ·   control → ${mock.origin}/__ctl`);
