// Doble de lib/api para el reproductor: solo `songsApi.registerPlay`. Cada llamada queda en `registerPlayCalls`.
export const registerPlayCalls = [];
export const songsApi = {
  registerPlay: (id) => {
    registerPlayCalls.push(id);
    return Promise.resolve({ playsCount: registerPlayCalls.length });
  },
};
