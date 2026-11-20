// Extensión del archivo descargado según el Content-Type (src/lib/audio-download.ts) y su uso en las dos descargas.
// Ejecutar: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { audioFileExtension } = await import('../src/lib/audio-download.ts');

test('audio/mpeg → .mp3 (con parámetros y mayúsculas)', () => {
  assert.equal(audioFileExtension('audio/mpeg'), '.mp3');
  assert.equal(audioFileExtension('Audio/MPEG; charset=binary'), '.mp3');
});

test('audio/wav, audio/wave y audio/x-wav → .wav', () => {
  for (const mime of ['audio/wav', 'audio/wave', 'audio/x-wav', ' audio/wav ; foo=bar']) {
    assert.equal(audioFileExtension(mime), '.wav', mime);
  }
});

test('Content-Type ausente o inesperado: sin extensión (no se asume ningún formato)', () => {
  for (const mime of [null, undefined, '', 'application/octet-stream', 'text/html', 'application/json', 'audio/ogg']) {
    assert.equal(audioFileExtension(mime), '', String(mime));
  }
});

// E6: la descarga explícita usa POST /songs/:id/versions/:versionId/download (src/lib/song-download.ts). Los dos componentes ya no
// descargan por la ruta de reproducción: así la reproducción no consume cupo y la descarga sí.
const songDownload = fs.readFileSync(new URL('../src/lib/song-download.ts', import.meta.url), 'utf8');

for (const [label, file] of [['SongDetailView', '../src/features/song/SongDetailView.tsx'], ['ExpandedPlayer', '../src/components/player/ExpandedPlayer.tsx']]) {
  test(`${label}: «Descargar» usa el endpoint de descarga explícita y NO la ruta de reproducción, y no promete WAV`, () => {
    const src = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(src, /downloadSongAudio\(/);
    assert.match(src, /useDownloadState\(\)/, 'respeta capacidad y cupo');
    assert.doesNotMatch(src, /await fetch\(/, 'ya no baja el audio con un fetch a la URL de reproducción');
    assert.doesNotMatch(src, /\}\.wav`/, 'sin ".wav" fijo en el nombre');
    assert.doesNotMatch(src, /Descargar WAV|\(\.wav\)/);
  });
}

test('song-download: POST a /download con el formato pedido (MP3 por omisión, WAV si se pide), con clientRequestId, y la extensión sale del Content-Type', () => {
  assert.match(songDownload, /\/songs\/\$\{encodeURIComponent\(songId\)\}\/versions\/\$\{encodeURIComponent\(version\)\}\/download/);
  assert.match(songDownload, /method: 'POST'/);
  assert.match(songDownload, /format = 'mp3'/, 'MP3 es el formato por omisión: las descargas existentes no cambian');
  assert.ok(songDownload.includes('JSON.stringify({ format, clientRequestId })'));
  assert.ok(songDownload.includes('const slot = `${songId}|${version}|${format}`'), 'la clave de reintento es por versión Y formato');
  assert.match(songDownload, /downloadFilename\(title, res\.headers\.get\('Content-Type'\)\)/);
  assert.doesNotMatch(songDownload, /\}\.wav`/);
});

test('song-download: un error HTTP aborta antes de crear el archivo y conserva el detalle del servidor', () => {
  const body = songDownload.slice(songDownload.indexOf('await fetch('));
  assert.ok(body.indexOf('!res.ok') > -1 && body.indexOf('!res.ok') < body.indexOf('res.blob()'));
  assert.match(songDownload, /downloadApiError\(res\.status, json\)/);
});

test('song-download: la clave del intento se reusa si el intento falla y se descarta al terminar bien (el reintento no consume otra unidad)', () => {
  assert.match(songDownload, /pendingKeys\.get\(slot\) \?\? newKey\(\)/);
  assert.match(songDownload, /pendingKeys\.delete\(slot\)/);
  // un corte de red NO descarta la clave
  const network = songDownload.slice(songDownload.indexOf('} catch {'), songDownload.indexOf('if (!res.ok)'));
  assert.doesNotMatch(network, /pendingKeys\.delete/);
});
