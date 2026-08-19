const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_PROFILE_DATA_URL_LENGTH = 280_000;
const AVATAR_SIZE = 320;
const MAX_OUTPUT_BYTES = 190_000;
const ACCEPTED_PROFILE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/**
 * The public profile photo (F1) has a much tighter budget than the private
 * one: it rides in `userProfiles/{uid}`, which is read on every profile visit,
 * so it is recompressed smaller rather than reused as-is.
 */
export const PUBLIC_AVATAR_PRESET = Object.freeze({
  size: 192,
  maxDataUrlLength: 60_000,
  maxOutputBytes: 42_000,
});

export function validateProfileImageMetadata(file) {
  if (!file || !ACCEPTED_PROFILE_TYPES.has(String(file.type || '').toLowerCase())) {
    throw new Error('Selecciona una imagen PNG, JPEG o WebP.');
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    throw new Error('La imagen está vacía o no se puede leer.');
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new Error('La imagen no puede superar los 8 MB.');
  }
}

export function normalizeProfilePhoto(value, maxLength = MAX_PROFILE_DATA_URL_LENGTH) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (
    normalized.length > maxLength
    || !/^data:image\/(?:webp|jpeg|png);base64,/i.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function loadImage(objectUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('No se pudo procesar esta imagen.'));
    image.src = objectUrl;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('No se pudo leer la imagen procesada.'));
    reader.readAsDataURL(blob);
  });
}

export async function prepareProfileImage(file, options = {}) {
  validateProfileImageMetadata(file);

  const avatarSize = options.size || AVATAR_SIZE;
  const maxOutputBytes = options.maxOutputBytes || MAX_OUTPUT_BYTES;
  const maxDataUrlLength = options.maxDataUrlLength || MAX_PROFILE_DATA_URL_LENGTH;

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadImage(objectUrl);
    const sourceSize = Math.min(image.naturalWidth, image.naturalHeight);
    if (!Number.isFinite(sourceSize) || sourceSize <= 0) {
      throw new Error('La imagen no tiene unas dimensiones válidas.');
    }
    const sourceX = (image.naturalWidth - sourceSize) / 2;
    const sourceY = (image.naturalHeight - sourceSize) / 2;
    const canvas = document.createElement('canvas');
    canvas.width = avatarSize;
    canvas.height = avatarSize;

    const context = canvas.getContext('2d');
    if (!context) throw new Error('El navegador no pudo preparar la imagen.');
    context.fillStyle = '#111018';
    context.fillRect(0, 0, avatarSize, avatarSize);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(
      image,
      sourceX,
      sourceY,
      sourceSize,
      sourceSize,
      0,
      0,
      avatarSize,
      avatarSize,
    );

    const attempts = [
      ['image/webp', 0.84],
      ['image/webp', 0.7],
      ['image/jpeg', 0.76],
      ['image/jpeg', 0.62],
      // Extra rungs for the tighter public budget; harmless for the private
      // one, which never reaches them.
      ['image/webp', 0.55],
      ['image/jpeg', 0.48],
    ];

    for (const [type, quality] of attempts) {
      const blob = await canvasToBlob(canvas, type, quality);
      if (!blob || blob.size > maxOutputBytes) continue;
      const dataUrl = await blobToDataUrl(blob);
      const normalized = normalizeProfilePhoto(dataUrl, maxDataUrlLength);
      if (normalized) return normalized;
    }

    throw new Error('La imagen sigue siendo demasiado grande. Prueba con otra.');
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
