function encodeUtf8(value: string|undefined) {
  const bytes = new TextEncoder().encode(value);
  return String.fromCharCode(...bytes);
}

function decodeUtf8(value: string) {
  const bytes = Uint8Array.from(value, character => character.charCodeAt(0));
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
