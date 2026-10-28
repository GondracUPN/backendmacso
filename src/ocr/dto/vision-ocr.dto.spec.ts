import { ValidationPipe } from '@nestjs/common';
import { VisionOcrDto } from './vision-ocr.dto';

// Misma configuración que el ValidationPipe global de main.ts: los cuerpos que envían los dos escáneres deben pasar.
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } });
const validate = (body: unknown) => pipe.transform(body, { type: 'body', metatype: VisionOcrDto });

test('acepta los cuerpos de Inventario y de Productos (archivo, URL y recorte manual)', async () => {
  const crop = { x: 0.25, y: 0.5, width: 0.005, height: 0.1 };
  await expect(validate({ imageBase64: 'data:image/jpeg;base64,AAAA', mimeType: 'image/jpeg', requestToken: 'scan-1-ab12cd34', crop })).resolves.toMatchObject({ crop });
  await expect(validate({ imageUrl: 'https://example.com/a.jpg', requestToken: 'scan-2-zz', crop })).resolves.toBeInstanceOf(VisionOcrDto);
  await expect(validate({ imageBase64: 'AAAA', mimeType: 'image/png' })).resolves.toBeInstanceOf(VisionOcrDto);
});

test('rechaza recortes fuera de rango, propiedades extra y tokens no opacos', async () => {
  await expect(validate({ imageBase64: 'AAAA', crop: { x: 1.2, y: 0, width: 0.1, height: 0.1 } })).rejects.toBeDefined();
  await expect(validate({ imageBase64: 'AAAA', crop: { x: 0, y: 0, width: 0.001, height: 0.1 } })).rejects.toBeDefined();
  await expect(validate({ imageBase64: 'AAAA', crop: { x: 0, y: 0, width: 0.1, height: 0.1, extra: 1 } })).rejects.toBeDefined();
  await expect(validate({ imageBase64: 'AAAA', requestToken: 'no válido <script>' })).rejects.toBeDefined();
});
