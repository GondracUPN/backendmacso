import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: [
      'https://frontend-tailwind-unye.vercel.app', // tu front en Vercel
      'http://localhost:3000', // útil en dev si usas CRA en 3000
      'http://localhost:5173', // útil si usas Vite en dev
    ],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false, // pon true solo si usas cookies/sesión
    optionsSuccessStatus: 204, // respuesta al preflight
  });

  await app.listen(process.env.PORT || 3000);
}
bootstrap();
