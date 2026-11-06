# Selección de accesorios para el catálogo comercial

## Uso

Como administrador, abrir **Inventario → Accesorios → botón Catálogo de accesorios**. La administración se abre en un modal amplio con desplazamiento propio, cierre con Escape, botón cerrar y clic fuera. Las tarjetas del inventario conservan su espacio en la página. Los datos del catálogo se precargan al entrar en Accesorios y se conservan al cerrar el modal: abrirlo de nuevo no repite la consulta. Los cambios del inventario y las acciones del catálogo actualizan los datos.
El modal separa **Pendientes de enviar** y **Enviados al catálogo** según el envío confirmado. Los fallos y envíos pendientes permanecen en la primera sección; un retiro pendiente sigue entre enviados hasta su confirmación. No se muestra el comprador. La búsqueda acepta nombres y códigos ACC. La asignación interna por comprador se conserva para no mezclar lotes.
Cada fila permite enviar, retirar y completar su ficha. Solo se pueden enviar accesorios con stock disponible mayor que cero y ficha completa, tanto individualmente como en grupo; el servidor vuelve a validar la disponibilidad. Un envío fallido tampoco se da de alta con stock cero al reintentarlo. Los accesorios ya enviados siguen notificando su agotamiento y pueden retirarse aunque tengan stock cero.

Se requiere nombre, comprador, precio publicado positivo y foto con URL HTTP(S). Las referencias deben estar activas. Para referencias se reutiliza el editor de precios/foto; para accesorios antiguos se abre la ficha de inventario existente. No se crean nuevos accesorios ni referencias por publicar.

## Mecanismo existente y ampliación

El envío de equipos vive en `ProductoService.syncDisponiblesConCatalogo`: consulta elegibilidad y existencia por SKU, envía `product.listed` a `CATALOG_SYNC_URL`, con `catalogSyncHeaders`, y guarda `catalogoEnviado`. El receptor real es `PaginaCatalogo/backend/src/modules/sync/sync.controller.ts`. Su protección de publicaciones existentes impide usar el alta de equipos para actualizar o retirar accesorios. El catálogo Apple y `app_catalog_items` no participan en esta integración.

Se amplía **el mismo endpoint comercial**, autenticación y tablas remotas `products`, `staged_products` y `catalog_public`, mediante `accessory.snapshot`. El receptor conserva el comportamiento protegido de los equipos y administra únicamente el namespace `acc-*` mediante este evento. SKU y UUID deterministas, restricciones existentes y transacciones evitan duplicados. No hay un segundo catálogo.

`accesorio_catalogo` guarda solo preferencia, último snapshot confirmado, hash, fecha y error; no sustituye productos ni inventario. Sus columnas se declaran en `AccesorioCatalogo` para synchronize local. La migración de producción es idempotente. La BD local se preparó con `npm --prefix backend run db:sync:local`.

## Stock y sincronización

Se reutiliza `AccesoriosService.operativo` y sus reglas `accessoryAvailable`, `accessoryInventoryIdentity` y `resolveAccessoryPrices`. La publicación agrupa **referencia y comprador**, igual que la asignación existente de ventas. Una referencia con varios compradores conserva una publicación por comprador: no se mezclan sus stocks ni ganancias. Los accesorios antiguos conservan el agrupamiento existente por código/foto/comprador y se identifican mediante el menor ID de lote del grupo.

No se publican lotes separados dentro de un grupo. Se usa stockActual vendible; se excluyen lotes archivados, cerrados e importaciones aún sin recoger. Las reglas FIFO, costos y distribución de ventas no cambian. La integración entrante resuelve los SKU nuevos al lote del comprador correcto y sigue llamando a VentaService.

El servicio revisa cada 30 segundos y al seleccionar o pulsar actualizar. Solo envía hashes distintos al último confirmado. Un lock transaccional coordina instancias; los envíos tienen timeout y los fallos conservan la intención para reintentar, incluso después de reiniciar. Cambiar campos de un formulario no dispara solicitudes de sincronización. Si un grupo desaparece o su ficha deja de ser válida, se retira su publicación y se conserva su selección para recuperarla al corregir los datos.

