// src/main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { text } from 'express';
import {
  assertExpectedDbTargetOrThrow,
  assertRequiredColumnsOrThrow,
  shouldRunDbGuard,
} from './db/db-boot.guard';
// (opcional) si quieres headers de seguridad extra, instala helmet y descomenta:
// import helmet from 'helmet';

async function bootstrap() {
  // cors: false aquí para configurarlo explícitamente después
  const app = await NestFactory.create(AppModule, { cors: false });

  const cfg = app.get(ConfigService);
  const dataSource = app.get(DataSource);
  app.use('/tm/amazon-template', text({ type: 'text/plain', limit: '3mb' }));

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
    credentials: false, // pon true solo si usas cookies/sesión
    optionsSuccessStatus: 204,
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

  // Log de entorno y columnas de tablas clave para diagnostico en despliegues
  let shouldBlockBoot = false;
  try {
    if (!dataSource.isInitialized) {
      await dataSource.initialize();
    }

    const rawUrl = process.env.DATABASE_URL || cfg.get<string>('DATABASE_URL') || '';
    const schema = process.env.DB_SCHEMA || cfg.get<string>('DB_SCHEMA') || 'public';
    const sync = process.env.DB_SYNC || cfg.get<string>('DB_SYNC') || '';
    const nodeEnv = process.env.NODE_ENV || cfg.get<string>('NODE_ENV') || '';
    let parsed = { host: 'n/a', db: 'n/a' };
    try {
      const u = new URL(rawUrl);
      parsed = { host: u.host, db: u.pathname.replace(/^\//, '') || 'n/a' };
    } catch {
      parsed = { host: 'invalid_url', db: 'invalid_url' };
    }
    console.log('[BOOT][DB_ENV]', { ...parsed, schema, sync, nodeEnv });

    try {
      const info = await dataSource.query(
        `SELECT current_database() AS db,
                current_schema() AS schema,
                current_user AS "user",
                current_setting('search_path') AS search_path`,
      );
      const dbInfo = info?.[0] || info;
      console.log('[BOOT][DB_INFO]', dbInfo);

      const guardEnabled = shouldRunDbGuard(
        nodeEnv,
        process.env.DB_GUARD_ENABLED || cfg.get<string>('DB_GUARD_ENABLED'),
      );
      const requireColumns = shouldRunDbGuard(
        nodeEnv,
        process.env.DB_GUARD_REQUIRE_COLUMNS || cfg.get<string>('DB_GUARD_REQUIRE_COLUMNS'),
      );
      shouldBlockBoot = guardEnabled;

      console.log('[BOOT][DB_GUARD]', {
        enabled: guardEnabled,
        requireColumns,
      });

      if (guardEnabled) {
        assertExpectedDbTargetOrThrow(
          {
            host: parsed.host,
            database: dbInfo?.db || parsed.db,
            schema: dbInfo?.schema || schema,
            user: dbInfo?.user,
            searchPath: dbInfo?.search_path,
          },
          {
            EXPECTED_DB_HOST: process.env.EXPECTED_DB_HOST || cfg.get<string>('EXPECTED_DB_HOST'),
            EXPECTED_DB_HOSTS: process.env.EXPECTED_DB_HOSTS || cfg.get<string>('EXPECTED_DB_HOSTS'),
            EXPECTED_DB_NAME: process.env.EXPECTED_DB_NAME || cfg.get<string>('EXPECTED_DB_NAME'),
            EXPECTED_DB_NAMES: process.env.EXPECTED_DB_NAMES || cfg.get<string>('EXPECTED_DB_NAMES'),
            EXPECTED_DB_SCHEMA: process.env.EXPECTED_DB_SCHEMA || cfg.get<string>('EXPECTED_DB_SCHEMA'),
            EXPECTED_DB_SCHEMAS: process.env.EXPECTED_DB_SCHEMAS || cfg.get<string>('EXPECTED_DB_SCHEMAS'),
          },
        );

        if (requireColumns) {
          await assertRequiredColumnsOrThrow(
            dataSource,
            dbInfo?.schema || schema,
            process.env.REQUIRED_DB_COLUMNS || cfg.get<string>('REQUIRED_DB_COLUMNS'),
          );
        }

        console.log('[BOOT][DB_GUARD] ok');
      }
    } catch (e) {
      console.log('[BOOT][DB_INFO] error', (e as any)?.message || e);
      throw e;
    }

    
    try {
      await dataSource.query(
        `CREATE TABLE IF NOT EXISTS "${schema}"."ebay_pawns" (
          "id" SERIAL PRIMARY KEY,
          "store_url" varchar(255) NOT NULL,
          "store_name" varchar(255) NOT NULL,
          "seller" varchar(120) NOT NULL,
          "original_url" varchar(255),
          "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
      );
      await dataSource.query(
        `ALTER TABLE "${schema}"."ebay_pawns" ADD COLUMN IF NOT EXISTS "original_url" varchar(255)`,
      );
      await dataSource.query(
        `CREATE INDEX IF NOT EXISTS "idx_ebay_pawns_store_url" ON "${schema}"."ebay_pawns" ("store_url")`,
      );
      await dataSource.query(
        `CREATE INDEX IF NOT EXISTS "idx_ebay_pawns_seller" ON "${schema}"."ebay_pawns" ("seller")`,
      );
      await dataSource.query(
        `ALTER TABLE "${schema}"."producto" ADD COLUMN IF NOT EXISTS accesorios text[] NOT NULL DEFAULT '{}'::text[]`,
      );
      await dataSource.query(
        `ALTER TABLE "${schema}"."producto" ADD COLUMN IF NOT EXISTS vendedor varchar(20)`,
      );
      await dataSource.query(
        `ALTER TABLE "${schema}"."tracking" ADD COLUMN IF NOT EXISTS estatus_esho varchar`,
      );
      await dataSource.query(
        `ALTER TABLE "${schema}"."venta" ADD COLUMN IF NOT EXISTS "tipoCambioGonzalo" numeric(10,4)`,
      );
      await dataSource.query(
        `ALTER TABLE "${schema}"."venta" ADD COLUMN IF NOT EXISTS "tipoCambioRenato" numeric(10,4)`,
      );

      const renameCandidates = await dataSource.query(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'producto_detalle'`,
        [schema],
      );
      const hasTamano = renameCandidates.some((r: any) => r.column_name === 'tamano');
      const hasTamanio = renameCandidates.some((r: any) => r.column_name === 'tama\u00f1o');
      if (!hasTamano && hasTamanio) {
        await dataSource.query(
          `ALTER TABLE "${schema}"."producto_detalle" RENAME COLUMN "tama\u00f1o" TO tamano`,
        );
      }
      console.log('[BOOT][DB_SCHEMA_FIX] ok');
    } catch (e) {
      console.log('[BOOT][DB_SCHEMA_FIX] error', (e as any)?.message || e);
    }

    const tables = ['ebay_pawns', 'producto', 'producto_detalle', 'producto_valor', 'tracking'];
    for (const tbl of tables) {
      try {
        const cols = await dataSource.query(
          `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = $2
           ORDER BY ordinal_position`,
          [schema, tbl],
        );
        console.log(`[BOOT][DB_COLUMNS][${tbl}]`, cols);
      } catch (e) {
        console.log(`[BOOT][DB_COLUMNS][${tbl}] error`, (e as any)?.message || e);
      }
    }
  } catch (e) {
    console.log('[BOOT][DB_ENV] error', (e as any)?.message || e);
    if (shouldBlockBoot) throw e;
  }

  const port = Number(process.env.PORT || cfg.get<string>('PORT') || 3001);
  await app.listen(port, '0.0.0.0');

  console.log(`API escuchando en puerto ${port}`);
}
bootstrap();
