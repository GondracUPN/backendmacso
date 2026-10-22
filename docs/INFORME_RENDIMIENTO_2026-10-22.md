# Informe de rendimiento — 2026-10-22

**Síntoma:** casi cualquier pantalla tarda varios segundos en cargar.

**Conclusión:** la lentitud no se debe a una sola causa. Se suman cuatro problemas:

1. El backend y la base de datos están en continentes distintos.
2. Las cachés del servidor caducan en milisegundos, así que no funcionan.
3. Algunos GET escriben en la base dentro de bucles.
4. El frontend repite peticiones en cascada.

El punto 1 multiplica el costo de todos los demás.

Alcance: revisión estática del código, comprobación de la unidad del TTL de `cache-manager` y medición con `curl` de la latencia hacia el backend de producción. No se midieron endpoints autenticados ni se ejecutó el backend local, porque el `.env` local apunta a la base de producción y uno de los GET escribe datos.

---

## 1. Infraestructura: backend en EE. UU., base en Brasil (principal sospechoso)

| Pieza | Dónde está | Evidencia |
| --- | --- | --- |
| Backend NestJS | Koyeb, cabecera `x-koyeb-backend: was` (probablemente Washington DC) | `curl -I` al backend de producción |
| PostgreSQL | Neon `sa-east-1` (São Paulo) | Host de `DATABASE_URL`, `backend/.env` |
| Frontend | Vercel | `FRONTEND_URL` en `main.ts` |

Entre Washington y São Paulo hay unos **110–130 ms de ida y vuelta** (estimación habitual para esa distancia; falta confirmarlo en el panel). TypeORM ejecuta las consultas **una tras otra**, y cada una paga esa espera:

| Consultas secuenciales | Espera solo por red |
| --- | --- |
| 10 | ≈ 1,2 s |
| 30 | ≈ 3,6 s |
| 60 (un GET con sincronización, ver §3) | ≈ 7 s |

Además, desde Perú incluso un `401` sin base de datos tarda **≈ 0,33 s** de TTFB.

**Arranque en frío:** al iniciar, `main.ts` y `db/financial-schema.ts` ejecutan unas **150 consultas DDL** secuenciales (78 + 72 llamadas `query(`). Si la instancia de Koyeb escala a cero, o si Neon suspende el cómputo por inactividad, la primera petición espera el arranque más esas 150 consultas cruzando continentes: decenas de segundos.

**Acción:** poner backend y base en **la misma región**, ya sea moviendo el servicio de Koyeb cerca de São Paulo o moviendo la base cerca del backend. Confirmar en los paneles de Koyeb y Neon la región exacta, si la instancia escala a cero y si Neon tiene autosuspensión. Sacar el DDL del arranque y pasarlo a migraciones que se ejecuten una sola vez.

## 2. Las cachés del servidor no cachean nada (bug confirmado)

El proyecto usa `@nestjs/cache-manager` 3.0.1 con `cache-manager` **7.2.4**. En esa versión el TTL se expresa en **milisegundos**, pero el código pasa segundos:

| Lugar | Valor pasado | Duración real |
| --- | --- | --- |
| `producto.service.ts:81` `listCacheTtlSeconds = 30` → `findAll` (`/productos`) | 30 | **30 ms** |
| `producto.service.ts` `statsCached` / `resumenCached` | 300 | 0,3 s |
| `analytics.service.ts:464,511,518,2091,2166,2187` | 300 / 3600 | 0,3 s / 3,6 s |

Prueba ejecutada: `set('k','v',30)` devuelve el valor de inmediato y `undefined` a los 100 ms.

Además, `producto.module.ts`, `venta.module.ts` y `analytics.module.ts` llaman cada uno a `CacheModule.register()` por separado, así que cada módulo tiene su propio almacén. Ventas, tracking o inventario no pueden invalidar la lista de productos. **Corregir solo el TTL mostraría datos viejos**: hace falta una caché global única con invalidación explícita.

## 3. Un GET que escribe en la base, en bucle (`/ventas/adelantos/ultimos`)

`VentaService.findLatestAdelantosByProductos` (`venta.service.ts:825–842`) ejecuta lo siguiente **por cada reserva activa y de forma secuencial**:

