const UTF8_CHUNK_BYTES = 0x8000;

function encodeUtf8(value: string | undefined) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += UTF8_CHUNK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + UTF8_CHUNK_BYTES));
  }
  return binary;
}

function decodeUtf8(value: string) {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

export function encodeBase64Url(value: string) {
  const binary = encodeUtf8(value);
  const buffer = (globalThis as typeof globalThis & { Buffer?: { from(value: string, encoding: string): { toString(encoding: string): string } } }).Buffer;
  const base64 = typeof btoa === 'function'
    ? btoa(binary)
    : buffer
      ? buffer.from(binary, 'binary').toString('base64')
      : '';
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function decodeBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return '';
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  try {
    const buffer = (globalThis as typeof globalThis & { Buffer?: { from(value: string, encoding: string): { toString(encoding: string): string } } }).Buffer;
    const binary = typeof atob === 'function'
      ? atob(padded)
      : buffer
        ? buffer.from(padded, 'base64').toString('binary')
        : '';
    return binary ? decodeUtf8(binary) : '';
  } catch {
    return '';
  }
}
