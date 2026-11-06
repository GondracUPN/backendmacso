# Reclamos, reembolsos y saldos a favor

## Estado de entrega

Implementado sobre Compras/Productos, Ventas y el libro financiero existente. La BD conectada al desarrollo local es una BD de pruebas y ya se preparó mediante synchronize, sin ejecutar migraciones. Las pruebas destructivas usan otra instancia PostgreSQL 15 desechable en `127.0.0.1:55439/reclamos_saldos_test`.

En este workspace local el esquema se actualiza con entidades TypeORM y synchronize al arrancar. Las protecciones SQL complementarias se preparan automáticamente. También puede ejecutarse `npm --prefix backend run db:sync:local`. Producción es un entorno separado y mantiene synchronize=false; los archivos de migración se conservan para ese flujo, sin ejecutarlos aquí.

## Flujo

1. En detalles de compra, **Reclamo no llegó** solicita uno de los dos motivos permitidos. El servidor obtiene el importe USD del `ProductoValor` original, registra la fecha en America/Lima y fija gastos adicionales del reclamo a cero. No modifica el valor ni los envíos de la compra. Bloquea el producto para venta y evita altas concurrentes duplicadas.
2. **Registrar reembolso recibido** muestra compra e importe y exige confirmar fecha efectiva y cuenta/tarjeta receptora. Conserva la compra y el cargo. Reutiliza `reembolso_eventos` y el ajuste de tarjeta existente; no introduce un segundo ingreso por el mismo evento.
3. Se reutiliza el campo Vendedor existente: Gonzalo (Jorge) resuelve a Jorge y Gonzalo (Kenny) a Kenny. Una correspondencia persistente pedido_key vincula esa selección a un ID; todas las operaciones de saldo usan ese ID. Se reutiliza un cliente previo únicamente si su nombre normalizado coincide exactamente y es único. Gonzalo y Renato no muestran controles de saldo. No se solicita registrar o seleccionar otra vez al comprador.
4. Al confirmar la anulación de una venta de pedido o registrar el reembolso recibido del producto, su importe efectivamente pagado queda automáticamente como saldo a favor de ese cliente. No se pide motivo ni una conversión posterior. Se conservan la venta original, sus cobros y su ingreso, y toda la operación es transaccional.
5. En una nueva venta, seleccionar el cliente consulta automáticamente su saldo. La aplicación es voluntaria, puede ser parcial y consume las fuentes más antiguas primero. Cada fuente conserva pago, venta, SKU, moneda, importe original, equivalencia USD y tipo de cambio histórico.
6. La aplicación genera una forma de pago en el ledger con origen `saldo_cliente`; no crea un ingreso bancario. Si falta dinero se exige decidir si fue pagado: solo la confirmación con fecha y cuenta registra un cobro nuevo; en caso contrario queda deuda en el mismo libro de pagos existente. Puede cobrarse más adelante desde **Registrar pago**.
7. El historial del cliente se consulta dentro de Ventas: fuentes, disponible, estado, aplicaciones, devoluciones, SKU destino, fechas, pagos y deuda. El resumen financiero muestra la obligación total al cierre del período. Una devolución al cliente crea un egreso y reduce el saldo en la misma transacción.

## Integridad

- NUMERIC en PostgreSQL y cálculo con céntimos según las convenciones existentes.
- Bloqueo por cliente y por venta, saldos en orden estable y claves de operación con huella del contenido.
- Restricción única sobre el pago origen: un cobro no respalda dos saldos.
- Reintentos de aplicaciones/devoluciones no repiten movimientos; cambios de contenido con la misma clave se rechazan.
- El pago aplicado por saldo se excluye del flujo bancario y de los saldos bancarios, pero cubre la deuda comercial de la venta destino.
- La venta origen cancelada no vuelve a generar ingreso comercial/utilidad. Sus cobros bancarios siguen conservados.
- FK RESTRICT y triggers protegen pagos origen, ingresos de Gastos y egresos de devolución vinculados a saldos. No se elimina su historial al editar/anular una venta o borrar un producto.
- Las ventas con saldos vinculados no admiten cambiar sus importes históricos. Las operaciones de saldo registran usuario y fecha de creación; reclamos y eventos nuevos también conservan actor.
- La relación entre reclamo y eventos ya no usa borrado en cascada.

