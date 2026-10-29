import { z, ZodTypeAny } from 'zod';
import { badRequest } from './errors';

/** Valide une entrée avec zod ; renvoie une erreur 400 détaillée en français. */
export function parse<T extends ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input ?? {});
  if (!r.success) {
    throw badRequest('Certaines informations sont invalides.', r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
  }
  return r.data;
}

export const uuidParam = z.string().uuid({ message: 'Identifiant invalide' });
export const email = z.string().trim().toLowerCase().email({ message: 'Adresse e-mail invalide' });
export const password = z.string().min(10, { message: 'Le mot de passe doit contenir au moins 10 caractères' }).max(200);
