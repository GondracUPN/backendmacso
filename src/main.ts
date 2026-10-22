// src/main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { json, text } from 'express';
import compression = require('compression');
import { RequestPerformanceInterceptor } from './common/request-performance';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { CacheInvalidationInterceptor } from './common/app-cache';
import {
  assertExpectedDbTargetOrThrow,
  assertRequiredColumnsOrThrow,
  shouldRunDbGuard,
} from './db/db-boot.guard';
// (opcional) si quieres headers de seguridad extra, instala helmet y descomenta:
// import helmet from 'helmet';

async function bootstrap() {
  // cors: false aquí para configurarlo explícitamente después
  const app = await NestFactory.create(AppModule, { cors: false, bodyParser: false });

  const cfg = app.get(ConfigService);
  const dataSource = app.get(DataSource);
  const cache = app.get(CACHE_MANAGER);
  app.useGlobalInterceptors(new CacheInvalidationInterceptor(cache));
  app.useGlobalInterceptors(new RequestPerformanceInterceptor());
  app.use('/tm/amazon-template', text({ type: 'text/plain', limit: '3mb' }));
  app.use(json({ limit: '14mb' }));
  app.use(compression({ threshold: 1024 }));

  // Seguridad básica (opcional)
  // app.use(helmet());

  // CORS (en dev permitimos cualquier origen; en prod, el configurado)
  const env = (process.env.NODE_ENV || '').toLowerCase();
  const isProd = env === 'production' || env === 'prod';
  const frontendUrl = cfg.get<string>('FRONTEND_URL') ?? 'https://frontend-tailwind-unye.vercel.app';
  app.enableCors({
    origin: isProd
      ? [frontendUrl]
      : true, // en desarrollo aceptar cualquier origen (localhost, 127.0.0.1, LAN)
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['Server-Timing', 'Timing-Allow-Origin'],
    credentials: false, // pon true solo si usas cookies/sesión
    optionsSuccessStatus: 204,
  });

  app.use((_req, res, next) => {
    res.setHeader('Timing-Allow-Origin', isProd ? frontendUrl : '*');
    next();
  });

  // Validación global de DTOs
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // elimina propiedades desconocidas
      forbidNonWhitelisted: true, // lanza error si llegan props extras
      transform: true, // transforma tipos (ej. ParseIntPipe implícito)
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // (Opcional) Prefijo global para todas las rutas:
  // app.setGlobalPrefix('api');

  const schema = cfg.get<string>('DB_SCHEMA') || 'public';
  const nodeEnv = cfg.get<string>('NODE_ENV') || '';
  if (shouldRunDbGuard(nodeEnv, cfg.get<string>('DB_GUARD_ENABLED'))) {
    const url = new URL(cfg.get<string>('DATABASE_URL') || '');
    assertExpectedDbTargetOrThrow({ host: url.host, database: url.pathname.slice(1), schema }, {
      EXPECTED_DB_HOST: cfg.get<string>('EXPECTED_DB_HOST'),
      EXPECTED_DB_HOSTS: cfg.get<string>('EXPECTED_DB_HOSTS'),
      EXPECTED_DB_NAME: cfg.get<string>('EXPECTED_DB_NAME'),
      EXPECTED_DB_NAMES: cfg.get<string>('EXPECTED_DB_NAMES'),
      EXPECTED_DB_SCHEMA: cfg.get<string>('EXPECTED_DB_SCHEMA'),
      EXPECTED_DB_SCHEMAS: cfg.get<string>('EXPECTED_DB_SCHEMAS'),
    });
  }
  if (cfg.get<string>('SCHEMA_BOOT_CHECK') === 'true') {
    await assertRequiredColumnsOrThrow(dataSource, schema, cfg.get<string>('REQUIRED_DB_COLUMNS'));
    console.log('[BOOT][SCHEMA_CHECK] ok');
  }

  const port = Number(process.env.PORT || cfg.get<string>('PORT') || 3001);
  await app.listen(port, '0.0.0.0');

  console.log(`API escuchando en puerto ${port}`);
}
bootstrap();
