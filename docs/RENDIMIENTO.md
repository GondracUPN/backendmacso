# Rendimiento de servicios

## Fases 0–2

- `Server-Timing` cuenta consultas reales de TypeORM aisladas por peticion. `PERF_LOG=false` desactiva la instrumentacion HTTP. No se registran parametros SQL ni tokens en los avisos de rendimiento.
- Un unico CacheModule global conserva productos durante 60 000 ms. Stats/resumen usan 300 000 ms y analiticas 600 000 ms con SWR a 120 000 ms. El universo de analiticas dura 45 000 ms. Los eventos de TypeORM invalidan despues de insert/update/remove y otra vez al commit; el interceptor cubre SQL directo en handlers de escritura. Se invalidan todos los prefijos registrados, incluidos los resumenes por anio. Una generacion evita publicar como vigente un resultado anterior a la invalidacion. Esto es local a una instancia; varias replicas necesitan un bus de invalidacion o cache distribuida antes de aumentar el TTL.
- `/ventas/adelantos/ultimos` ahora solo consulta. Crear, editar cuotas, actualizar, completar y cancelar mantienen la sincronizacion en las escrituras y sus transacciones.
- Reparacion manual: `npm run backfill:adelanto-income` cuenta reservas activas; `npm run backfill:adelanto-income -- --apply` sincroniza en lotes de 100, con una reserva por transaccion. No se ejecuto contra la base real.

## Auditoria adicional de GET

Se revisaron metodos de servicios de lectura que contienen save/update/insert/sync, y sus consumidores. Excepciones conservadas para no cambiar contratos funcionales en esta fase:

- `ProductoService.findPersonalEshopex` normaliza costos historicos obsoletos y los persiste; este flujo requiere separar una reparacion historica y validar el contrato de costos antes de quitarla.
- `WalletService.getOrCreate` provisiona una billetera inexistente con id persistente y saldos cero; sustituirla por una billetera virtual cambiaria el JSON y las escrituras posteriores. Las billeteras ya existentes son solo lectura.
- `TrackingService.getOrCreateByProducto` puede provisionar un tracking, pero la busqueda de consumidores actuales solo encontro su definicion; no se identifico un GET actual que lo invoque.
- Los GET externos `/tracking/eshopex-status/:code` y `/tracking/eshopex-carga` persisten estados logisticos obtenidos de Eshopex. Se conserva ese comportamiento explicito de integracion: quitarlo cambiaria el flujo Buscar/Actualizar y las marcas visibles en Productos/Personal. Su actualizacion de entidades invalida la cache compartida mediante el subscriber. El endpoint de progreso es solo lectura.

No se arranco el backend con `.env` local ni se hicieron mediciones autenticadas contra produccion. Las duraciones reales y Network quedan pendientes del despliegue y de una base de prueba representativa.

## Fases 3–7

- Resumen de varias reservas: cuatro consultas con `In`, y el mismo constructor de JSON que el resumen individual. Rutas POST de lectura para listas grandes, y GET sin IDs filtrado por productos no archivados. Las consultas independientes de tarjetas, cobros y resumen individual se ejecutan en grupos de tres.
- Accesorios: buscar coincidencia solo selecciona id/codigo y filtra modelo/estado en SQL. La busqueda de huecos selecciona solo codigos, sin tracking ni valor. Los lotes usan una transaccion y calculan el codigo una sola vez. Los ajustes de filas recien creadas usan update en lugar de save con precarga.
- Ledger: precarga cuentas por llamada de adelanto y claves faltantes mediante un solo `In`. Se conservan bloqueos, transacciones, validaciones e idempotencia de pagos.
- Indices: planes reales en PostgreSQL desechable con datos sinteticos, en `EXPLAIN_RENDIMIENTO.md`. No se agrega un segundo indice parcial de ventas sin beneficio demostrado. El indice de notas se valida por igualdad; los `_` de un LIKE sin escapar son comodines y no garantizan busqueda por prefijo.
- DDL historico trasladado a `EsquemaLegacy` y helpers financieros invocados desde migraciones. HTTP no ejecuta DDL. Guard opcional de columnas en una consulta, compresion desde 1 KB y pool maximo diez. Ver `DEPLOY_RENDIMIENTO.md` para release y para reproducir el ensayo de migraciones.
- Verificacion final: 229 pruebas backend, 320 frontend, ambos builds correctos, cuatro indices ensayados y SQL de migraciones ejecutado dos veces en base desechable. Las cifras de servidor real y red autenticada siguen pendientes.
