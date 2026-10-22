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
- `TrackingService.getOrCreateByProducto` provisiona el tracking cuando falta, usado por flujos anteriores. No sincroniza ingresos ni el ledger. Requiere un cambio de contrato separado para devolver ausencia en vez de un tracking persistido.

No se arranco el backend con `.env` local ni se hicieron mediciones autenticadas contra produccion. Las duraciones reales y Network quedan pendientes del despliegue y de una base de prueba representativa.
