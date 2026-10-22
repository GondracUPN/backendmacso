// La imagen de produccion no incluye ts-node. Ejecutar el CLI contra JS compilado.
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
const compiled = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'prod';
const config = resolve(__dirname, compiled ? '../dist/typeorm.config.js' : '../typeorm.config.ts');
if (!existsSync(config)) throw new Error('Falta la configuracion TypeORM; ejecutar npm run build antes del despliegue.');
if (!compiled) require('ts-node/register');
process.argv = [process.argv[0], require.resolve('typeorm/cli.js'), '-d', config, ...process.argv.slice(2)];
require('typeorm/cli.js');