Las ventas iniciadas en el catálogo aún sin confirmar se restan allí del stock recibido. El snapshot incluye los IDs de ventas ya confirmadas en Servicios para evitar un segundo descuento. Las reservas del catálogo siguen descontándose mediante su mecanismo existente. Agotado conserva la selección; la disponibilidad pública aplica las reglas existentes del catálogo. Retirar pone stock público en cero y despublica, sin borrar movimientos ni ventas.

Los accesorios previamente enviados automáticamente por lote se reconcilian como no seleccionados y sus SKU MS antiguos se retiran, conservando los registros históricos. Solo se retiran SKU antiguos cuya ficha remota corresponde a accesorios.

## Privacidad y permisos

Listar y modificar esta configuración requiere JWT con rol admin. El receptor exige el secreto compartido existente. Se transmiten únicamente nombre, SKU, precio comercial en PEN, estado, foto, compatibilidad y disponibilidad, además de identificadores técnicos para reconciliar ventas. No se transmiten costos, mínimos privados, márgenes, proveedores ni objetos de inventario completos. El receptor vuelve a construir su lista permitida de datos.

## Archivos de esta implementación

Backend Servicios:

- `src/accesorios/accesorio-catalogo.entity.ts` (nuevo)
- `src/accesorios/accesorios-catalogo.controller.ts` (nuevo)
- `src/accesorios/accesorios-catalogo.service.ts` (nuevo)
- `src/accesorios/accesorios-catalogo.service.spec.ts` (nuevo)
- `src/accesorios/accesorios.module.ts`
- `src/catalog-sales-integration/catalog-sales-integration.service.ts`
- `src/catalog-sales-integration/accessory-sku.spec.ts` (nuevo)
- `src/producto/producto.service.ts`
- `src/producto/producto.service.spec.ts`
- `src/auth/commercial-http.spec.ts`
- `src/migrations/1793740000000-AccesorioCatalogo.ts` (nuevo)
- `docs/ACCESORIOS_CATALOGO.md` (este documento)

Frontend Servicios:

- `src/components/AccessoryCatalogPanel.js` (nuevo)
- `src/components/AccessoryCatalogPanel.test.js` (nuevo)
- `src/components/AccessoryReferenceEditor.js` (extraído del editor existente)
- `src/components/AccessoryOperations.js`
- `src/pages/Inventario.js`

Receptor comercial, repositorio vecino PaginaCatalogo/backend:

- `src/modules/sync/sync.controller.ts`
- `src/tests/sync-accessories.test.ts` (nuevo)

## Validación y operación

Pruebas sin publicaciones reales ni pruebas destructivas contra la BD configurada:

- Backend Servicios: suites de accesorios, productos, integración de ventas y permisos HTTP comerciales.
- Frontend: AccessoryCatalogPanel, AccessoryOperations e Inventario.
- Receptor: sync-accessories, sync-inventory-fields, perf-security, security-phase1 y sales-sync-edit.
- Compilación de ambos backends y build optimizado del frontend.
- Índices de ambos workspaces actualizados y verificados. El índice de Servicios informa dos diagnósticos preexistentes en Analisis.js.

Se deben ejecutar/desplegar **ambos backends con esta versión**. Se conservan las variables actuales CATALOG_SYNC_URL y CATALOG_SYNC_SECRET. No se modificó configuración de producción ni se publicó inventario real durante las pruebas. El receptor antiguo no confirma accessorySnapshot y el emisor muestra el error correspondiente. La migración es para el despliegue de producción; local ya usa synchronize.

## Corrección: envío a preparación

Enviar no publica en la web. Solo los accesorios elegidos llegan como borrador al inventario de preparación del catálogo. No se exige ni se transmite la foto de Servicios: se sube en el catálogo para aplicar marca de agua. El receptor conserva los precios, tipos de venta, notas y fotos locales al actualizar stock. Las etiquetas de este panel indican “Enviado a preparación”, no “Publicado”. El barrido general del catálogo no importa accesorios. Las publicaciones automáticas anteriores se retiran con el siguiente snapshot; las publicadas manualmente se conservan.
