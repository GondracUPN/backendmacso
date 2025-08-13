import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Ajusta los origins al dominio real de tu frontend
  app.enableCors({
    origin: [
      'https://frontend-tailwind-alpha.vercel.app/',
      'https://tu-frontend.pages.dev',
      // agrega otros dominios si aplica
    ],
    credentials: true,
  });

  await app.listen(process.env.PORT || 3000);
}
bootstrap();
