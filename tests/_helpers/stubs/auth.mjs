// Doble de stores/auth: solo lo que usa el reproductor. `authState.accessToken` lo controla cada prueba.
export const authState = { accessToken: null };
export const useAuthStore = { getState: () => authState };
export const getAccessTokenSync = () => authState.accessToken;
