import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import { config } from './config';

/** Refuse les requêtes d'écriture venant d'une autre origine que l'interface (protection CSRF en plus de SameSite). */
function originCheck(req: Request, res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path.startsWith('/webhooks/')) return next();
  const origin = req.headers.origin;
  if (origin && origin !== config.webUrl && origin !== `http://localhost:${config.port}`) {
    return res.status(403).json({ error: { code: 'bad_origin', message: 'Origine de la requête non autorisée.' } });
  }
  next();
}

function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (config.isProd) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

export function buildOpenApi(app: INestApplication) {
  const doc = new DocumentBuilder().setTitle('Kora ERP — API').setDescription('API du socle SaaS multi-entreprises').setVersion('0.1.0').addCookieAuth(config.session.cookieName).build();
  return SwaggerModule.createDocument(app, doc);
}

export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { rawBody: true, logger: config.env === 'test' ? ['error'] : undefined });
  const express = app.getHttpAdapter().getInstance();
  express.disable('x-powered-by');
  express.set('trust proxy', 1);
  app.use(securityHeaders, cookieParser(), originCheck);
  app.enableCors({ origin: config.webUrl, credentials: true });
  app.enableShutdownHooks();
  return app;
}
