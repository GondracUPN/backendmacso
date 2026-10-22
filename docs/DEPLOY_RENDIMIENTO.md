# Despliegue y verificacion de rendimiento

Estos pasos requieren los paneles y el entorno de despliegue del usuario. No se ejecutaron cambios en Koyeb ni Neon desde este workspace.

## Region y capacidad

1. El informe del 22 de octubre observo `x-koyeb-backend: was` y una base Neon en `sa-east-1`. Confirmar las regiones actuales en ambos paneles; la cabecera no sustituye esa comprobacion.
2. Elegir una region comun para backend y base. Comparar las regiones ofrecidas por los planes actuales de Koyeb y Neon antes de decidir si mover el servicio hacia Sao Paulo o la base hacia el backend. Medir despues la latencia desde el servicio hacia una base de prueba en esa region. No asumir que una region esta incluida en el plan.
3. Desactivar el escalado a cero de Koyeb si el plan lo permite, o aceptar la primera carga tras suspension. Revisar tambien la autosuspension del compute de Neon. Medir una carga en frio separada de las cargas en caliente.
4. Comprobar en secretos que `DATABASE_URL` usa el host con `-pooler`, sin copiar su valor a comandos compartidos o logs. El informe inicial indica que ya lo usaba. TypeORM limita ahora cada pool a diez conexiones; multiplicar ese limite por replicas y procesos al revisar el limite del plan.

## Orden de despliegue

1. Respaldar la base desde el entorno administrado y verificar la recuperacion antes de cambiar esquema.
2. Instalar dependencias y compilar el backend. La imagen Docker incluye JavaScript compilado, TypeORM y compresion; no necesita ts-node en produccion.
3. Ejecutar una sola vez por release `npm run typeorm -- migration:run`, con `NODE_ENV=production` y los secretos del entorno elegido. Se usa `dist/typeorm.config.js`. No ejecutar este comando en el workspace local: su `.env` apunta a produccion.
4. El modo de migracion es `each`: cada migracion normal tiene su transaccion y `IndicesRendimiento` declara `transaction=false` para `CREATE INDEX CONCURRENTLY`. Si un indice queda invalido por un despliegue interrumpido, revisar `pg_index.indisvalid` y reconstruir solo ese indice desde el entorno administrado antes de reintentar; `IF NOT EXISTS` no repara un indice invalido.
5. Si Koyeb permite un hook de release, poner alli el paso 3 y usar `npm run start:prod` al arrancar instancias. Sin hook, el Dockerfile usa `npm run start:deploy`: comprueba/aplica pendientes y solo despues inicia HTTP. Evitar arrancar varias replicas simultaneamente mientras se aplican pendientes.
6. `main.ts` ya no ejecuta DDL. `SCHEMA_BOOT_CHECK=true` activa una unica consulta a `information_schema` para comprobar columnas, y falla si faltan. Se conserva el guard de destino esperado con las variables `EXPECTED_DB_*`. Usar `DB_SYNC=false` en despliegue.
7. Desplegar el frontend despues del backend: las nuevas rutas de resumenes por lote deben estar disponibles. Su build fija `GENERATE_SOURCEMAP=false`; se comprobo que no genera `.map`.
8. El backfill de adelantos es separado y manual. `npm run backfill:adelanto-income` solo cuenta; `npm run backfill:adelanto-income -- --apply` repara reservas activas secuencialmente. No ejecutarlo por cada arranque ni sustituirlo por un GET. Revisar tambien el backfill financiero existente si quedan datos historicos sin conciliar.

## Medicion con DevTools y Server-Timing

1. Con una sesion de prueba, abrir Network, conservar el registro y separar pruebas con cache del navegador desactivada de las pruebas de cache de la aplicacion. No compartir el token ni los cuerpos financieros de las respuestas.
2. Comprobar en `/productos` las cabeceras `Server-Timing: app;dur=..., db;desc="N queries"`, `Timing-Allow-Origin` y CORS. `PERF_LOG=false` desactiva el interceptor. Los avisos de rendimiento no incluyen parametros SQL ni tokens.
3. Registrar por fase al menos una peticion fria y varias calientes, el numero de consultas y la mediana de duracion. Incluir el tiempo total de Network por separado: el objetivo de servidor no incluye la red del cliente.
4. Objetivos tras compartir region: `/productos` caliente 0 consultas y menos de 20 ms; frio como maximo 2 y menos de 300 ms; ultimos adelantos como maximo 2 consultas, cero escrituras y menos de 200 ms. Las pruebas con repositorios simulados verifican 0/1/1 consultas del servicio, pero no sustituyen estas mediciones.
5. Abrir Gastos con varias reservas: como maximo seis peticiones de datos, sin GET por fila. La prueba de componente registra cinco GET y un POST para tres reservas. Verificar aparte los preflight CORS que genere el navegador.
6. Cambiar de vista y volver a Productos antes de 60 segundos: no debe aparecer otra peticion a `/productos`. Modificar producto, venta, tracking o inventario y comprobar que el resultado se renueva sin esperar el TTL. Repetir conciliacion, pagos y gastos que afecten ganancias.
7. Dejar la pestana quieta: no hay sondeos de JSON de productos. El sondeo de progreso de Eshopex existe solo durante cargas, se pausa al ocultar la pestana y en Productos al cambiar de vista. Registrar un perfil React si se necesita verificar renders reales.
8. Comprobar `Content-Encoding` para respuestas mayores de 1 KB. El backend incluye `compression` con ese umbral; la compresion final del proxy no se pudo inspeccionar con una sesion autenticada. Abrir Gastos sin abrir el importador masivo y verificar que no descarga los chunks de xlsx/pdfjs hasta abrirlo.

## Reproducir las pruebas PostgreSQL sin Neon

Desde `servicios`, instalar PGlite solo en la cache local:

```powershell
npm install --prefix .code-index/perf-db --no-audit --no-fund @electric-sql/pglite
$env:PERF_PGLITE_MODULE = (Resolve-Path .code-index/perf-db/node_modules/@electric-sql/pglite).Path
node backend/tools/performance-index-benchmark.cjs
npm --prefix backend run build
node backend/tools/performance-schema-check.cjs
```

El primer script genera `backend/docs/EXPLAIN_RENDIMIENTO.md` con 60 000 ventas, 60 000 reservas y 120 000 gastos sinteticos. El segundo construye una base desechable a partir de metadatos y aplica el SQL de todas las migraciones dos veces. Nunca inicializa el DataSource de la aplicacion ni lee `.env`. Estos ensayos no prueban contencion entre replicas ni distribuciones reales de produccion.

## Limites pendientes

- No se movieron regiones, planes, autosuspension ni replicas.
- No se midieron tiempos autenticados reales con backend y base en la misma region ni el Network de produccion.
- La invalidacion de cache es compartida entre modulos de una instancia. Antes de escalar a varias replicas, incorporar invalidacion distribuida; una escritura en una replica no invalida por si sola la memoria de otra.
- GET historicos conservados: provision inicial de wallet/tracking, reparacion de costos Personal Eshopex y el GET externo de carga Eshopex cuando se solicita una actualizacion. Se documentan en `backend/docs/RENDIMIENTO.md`; no forman parte de las lecturas de ultimos adelantos.
