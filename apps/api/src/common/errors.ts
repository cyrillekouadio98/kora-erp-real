import { HttpException, HttpStatus } from '@nestjs/common';

/** Erreur métier au format { error: { code, message, details } }. */
export class AppError extends HttpException {
  constructor(status: HttpStatus, public readonly code: string, message: string, public readonly details?: unknown) {
    super({ error: { code, message, details } }, status);
  }
}
export const notFound = (what = 'Ressource') => new AppError(HttpStatus.NOT_FOUND, 'not_found', `${what} introuvable.`);
export const forbidden = (message = "Vous n'avez pas l'autorisation d'effectuer cette action.", code = 'forbidden') =>
  new AppError(HttpStatus.FORBIDDEN, code, message);
export const badRequest = (message: string, details?: unknown, code = 'invalid_request') =>
  new AppError(HttpStatus.BAD_REQUEST, code, message, details);
export const conflict = (message: string, code = 'conflict') => new AppError(HttpStatus.CONFLICT, code, message);
export const unauthorized = (message = 'Connexion requise.', code = 'unauthenticated') =>
  new AppError(HttpStatus.UNAUTHORIZED, code, message);
export const paymentRequired = (message: string, code: string, details?: unknown) =>
  new AppError(HttpStatus.PAYMENT_REQUIRED, code, message, details);
export const locked = (message: string, code: string) => new AppError(HttpStatus.LOCKED, code, message);