## Migración

`src/migrations/1792538200000-SaldosClientes.ts` crea `clientes_comerciales`, `cliente_saldos` y `cliente_saldo_movimientos`; agrega el cliente de venta, el importe de pago convertido y los actores de reclamos/eventos. Añade restricciones monetarias, índices FIFO, FK y triggers. No transforma nombres ni reescribe importes anteriores. La reversión se rechaza cuando existen saldos con historial.

## Archivos

Backend:

- `src/finanzas/saldos-clientes.service.ts`: creación, aplicación FIFO, historial y devolución de saldos.
- `src/finanzas/dto/saldos.dto.ts`: validaciones de las nuevas operaciones.
- `src/migrations/1792538200000-SaldosClientes.ts`: persistencia y protección financiera.
- `src/finanzas/reclamos-saldos.integration.spec.ts`: escenarios contra PostgreSQL aislado.
- `src/finanzas/finanzas.service.ts`, `dto/finanzas.dto.ts`, `finanzas.controller.ts`, `finanzas-core.module.ts`: integración de reclamos y nuevas acciones.
- `src/finanzas/entities/reembolso.entity.ts`, `reembolso-evento.entity.ts`, `venta-pago.entity.ts`: auditoría y clasificación de pagos.
- `src/finanzas/finanzas-ledger.service.ts`, `finanzas-calc.ts`, `finanzas-analisis.service.ts`: cobros, caja, deuda y reportes.
- `src/venta/venta.service.ts`, `venta.controller.ts`, `venta.entity.ts`, `dto/create-venta.dto.ts`: venta y aplicación en una sola transacción, cliente y bloqueo de productos afectados.
- `docs/RECLAMOS_SALDOS.md`: esta auditoría.

Frontend:

- `src/components/finanzas/ReembolsosProducto.js` y `.test.js`: formulario reducido y confirmación de reembolso.
- `src/components/finanzas/SaldoClienteVenta.js` y `.test.js`: comprador, saldo, historial, aplicación, diferencia y confirmaciones.
- `src/components/finanzas/PagosVenta.js`, `FinanzasPanel.js`: integración en pagos y resumen financiero.
- `src/components/ModalVenta.js`, `DetallesProductoModal.js`: integración con los formularios actuales.
- `src/services/finanzas.js`: endpoints e invalidación de vistas.
- `src/components/ModalVenta.audit.test.js`: actualización del mock de sesión para la nueva integración.

## Verificación ejecutada

- Backend existente: 47 suites, 434 pruebas aprobadas.
- Integración nueva: 29 pruebas aprobadas con PostgreSQL 15 real, incluida migración desde tablas sin las nuevas columnas, concurrencia, integridad de Gastos y reversión de venta/aplicación fallida.
- Frontend completo: 71 suites, 432 pruebas aprobadas, incluidas las cinco nuevas pruebas de interfaz.
- TypeScript: comprobación sin emisión y compilación con `tsconfig.build.json` a `../tmp/backend-reclamos-build` aprobadas.
- Frontend: build de producción aprobado.
- El primer `npm run build` del backend encontró `ENOTEMPTY` al limpiar el directorio compartido `dist`; se verificó la compilación en una carpeta aislada sin borrar ese directorio.

Comandos principales:

```powershell
# Desde servicios
npm --prefix backend test -- --runInBand --testPathIgnorePatterns=reclamos-saldos.integration
$env:RECLAMOS_SALDOS_TEST_URL='postgres://codex_test@127.0.0.1:55439/reclamos_saldos_test'
npm --prefix backend test -- --runInBand reclamos-saldos.integration
$env:CI='true'
npm --prefix frontend-tailwind test -- --watchAll=false --runInBand
npm --prefix frontend-tailwind run build
npm run index:update
npm run index:verify
```

La suite de integración rechaza cualquier conexión distinta de la instancia desechable indicada. Inicializa y vacía únicamente esa base de prueba. Para reproducirla, crear un clúster temporal con `initdb -U codex_test -A trust`, iniciarlo en localhost con puerto 55439 y crear `reclamos_saldos_test`. No usar el servidor habitual ni su configuración.

