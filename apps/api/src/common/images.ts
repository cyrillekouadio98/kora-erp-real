import { badRequest } from './errors';

/** Vignette envoyée en data URL (déjà réduite par le navigateur) : JPEG, PNG ou WebP, 300 Ko au plus. */
export function parseImage(dataUrl: string) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw badRequest('Image non reconnue : utilisez une photo JPEG, PNG ou WebP.', undefined, 'invalid_photo');
  const data = Buffer.from(m[2], 'base64');
  if (data.length > 300_000) throw badRequest('Photo trop lourde.', undefined, 'photo_too_large');
  return { mime: m[1], data };
}