```ts
for (const adelanto of adelantos) await this.syncAdelantoIncome(adelanto, adelanto.producto);
```

`syncAdelantoIncome` → `syncAdelantoIncomeRows` (por cada cuota y dueño):
- `gastoRepo.find`;
- `resolveIncomeUser`, que hace 1–2 consultas y se repite por cada dueño;
- a veces otro `find`;
- `gastoRepo.save`, que hace SELECT + UPDATE/INSERT.

Después llama a `FinanzasLedgerService.sincronizarAdelanto`, que hace:
- `findOne` del adelanto y `findOne` de la venta;
- `cuentaPorCodigo` por cada cuota;
- `reconciliarDerivados`: `find`, más un `findOne` y un `update` por cada pago;
- un `update` final.

Son **≈ 12–25 consultas por reserva**, que con la latencia del §1 suman 1,5–3 s por reserva. Con 5 reservas activas, la petición pasa de 10 s.

Esta sincronización **ya se ejecuta en todas las escrituras** (`venta.service.ts:1110, 1202, 1332, 1387, 1444`: crear, añadir cuota, actualizar, completar y cancelar), así que en la lectura es redundante. Además, ese endpoint se llama:
- desde `Productos.js:2152`, cada vez que cambia el arreglo `productos`;
- desde `Productos.js:379`;
- desde `GastosPanel.js:545` y `:599`.

**Acción:** quitar la sincronización del GET, dejarla solo en las escrituras y añadir un script de backfill puntual por si hay datos antiguos desalineados.

## 4. Cascadas y N+1 en el frontend

| Problema | Ubicación | Efecto |
| --- | --- | --- |
| `/productos` se pide desde tres sitios | `App.js:541`, `Home.js:18`, `Productos.js:2076` (más `App.js:805` con el modal Eshopex abierto) | La deduplicación de `api.js` solo junta peticiones simultáneas |
| Entrar en Productos fuerza la recarga | `Productos.js:2097–2101` (`app-view-activated` → `force:true, useCache:false`) | Cada cambio de vista vuelve a descargar todo |
| Cascada productos → ventas/adelantos | `Productos.js:2132–2183`, efecto con dependencia `[productos]` | Cada arreglo nuevo vuelve a pedir `/ventas/ultimas` y `/ventas/adelantos/ultimos` y dispara las escrituras del §3 |
| URL con todos los ids | `?ids=1,2,3,...` con cientos de ids | Riesgo de superar el límite de longitud de URL; conviene usar POST o filtrar en el servidor |
| N+1 HTTP en Gastos | `GastosPanel.js:236–243`: un `/ventas/adelanto/:id` por fila; se repite cada vez que cambia `rows` | N peticiones, y cada `resumenAdelanto` hace 4 consultas secuenciales (`venta.service.ts:1210`) |
| `fetch` directo sin el cliente central | `GastosPanel.js:444–451`, `AnalisisGastos.js:158–162` | No hay deduplicación, cancelación ni caché |
| Intervalos que leen y parsean `localStorage` | `App.js:666` (1 s), `App.js:816` (1 s, con modal abierto: `setProductosGlobal` con un arreglo nuevo cada segundo, lo que re-renderiza toda la App), `Productos.js:1227` (750 ms), `Productos.js:1354` (500 ms) | Ocupan el hilo principal de forma continua y causan re-renders; siguen activos en las vistas que se mantienen ocultas (keep-alive) |
| Ganancias descarga todas las ventas | `Ganancias.js:203` `api.get('/ventas')` | Cada venta llega con su producto, valor y detalle |

## 5. Base de datos

Faltan índices en claves foráneas muy consultadas (PostgreSQL no las indexa automáticamente). `tracking.productoId` sí tiene índice.

- `venta("productoId")`: se usa en `NOT EXISTS` por producto en `inventario.service.ts:55`, en `/ventas/ultimas` y en `findExistingByProducto`.
- `venta_adelanto("productoId", ...)`: se usa en `reservaActivaSql` y `DISTINCT ON`.
- `gastos("user_id", fecha)`: se usa en `findAllByUser` y `cards.getSummary`.
- `gastos(notas)` o `(concepto, notas)`: se usa en `syncAdelantoIncomeRows` y en `resumenAdelanto` con `LIKE '__SALE_ADVANCE__:id:%'`.

