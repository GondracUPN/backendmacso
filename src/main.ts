import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors(); // habilitar CORS si usarás React
  await app.listen(3000);
}
bootstrap();
