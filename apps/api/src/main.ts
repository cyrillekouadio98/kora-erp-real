import 'reflect-metadata';
import '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { buildOpenApi, createApp } from './bootstrap';
import { config } from './config';

async function main() {
  const app = await createApp();
  if (!config.isProd) SwaggerModule.setup('docs', app, buildOpenApi(app));
  await app.listen(config.port);
  console.log(`API Kora ERP prête sur le port ${config.port}${config.isProd ? '' : ' (documentation : /docs)'}`);
}
main();
