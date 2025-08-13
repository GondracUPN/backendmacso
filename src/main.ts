import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
  origin: ['http://localhost:3001', 'https://tu-dominio.com'],
}); // habilitar CORS si usarás React
  await app.listen(3000);
}
bootstrap();