## Límites verificados y operación inicial

- La BD local de pruebas ya está sincronizada. Producción permanece sin cambios.
- Los pedidos antiguos con Gonzalo (Nombre) se vinculan automáticamente al abrir sus pagos; si hay dos identidades externas con el mismo nombre normalizado, se exige resolver la ambigüedad en lugar de mezclar su dinero.
- Se necesita una compra con importe original USD y cambio histórico para abrir este reclamo; no se inventa una conversión cuando falta esa información.
- La cuenta receptora se solicita al confirmar el reembolso porque las compras antiguas no siempre tienen enlazado un cargo bancario inequívoco.
- Para convertir pagos a saldo se exige que estén confirmados, fechados, sin disputa y sin liquidaciones pendientes. Los pagos anteriores sin conciliar requieren primero la conciliación existente.
- Una venta cubierta con saldo no puede reconvertirse automáticamente en otro saldo ni anularse de forma aislada: se bloquea para preservar sus fuentes e historial. No se implementó una reversión de aplicaciones ni una cadena de reemplazos sucesivos.
- El historial se consulta integrado en Ventas; no se creó una página independiente de Clientes.
- Se verificaron componentes con React Testing Library y el build; no se realizó revisión manual de pantalla en el navegador.

El índice se actualizó y su verificación devolvió fidelidad correcta (ok: true). Conserva dos diagnósticos del analizador en src/pages/Analisis.js, líneas 5089 y 5126, archivo ajeno al cambio; el build de frontend pasó.


## Corrección del flujo local y del cliente del pedido

La configuración inicial tenía DB_SYNC sin definir y faltaban las entidades de las tablas nuevas. Se corrigió con synchronize local por defecto, bandera local explícita, tres entidades nuevas y preparación idempotente de triggers al arrancar. Se ejecutó db:sync:local contra la BD de pruebas configurada sin borrar registros ni correr migraciones.

Archivos adicionales: src/db/local-schema.ts, local-schema.spec.ts, saldos-clientes-schema.ts; src/scripts/sync-local-database.ts; src/finanzas/entities/cliente-comercial.entity.ts, cliente-saldo.entity.ts y cliente-saldo-movimiento.entity.ts; src/venta/pedido-cliente.ts; registro de entidades, main.ts y app.module.ts; resolver de pedidos y componente SaldoClienteVenta. El flujo local queda documentado también en AGENTS.md, docs/ARCHITECTURE.md y docs/CODE_INDEX.md del workspace y en la skill de implementación.

Las pruebas de integración ahora preparan su esquema exclusivamente con synchronize y el arranque local, sin ejecutar la migración. Se añadieron casos de sincronización repetida sin pérdida de saldo, resolución concurrente de Gonzalo (Jorge), reutilización del ID previo y creación de una venta de Jorge sin un selector de cliente adicional.

Validación de la corrección: 442 pruebas generales del backend, 31 pruebas de integración con esquema creado mediante synchronize y 26 pruebas de interfaz relacionadas aprobadas. Compilación TypeScript y build de producción del frontend aprobados. El comando db:sync:local se ejecutó correctamente contra la BD local de pruebas configurada; la ruta de resolución de pedidos ya está disponible en la API local.


## Pagos históricos y conversión desde la venta de reemplazo

Se corrigió un caso donde el producto estaba cerrado por incidencia, la venta comercial seguía activa y el pago original permanecía en Gastos con referencia __SALE_INCOME__:producto, todavía sin cliente_id/pago enlazados. El historial descubre esos pedidos del cliente y sus ingresos mediante referencias exactas, muestra el importe recibido y ofrece convertir la venta afectada desde el formulario de la nueva venta. El cierre de producto por sí solo sigue sin generar dinero a favor automáticamente.

Al confirmar, la vinculación del ingreso existente, la conciliación, el pago de ledger y el saldo se guardan en una sola transacción. Se conservan importe, ID y fecha del ingreso original; no se crea otro ingreso de Gastos. Una falla revierte también la vinculación. El importe convertible se calcula desde dinero recibido y nunca desde precio menos deuda en una venta cancelada. El historial usa consultas por lote para no hacer varias consultas remotas por cada venta.

