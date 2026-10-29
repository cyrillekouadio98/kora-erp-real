import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';

/** Toutes les erreurs sortent au format { error: { code, message, details } }, sans fuite d'informations internes. */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Erreur');
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse() as any;
      if (body?.error?.code) return res.status(status).json(body);
      const code = status === 404 ? 'not_found' : status === 429 ? 'too_many_requests' : status === 401 ? 'unauthenticated' : 'http_error';
      const message = status === 429 ? 'Trop de tentatives. Réessayez dans quelques minutes.' : status === 404 ? 'Ressource introuvable.' : (typeof body === 'string' ? body : body?.message ?? 'Erreur');
      return res.status(status).json({ error: { code, message } });
    }
    const pg = exception as { code?: string; message?: string };
    if (pg?.code === '42501') {
      this.logger.warn(`Accès refusé par la base : ${pg.message}`);
      // Refus de la RLS : on répond comme si la ressource n'existait pas.
      return res.status(HttpStatus.NOT_FOUND).json({ error: { code: 'not_found', message: 'Ressource introuvable.' } });
    }
    this.logger.error((exception as Error)?.stack ?? String(exception));
    return res.status(500).json({ error: { code: 'internal_error', message: 'Une erreur inattendue est survenue. Réessayez ou contactez le support.' } });
  }
}
