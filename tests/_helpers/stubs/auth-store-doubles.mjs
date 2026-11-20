// Dobles para probar el store de sesión (src/stores/auth.ts). Un solo módulo con las exportaciones de todas las dependencias
// sustituidas (el loader las resuelve a este archivo con distintos `?query` y Node las trata como módulos separados, así que
// el estado compartido vive en globalThis.__authDoubles).
const shared = (globalThis.__authDoubles ??= { calls: [], navigations: [], changeResult: null, resets: 0, bound: null });

export const authApi = {
  changePassword: async (body) => {
    shared.calls.push({ fn: 'changePassword', body });
    return shared.changeResult;
  },
  login: async () => { throw new Error('no usado'); },
  register: async () => { throw new Error('no usado'); },
  logout: async () => ({ ok: true }),
  logoutAll: async () => ({ ok: true }),
};
export const profileApi = { me: async () => (shared.meImpl ? shared.meImpl() : { id: 'u1', name: 'Ana' }) };

export const bindAuthCallbacks = (cbs) => { shared.bound = cbs; };
export const clientRefresh = async () => {
  shared.refreshCalls = (shared.refreshCalls ?? 0) + 1;
  return shared.refreshImpl ? shared.refreshImpl() : 'refrescado';
};

export const navigate = (to) => { shared.navigations.push(to); };

export const resetUserSessionState = async () => { shared.resets += 1; };

export { shared };
