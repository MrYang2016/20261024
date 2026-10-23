import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { hasPolyvCredentials, loadEnvFiles } from './env';

/** 讲师推流端与观看页的来源，CORS 只放行这两个 */
const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
];

async function bootstrap(): Promise<void> {
  loadEnvFiles();
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  app.setGlobalPrefix('api');
  app.enableCors({
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
    maxAge: 600,
  });
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);

  const logger = new Logger('Bootstrap');
  logger.log(`API 已启动: http://localhost:${port}/api`);
  if (!hasPolyvCredentials()) {
    logger.warn('未检测到保利威凭证（POLYV_APP_ID / POLYV_APP_SECRET），频道相关接口会返回 503');
  }
}

void bootstrap();
