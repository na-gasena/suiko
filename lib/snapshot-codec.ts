const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function snapshotBytes(snapshot: unknown): number {
  return encoder.encode(JSON.stringify(snapshot)).byteLength;
}

export async function compressSnapshot(snapshot: unknown): Promise<string | null> {
  if (typeof CompressionStream === 'undefined') return null;
  const source = encoder.encode(JSON.stringify(snapshot));
  const compressed = await new Response(
    new Blob([source]).stream().pipeThrough(new CompressionStream('gzip')),
  ).arrayBuffer();
  const bytes = new Uint8Array(compressed);
  let base64 = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    base64 += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(base64);
}

export async function decompressSnapshot<T>(payload: string): Promise<T> {
  if (typeof DecompressionStream === 'undefined')
    throw new Error('圧縮された上演データを読めません。ブラウザを更新してください。');
  const binary = atob(payload);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const decompressed = await new Response(
    new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')),
  ).arrayBuffer();
  return JSON.parse(decoder.decode(decompressed)) as T;
}
