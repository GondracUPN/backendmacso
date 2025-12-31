// src/main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
// (opcional) si quieres headers de seguridad extra, instala helmet y descomenta:
// import helmet from 'helmet';

async function bootstrap() {
  // cors: false aquí para configurarlo explícitamente después
  const app = await NestFactory.create(AppModule, { cors: false });

  const cfg = app.get(ConfigService);
  const dataSource = app.get(DataSource);

  // Seguridad básica (opcional)
  // app.use(helmet());

  // CORS (en dev permitimos cualquier origen; en prod, el configurado)
  const isProd = (process.env.NODE_ENV || '').toLowerCase() === 'production';
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
  (async () => {
    try {
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

      const tables = ['producto', 'producto_detalle', 'producto_valor', 'tracking'];
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
    }
  })();

  const port = Number(process.env.PORT || cfg.get<string>('PORT') || 3001);
  await app.listen(port, '0.0.0.0');

  console.log(`API escuchando en puerto ${port}`);
}
bootstrap();
