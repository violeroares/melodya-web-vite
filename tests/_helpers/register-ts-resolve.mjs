// Importar ANTES de cargar módulos .ts que importan a sus vecinos sin extensión.
import { register } from 'node:module';

register('./ts-resolve-hooks.mjs', import.meta.url);