Validar cada uno con `EXPLAIN ANALYZE` antes de crearlo.

Otras observaciones:
- `Producto.tracking` es `eager: true`, así que cualquier `find` de producto arrastra todo su tracking.
- `findAccessoryDisplayCode` (`producto.service.ts:249`) carga **todos** los productos del mismo tipo, con relaciones, cada vez que se crea un accesorio. `createLote` lo repite por cada unidad, de forma secuencial.

## 6. Tamaño de los bundles del frontend

La división de código ya es razonable (las páginas usan `lazy`). Aun así:
- `GastosPanel.js:8` importa `ModalGastoCreditoMasivo` de forma **estática**, y ese modal importa `xlsx` y `pdfjs-dist` (chunks 238 y 133: ≈ 1,4 MB sin comprimir). Abrir Gastos descarga ambos aunque no se use el modal.
- El build genera **source maps** de unos 19 MB. Hay que confirmar que no se publican en Vercel (`GENERATE_SOURCEMAP=false`).
- **Compresión HTTP:** el backend no usa `compression`. Falta verificar en DevTools si Cloudflare/Koyeb ya comprime `/productos` (cabecera `Content-Encoding`). La respuesta de `/productos` incluye detalle, valor y todo el tracking de cada producto.

## 7. Prioridades e impacto esperado

| # | Cambio | Impacto | Esfuerzo |
| --- | --- | --- | --- |
| P0 | Backend y base en la misma región; evitar el escalado a cero | Muy alto: divide entre 5 y 20 el tiempo de cada consulta | Infraestructura |
| P0 | Quitar la sincronización de `findLatestAdelantosByProductos` | Muy alto en Productos y Gastos | Bajo |
| P0 | TTL en ms + caché global + invalidación | Alto | Medio |
| P1 | Cortar la cascada en `Productos.js` y deduplicar `/productos` | Alto | Medio |
| P1 | Endpoint por lotes para los resúmenes de adelanto (Gastos) | Medio | Bajo |
| P1 | Índices validados con EXPLAIN | Medio, crece con los datos | Bajo |
| P1 | Sacar el DDL del arranque | Alto en arranque en frío | Medio |
| P2 | Intervalos → eventos `storage`/`CustomEvent`; pausar vistas ocultas | Fluidez de la UI | Medio |
| P2 | `lazy` para `ModalGastoCreditoMasivo`, compresión, sin source maps | Primera carga | Bajo |
| P2 | Paralelizar consultas independientes (`Promise.all`) y quitar `eager` de tracking | Medio | Medio |

## 8. Nota de seguridad (fuera del alcance de rendimiento)

`backend/.env` contiene en texto plano credenciales de cuentas de terceros (`ESHOPEX_ACCOUNTS`). Conviene moverlas a los secretos del proveedor y rotarlas. Este informe no copia ningún valor.


## 9. Implementacion y verificacion por fases

Se preserva arriba el diagnostico inicial. Los numeros de linea de ese diagnostico son historicos; las referencias se revalidaron con el indice y el codigo actual. No se inicio el backend contra Neon, no se copiaron valores de .env y no se ejecutaron backfills ni migraciones contra produccion.

