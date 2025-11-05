require('reflect-metadata');
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('./dist/app.module');

(async () => {
  try {
    const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
    const productoService = app.get(require('./dist/producto/producto.service').ProductoService);
    const res = await productoService.findAll();
    console.log('OK Productos:', Array.isArray(res) ? res.length : typeof res);
    await app.close();
    process.exit(0);
  } catch (e) {
    console.error('DEBUG /productos error:', e && e.stack ? e.stack : e);
    process.exit(1);
  }
})();

