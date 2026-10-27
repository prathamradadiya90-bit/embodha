import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { existsSync } from 'node:fs';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { ENV } from './config/config.module';
import type { Env } from './config/env';

async function bootstrap() {
  if (existsSync('.env')) process.loadEnvFile('.env');
  // rawBody: webhook signatures are checked against the exact bytes received.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  configureApp(app);
  const env = app.get<Env>(ENV);

  if (env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder().setTitle('Embodha API').setVersion('0.1.0').addBearerAuth().build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));
  }
  await app.listen(env.PORT, '0.0.0.0');
}

void bootstrap();