| Fase | Resultado y archivos principales | Commit local |
| --- | --- | --- |
| 0 | Interceptor y logger SQL aislado por AsyncLocalStorage; Server-Timing y CORS. backend/src/common/request-performance.ts, su spec, main.ts, app.module.ts. | cc412e3 |
| 1 | Un CacheModule global, TTL en ms, invalidacion por prefijos registrados y generacion contra lecturas antiguas. common/app-cache.ts, producto/venta/analytics.module.ts, producto.service.ts y analytics.service.ts. | d088cf9 |
| 2 | Ultimos adelantos solo lectura; sincronizacion conservada en escrituras, memo de usuarios y backfill manual paginado. venta.service.ts, venta.performance.spec.ts, scripts/backfill-adelanto-income.ts, package.json, docs/RENDIMIENTO.md. | e1de165 |
| 3 | Resumenes por lote, GET sin URLs enormes, consultas en grupos pequenos, transaccion para lotes, busqueda de codigos con seleccion minima y ledger con precargas. venta.service/controller, producto.service/spec, cards.service, finanzas-ledger.service, app-cache.ts. Los ajustes posteriores de create usan update. | 6185155 y e0dfca8 |
| 4 | Cuatro indices CONCURRENTLY, transaction=false, justificados con EXPLAIN ANALYZE en PostgreSQL desechable. migrations/1792537700000-IndicesRendimiento.ts, docs/EXPLAIN_RENDIMIENTO.md, tools/performance-index-benchmark.cjs. | 0a30993 |
| 5 | DDL fuera de HTTP; migracion Legacy, CLI compilado y orden de despliegue; guard de columnas en una consulta; compression desde 1 KB. main.ts, db-boot.guard.ts/spec, migrations/1760831900000-EsquemaLegacy.ts, SistemaFinanciero.ts, Dockerfile, typeorm.config.ts, package.json/lock, tools/typeorm-cli.cjs y performance-schema-check.cjs. | 5ed4a04 |
| 6 | Store de productos compartido, firma de IDs, reservas en lote en Gastos, api con cache optativa/cancelacion/timeout, eventos de storage, lazy del importador, sin source maps y Ganancias con union de rangos activos. frontend-tailwind/src/services/productosStore.js, api.js, App.js, pages/Home/Productos/GastosPanel/AnalisisGastos/Ganancias/LoginGastos.js, utils/storageEvents.js, scripts/build.cjs y sus pruebas. | 8700ab4 |
| 7 | Pool maximo diez y guia de region, suspension, pooler, release y medicion para el usuario. docs/DEPLOY_RENDIMIENTO.md; backend/src/app.module.ts y typeorm.config.ts. | Commit final de documentacion |

Verificacion transversal adicional (7c7f07d): subscriber registrado tambien en contextos Nest de scripts, nombres explicitos de TTL de divisas, cabecera Server-Timing probada e invalidacion tras commit de venta.

## 10. Antes y despues: evidencia y limites

Los valores marcados como estaticos proceden del diagnostico y del codigo, no de una medicion de red. Las consultas de los servicios se cuentan con repositorios simulados: no incluyen posibles consultas de autenticacion. No se presentan tiempos de Jest como duracion de una peticion real.

| Indicador | Antes | Despues verificado | Objetivo real / pendiente |
| --- | --- | --- | --- |
| TTL lista productos | 30 ms, confirmado en diagnostico | 60 000 ms, prueba del argumento a cache-manager | Invalidacion entre replicas pendiente si se escala |
| TTL KPIs productos | 300 ms | 300 000 ms; SWR sigue comparando milisegundos | Frescura en produccion por verificar |
| TTL analiticas | 45/600/3600 ms segun cache | 45 000/600 000/3 600 000 ms | Red y cache de instancia por verificar |
| GET productos frio | Sin conteo HTTP previo | 1 consulta del servicio, prueba unitaria | Como maximo 2 consultas y menos de 300 ms en misma region: pendiente |
| GET productos caliente | Cache expirada casi siempre | 0 consultas del servicio, prueba unitaria | Menos de 20 ms en misma region: pendiente |
| GET ultimos adelantos | Una lectura mas sincronizacion por reserva; 12–25 consultas estimadas por reserva | 1 lectura y 0 escrituras; prueba verifica que no toca gastoRepo.save ni ledger | Como maximo 2 consultas y menos de 200 ms: pendiente |
| Resumen de tres adelantos | Hasta cuatro consultas por reserva, secuenciales | 4 consultas en total, prueba con tres reservas | Validar con volumen real |
| Abrir Gastos con tres reservas | GET individual por fila mas recarga redundante | 5 GET + 1 POST, probado al renderizar el componente | Network autenticado y preflight por verificar |
| Volver a Productos antes de 60 s | Forzaba GET y cascada de ventas | 0 GET de productos y 0 GET de ventas, prueba de activacion | Confirmar en navegador desplegado |
| Pestana en reposo | Sondeos de 500/750/1000 ms y JSON repetido | Eventos; sondeo de progreso solo durante carga, pausado por visibilidad/vista; prueba de pausa | Perfil React real pendiente |
| DDL por arranque HTTP | Aproximadamente 150 llamadas estaticas de arranque | 0 DDL en main; guard opcional: 1 consulta de columnas | El wrapper sin hook aun comprueba migraciones pendientes al iniciar contenedor |
| Source maps de produccion | Aproximadamente 19 MB segun informe | 0 archivos .map en build comprobado | Confirmar artefacto de Vercel |
| Compresion | Proxy no verificado | Middleware con umbral 1024 bytes, build correcto | Content-Encoding final en Network pendiente |

