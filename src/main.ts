// src/main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
// (opcional) si quieres headers de seguridad extra, instala helmet y descomenta:
// import helmet from 'helmet';

async function bootstrap() {
  // cors: false aquí para configurarlo explícitamente después
  const app = await NestFactory.create(AppModule, { cors: false });

  const cfg = app.get(ConfigService);

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

  const port = Number(process.env.PORT || cfg.get<string>('PORT') || 3001);
  await app.listen(port, '0.0.0.0');

  console.log(`API escuchando en puerto ${port}`);
}
bootstrap();
