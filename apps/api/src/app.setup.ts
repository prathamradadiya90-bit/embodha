import { BadRequestException, INestApplication, ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { ENV } from './config/config.module';
import type { Env } from './config/env';

/** Shared by main.ts and the tests, so tests run the same pipes and headers as production. */
export function configureApp(app: INestApplication) {
  const env = app.get<Env>(ENV);
  app.use(helmet());
  app.enableCors({ origin: env.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean) });
  // The VPS runs the API behind a reverse proxy; trust one hop so rate limits see the real client IP.
  (app.getHttpAdapter().getInstance() as { set: (key: string, value: unknown) => void }).set('trust proxy', 1);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors) =>
        new BadRequestException({
          code: 'invalid_request',
          message: 'Some fields need fixing.',
          fields: errors.map((error) => ({ field: error.property, problems: Object.values(error.constraints ?? {}) })),
        }),
    }),
  );
  app.enableShutdownHooks();
}
