import 'reflect-metadata';
import { SwaggerModule } from '@nestjs/swagger';
import { buildOpenApi, createApp } from './bootstrap';
import { config } from './config';

async function main() {
  const app = await createApp();
  if (!config.isProd) SwaggerModule.setup('docs', app, buildOpenApi(app));
  await app.listen(config.port);
  console.log(`API Kora ERP prête sur http://localhost:${config.port} (documentation : /docs)`);
}
main();