Anular venta para un pedido pagado ofrece conservar el importe como saldo y exige confirmación. El endpoint de anulación que retiraba cobros rechaza pedidos con dinero recibido: deben usar la conversión que conserva pagos e ingreso. La venta de reemplazo muestra Aplicar saldo a favor después de confirmar la conversión y registrar su precio.

Verificación de esta corrección: 35 escenarios de integración PostgreSQL, 33 pruebas de interfaz relacionadas y 32 regresiones de anulación/auditoría/cálculos aprobados; comprobación sobre la BD de pruebas configurada de solo lectura, sin convertir automáticamente su dinero ni registrar pagos nuevos.

## Flujo simplificado vigente

El historial visible se titula Historial de [cliente] y contiene únicamente fuentes y movimientos de saldo de ese cliente. Se retiraron el listado general de ventas/pagos/deudas, los botones de conversión manual y el campo Motivo de origen.

Anular una venta de pedido con pagos genera el saldo en la misma transacción, sin un segundo formulario. Registrar un reembolso recibido ejecuta la misma compensación para las ventas externas del producto. El importe proviene de los pagos reales del cliente, nunca del importe del reembolso del proveedor. Un bloqueo por venta evita duplicados cuando anulación y reembolso ocurren simultáneamente. Los motivos de auditoría se generan internamente.

Se regularizó en la BD local de pruebas el caso ya reembolsado indicado por el usuario, usando el evento de reembolso existente, su fecha y su actor registrados. Se verificó que el ingreso original conserva su ID, importe y fecha; no se creó otro ingreso de Gastos. La nueva venta sigue requiriendo elegir Aplicar saldo a favor para usar el dinero. Esta sección sustituye el flujo anterior de conversión manual descrito como parte del diagnóstico histórico.

Verificación del flujo simplificado: 70 pruebas backend relacionadas (incluidas 38 de integración PostgreSQL y concurrencia de anulación/reembolso), 32 pruebas de interfaz relacionadas, TypeScript y build de frontend aprobados. Se añadió protección frente a respuestas tardías al cambiar el cliente para evitar mostrar el historial de un cliente anterior.


## Tipo de cambio histórico al aplicar saldo

Una venta nueva con saldo no pide ni necesita tipoCambio en el formulario/DTO. Antes de crearla, el servidor bloquea al cliente y sus fuentes, distribuye el importe usado por FIFO y obtiene el TC de esas fuentes. El saldo conserva el TC de la venta original, independientemente de una tasa bancaria distinta en el pago original. El tipo enviado manualmente por el navegador no sustituye el cálculo del servidor.

Cuando intervienen varios orígenes, cada tramo conserva su importe y TC; el TC equivalente es PEN usados dividido entre la suma de sus equivalencias USD históricas. No se promedian tipos de cambio de fuentes no consumidas. Se calcula con enteros BigInt y equivalencias de seis decimales antes de redondear el TC a cuatro decimales, para no perder dinero por redondear cada tramo a centavos. Ejemplo: S/1000 a 3.40 y S/500 a 3.60 equivalen a USD433.006536, con TC equivalente 3.4642. Los S/500 restantes del segundo origen conservan su TC3.60.

La interfaz muestra el TC automático y el detalle de SKU, importe aplicado y TC por tramo. El pago con origen saldo_cliente guarda ese cambio como referencia; las aplicaciones siguen vinculadas a sus fuentes y no producen un ingreso bancario nuevo. Los importes adicionales pagados o pendientes mantienen sus importes PEN independientes. El cálculo se comparte conceptualmente entre la vista previa y el servidor, siendo este último la autoridad transaccional.

Archivos: src/finanzas/saldo-cambio.ts y su spec, SaldosClientesService.prepararCambioSaldo, VentaService.create y CreateVentaDto; frontend utils/saldoCambio.js y sus pruebas, SaldoClienteVenta y ModalVenta. No se necesitan cambios de esquema ni migraciones para esta corrección. Verificación: 45 pruebas backend de integración/cálculo y 28 de interfaz relacionadas aprobadas, incluido guardar una venta sin tipo de cambio manual y rechazar la sustitución del TC histórico por un TC enviado por el cliente.
