const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_PROFILE_DATA_URL_LENGTH = 280_000;
const AVATAR_SIZE = 320;
const MAX_OUTPUT_BYTES = 190_000;
const ACCEPTED_PROFILE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export function validateProfileImageMetadata(file: Pick<File, 'type' | 'size'> | null | undefined) {
  if (!file || !ACCEPTED_PROFILE_TYPES.has(String(file.type || '').toLowerCase())) {
    throw new Error('Selecciona una imagen PNG, JPEG o WebP.');
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    throw new Error('The image is empty or cannot be read.');
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new Error('The image cannot be larger than 8 MB.');
  }
}

export function normalizeProfilePhoto(value: unknown) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (
    normalized.length > MAX_PROFILE_DATA_URL_LENGTH
    || !/^data:image\/(?:webp|jpeg|png);base64,/i.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

/** The centred square of the source image to draw, in source pixels. */
export function squareSource(naturalWidth: number, naturalHeight: number) {
  const side = Math.min(naturalWidth, naturalHeight);
  return { x: (naturalWidth - side) / 2, y: (naturalHeight - side) / 2, size: side };
}

function loadImage(objectUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('This image could not be processed.'));
    image.src = objectUrl;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string | ArrayBuffer | null>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('The processed image could not be read.'));
    reader.readAsDataURL(blob);
  });
}

export async function prepareProfileImage(file: File) {
  validateProfileImageMetadata(file);

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadImage(objectUrl);
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    if (!Number.isFinite(side) || side <= 0) {
      throw new Error('The image does not have valid dimensions.');
    }
    const source = squareSource(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;

    const context = canvas.getContext('2d');
    if (!context) throw new Error('El navegador no pudo preparar la imagen.');
    context.fillStyle = '#111018';
    context.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(
      image,
      source.x,
      source.y,
      source.size,
      source.size,
      0,
      0,
      AVATAR_SIZE,
      AVATAR_SIZE,
    );

    const attempts: Array<[string, number]> = [
      ['image/webp', 0.84],
      ['image/webp', 0.7],
      ['image/jpeg', 0.76],
      ['image/jpeg', 0.62],
    ];

    for (const [type, quality] of attempts) {
      const blob = await canvasToBlob(canvas, type, quality);
      if (!blob || blob.size > MAX_OUTPUT_BYTES) continue;
      const dataUrl = await blobToDataUrl(blob);
      const normalized = normalizeProfilePhoto(dataUrl);
      if (normalized) return normalized;
    }

    throw new Error('The image is still too large. Try another one.');
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
