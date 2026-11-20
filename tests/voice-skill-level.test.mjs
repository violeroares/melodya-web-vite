// Nivel de experiencia vocal del asistente de clonación (paso «Detalles»): opciones, cuerpo de `verify` y «Omitir».
//  • Lógica pura (src/features/voice/voice-session-flow.ts): se prueba el comportamiento.
//  • Un chequeo ESTRUCTURAL sobre VoiceCloneDialog.tsx: el repo no tiene jsdom ni testing-library, así que no se monta React;
//    solo asegura que el diálogo usa esas funciones y no vuelve a armar el cuerpo a mano.
// Ejecutar: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildVerifyBody, SKILL_CHOICES, SKILL_SKIP_NOTE } from '../src/features/voice/voice-session-flow.ts';

const base = { sampleId: 'smp-12345', name: ' Mi voz ', description: ' ', tagsInput: 'pop, , balada' };

test('cada nivel viaja con el valor exacto del enum de Melodya (el backend lo pasa a minúsculas para Suno)', () => {
  for (const level of ['BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'PROFESSIONAL']) {
    const body = buildVerifyBody({ ...base, skill: level });
    assert.equal(body.singerSkillLevel, level, level);
  }
});

test('«Omitir» (valor vacío): la propiedad singerSkillLevel NO existe y no se reemplaza por ningún nivel', () => {
  const body = buildVerifyBody({ ...base, skill: '' });
  assert.equal('singerSkillLevel' in body, false);
  assert.doesNotMatch(JSON.stringify(body), /beginner|intermediate|advanced|professional/i);
});

test('el resto del cuerpo no cambia con el nivel: nombre recortado, descripción vacía omitida, etiquetas limpias', () => {
  const body = buildVerifyBody({ ...base, skill: 'ADVANCED' });
  assert.deepEqual(body, { sampleId: 'smp-12345', name: 'Mi voz', style: 'pop, balada', singerSkillLevel: 'ADVANCED' });
  const skipped = buildVerifyBody({ ...base, skill: '' });
  assert.deepEqual(skipped, { sampleId: 'smp-12345', name: 'Mi voz', style: 'pop, balada' });
});

test('límites existentes intactos: nombre ≤100, descripción ≤500, hasta 8 etiquetas', () => {
  const body = buildVerifyBody({
    sampleId: 's', name: 'n'.repeat(150), description: 'd'.repeat(600), tagsInput: Array.from({ length: 12 }, (_, i) => `t${i}`).join(','), skill: '',
  });
  assert.equal(body.name.length, 100);
  assert.equal(body.description.length, 500);
  assert.equal(body.style.split(', ').length, 8);
});

test('las cinco opciones: textos aprobados, cuatro niveles y «Omitir» con valor vacío', () => {
  assert.deepEqual(
    SKILL_CHOICES.map((o) => [o.value, o.title, o.hint]),
    [
      ['BEGINNER', 'Principiante', 'Todavía estoy encontrando mi voz'],
      ['INTERMEDIATE', 'Intermedio', 'Puedo cantar afinado'],
      ['ADVANCED', 'Avanzado', 'La gente lo nota'],
      ['PROFESSIONAL', 'Profesional', 'Me dedico a esto'],
      ['', 'Omitir', 'No indicar nivel de experiencia'],
    ],
  );
});

test('el aviso de «Omitir» es prudente: dice lo que Melodya hace y no promete nada sobre Suno', () => {
  assert.equal(SKILL_SKIP_NOTE, 'Si omitís esta pregunta, no enviaremos un nivel de experiencia. Melodya puede aplicar su valor predeterminado.');
  assert.doesNotMatch(SKILL_SKIP_NOTE, /garantiz|sin nivel|ningún nivel/i);
});

test('estructura: el diálogo usa buildVerifyBody y SKILL_CHOICES (no arma el cuerpo ni las opciones a mano)', () => {
  const src = readFileSync(new URL('../src/features/voice/VoiceCloneDialog.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /voiceSessionsApi\.verify\(session\.id, buildVerifyBody\(/);
  assert.match(src, /SKILL_CHOICES\.map\(/);
  assert.doesNotMatch(src, /singerSkillLevel: skill/, 'el cuerpo se arma solo en buildVerifyBody');
  assert.doesNotMatch(src, /SKILL_OPTIONS/, 'las opciones viejas ya no existen');
  assert.match(src, /\{SKILL_SKIP_NOTE\}/);
});