Mediciones SQL del fixture PostgreSQL desechable (WASM local; 60 000 ventas, 60 000 reservas, 120 000 gastos). Una ejecucion por caso: sirve para justificar el plan, no como benchmark de produccion ni de red.

| Consulta candidata | Antes sin indice (ms) | Despues con indice (ms) | Cambio observado |
| --- | --- | --- | --- |
| Venta por producto activo | 4.568 | 0.316 | Seq Scan -> Bitmap Index Scan |
| Ultima reserva por producto | 8.158 | 0.147 | Seq Scan -> Bitmap Index Scan |
| Gastos por usuario, fecha e id | 5.994 | 0.175 | Seq Scan -> Index Scan |
| Gastos por referencia exacta | 7.516 | 0.088 | Seq Scan -> Bitmap Index Scan |

No se agrega ademas un indice parcial de venta sin evidencia de que mejore el indice completo. El LIKE de referencias usa underscores comodin; el indice text_pattern_ops se justifica por igualdad, sin prometer mejora para ese LIKE.

## 11. Pruebas y entrega

| Fase | Backend (suites / pruebas) | Frontend (suites / pruebas) | Verificacion adicional |
| --- | --- | --- | --- |
| 0 | 29 / 214 | 49 / 308 | Contadores concurrentes aislados |
| 1 | 30 / 222 | 49 / 308 | TTL, invalidacion por escritura y generaciones |
| 2 | 31 / 223 | 49 / 308 | GET sin writes, pruebas existentes de cuotas y cancelacion |
| 3 | 31 / 224 | 49 / 308 | Resumen en cuatro consultas y recompra con codigo compartido |
| 4 | 31 / 224 | 49 / 308 | EXPLAIN ANALYZE antes/despues y cuatro CREATE INDEX CONCURRENTLY |
| 5 | 32 / 226 | 49 / 308 | Build backend; SQL de todas las migraciones dos veces en PostgreSQL desechable |
| 6 y verificacion transversal | 32 / 229 | 53 / 320 | Ambos builds; cero .map; pruebas de store, API, Gastos y pausas |
| 7 | 32 / 229 | 53 / 320 | Ambos builds, CLI compilado (--help sin conectar), pool, guia y verificacion del indice |

Comandos ejecutados: npm run index:query / index:text para navegar, npm run index:update tras cambios, npx jest --runInBand en backend y CI=true npx react-scripts test --watchAll=false --runInBand en frontend. El uso de runInBand limita procesos de pruebas y nunca conecta los servicios simulados a la base real.

Los detalles completos del SQL estan en backend/docs/EXPLAIN_RENDIMIENTO.md, las decisiones de GET historicos en backend/docs/RENDIMIENTO.md y los pasos de infraestructura y reproduccion en docs/DEPLOY_RENDIMIENTO.md. Los logs locales quedan en .code-index/performance-logs/. Se conservan Skills, planes y cambios previos.

Pendientes externos: desplegar los commits, ejecutar las migraciones en el entorno administrado, decidir regiones/capacidad en los paneles, medir Server-Timing y Network autenticados en caliente/frio, verificar chunks lazy y Content-Encoding reales. Ningun objetivo de latencia de produccion se declara alcanzado sin esa medicion.

Verificacion final del indice: index:update e index:verify completados con ok=true. El indexador conserva dos diagnosticos de parseo anteriores en frontend-tailwind/src/pages/Analisis.js (lineas 5089 y 5126); ese archivo no fue modificado y el build real de React compila correctamente.
