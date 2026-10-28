# Catálogo Apple: EveryMac + AppleDB + dataset propio

Estado al 2026-10-23. Código en `backend/src/apple-catalog`, consumo en `frontend-tailwind/src/services/appleCatalog.js` y `components/formParts/CatalogModelFields.js`. Cobertura real en [APPLE_CATALOG_COVERAGE.md](APPLE_CATALOG_COVERAGE.md).

## 0. Cambios del 2026-10-23

- **Formulario en cascada**: MacBook = Modelo (Air / Pro / Neo) → Procesador → Pantalla → RAM → Almacenamiento. iPad = Modelo (iPad / mini / Air / Pro) → Generación o Procesador → Pantalla → Almacenamiento → Conectividad. iPhone = Número → Modelo → Almacenamiento. Watch = Modelo (Series / SE / Ultra) → Serie → Caja → Conectividad. iMac / Mac mini = Procesador → (Pantalla) → RAM → Almacenamiento. AirPods = Modelo → ANC o edición. Una sola opción se completa sola (p. ej. MacBook Neo → A18 Pro).
- **Fichas EveryMac** (importación autorizada por EveryMac al titular): semilla de 168 fichas leídas una sola vez (`data/everymac-seed.data.ts`, solo valores estructurados con su URL) y alta de productos nuevos pegando enlaces en Servicios → «Agregar productos desde EveryMac» (vista previa → importar). Las fichas importadas se guardan en `app_catalog_items` (`kind = apple_everymac_page`); los formularios nunca consultan EveryMac.
- **Alcance comercial**: los selectores solo ofrecen los modelos con ficha EveryMac o marcados `listed` en el dataset. Lo demás que descubre AppleDB queda consultable (productos antiguos siguen resolviéndose) y se lista como «lanzamientos detectados sin ficha cargada».

## 1. Qué hay y qué no

| Capa | Qué es | Automatizado |
| --- | --- | --- |
| Catálogo local operativo | Catálogo consolidado servido por `/apple-catalog/*` desde memoria (caché por versión). Formularios de Productos e Inventario lo usan sin consultar proveedores. | Sí (lectura local). |
| Fichas EveryMac | Chip y núcleos, pantalla comercial y diagonal, RAM y SSD (estándar + configurables, un bloque por ficha para no inventar combinaciones), conectividad, caja del Watch, números A, identificadores y códigos de pedido. Prioridad: anulación > ficha oficial Apple > EveryMac > curado/reglas > AppleDB. | Semi: una persona pega los enlaces; la lectura, validación y guardado son automáticos. |
| Sincronización AppleDB | Lectura del JSON público y gratuito `device/main.json` + `group/main.json` (MIT, sin clave). Descubre modelos, identificadores (Axxxx, `Mac14,2`), variantes y colores. | Sí: programada (por defecto cada 24 h) y botón «Actualizar ahora». |
| Dataset complementario propio | `src/apple-catalog/data/apple-specs.dataset.ts`: capacidades, pantallas, RAM/SSD válidos, ANC, IMEI, batería, conflictos. Cada hecho lleva procedencia. | **No**. Es una carga manual curada (versión `2026.10.22-1`). Se publican versiones nuevas editando el archivo o importando JSON (`/apple-catalog/dataset/publish`). |
| Anulaciones administrativas | Correcciones verificadas, justificadas y bloqueadas por campo (`/apple-catalog/overrides`). Una anulación cuyo modelo desapareció se reporta como conflicto. | Manual. |
| Modelos manuales | Entrada del dataset con `tipo`, `title` y `detalle` para un lanzamiento que AppleDB aún no publica; pasa por la misma validación/previsualización y queda marcada `manual_dataset_model`. | Manual. |

No hay adaptadores ni llamadas a APIs de pago. No se identifica una unidad por serial: AppleDB solo recibe claves de modelo; las consultas de unidad (SICKW) siguen separadas y no se lanzan automáticamente.

## 2. Decisiones de modelo

- **Modelo comercial** (`AppleCatalogModel`): lo que se elige en Productos (p. ej. `iPad Air (M2)`, `AirPods 4 con ANC`). ID interno estable (`ipad-air-m2`), alias con procedencia, Axxxx, identificadores de sistema, códigos de pedido, chip, fechas.
- **Variante** (`AppleCatalogVariant`): conectividad y/o tamaño que cambia IMEI o identificadores (Wi‑Fi/Cellular, GPS/GPS + Cellular, 42/46 mm, 11"/13"). Las regiones de iPhone (US/Global) se fusionan; las piezas AirPods (izquierdo/derecho/estuche) son componentes del conjunto, **no** unidades de stock.
- **Unidad física**: ficha de Inventario (serial, IMEI, color, batería). Añadir modelos al catálogo nunca crea existencias ni ventas.
- **Reglas de agrupación por familia** (AppleDB no agrupa igual): iPhone = dispositivo (regiones fusionadas); iPad = grupo, Air/Pro con el mismo chip se fusionan y la pantalla pasa a selector; Watch = grupo (caja × conectividad como variantes); AirPods = grupo (edición); Mac = familia + chip, tamaño como variante.
- **Persistencia sin cambio de esquema**: el catálogo vive en `app_catalog_items` (columna `metadata` JSONB existente) con `kind` nuevos: `apple_catalog_state`, `apple_catalog_snapshot` (se conservan 3), `apple_specs_dataset`, `apple_catalog_override`. `/catalog/product-options` y los conceptos de gastos no cambian; `DELETE /catalog/items/:id` ya no puede desactivar filas `apple_*`.
- **Identidad del producto**: se guarda por valor en los campos existentes de `producto_detalle` (`gama`, `procesador`, `generacion`, `numero`, `modelo`, `tamano`, `almacenamiento`, `ram`, `conexion`) con los valores canónicos del modelo (`detalle` + `detalleAliases` para formatos previos, p. ej. iPad (A16) = `generacion: '11'`). Eso es la instantánea: actualizar el catálogo no reescribe productos vendidos. No se añadió columna `catalogRef` porque `detalle` es `eager` y una columna inexistente en producción rompería todas las lecturas de productos. Resolución: `resolveProductModel` → `exact | ambiguous | unknown` con candidatos.
- **Desconocido ≠ no aplicable ≠ confirmado**: `fieldStatus` por campo; un selector `unknown` permite registrar un valor marcado «pendiente de revisión»; un campo no aplicable no se muestra ni se acepta como valor nuevo.
- **Prioridad**: anulación administrativa > dataset (oficial / curado / reglas previas) > AppleDB > desconocido. Los desacuerdos quedan en `conflicts` (abiertos o resueltos con fuente oficial), nunca se eligen en silencio.

## 3. Matriz de capacidades (fuente única: `device-capabilities.ts`)

| Familia | Selectores tras elegir modelo | No se muestran ni aceptan como valor nuevo | IMEI | Batería (salud / ciclos) |
| --- | --- | --- | --- | --- |
| iPhone | Almacenamiento | RAM, pantalla, conexión | 2 (IMEI e IMEI2; dato curado iPhone XS/XR+) | nativa / nativa en 15+, manual en anteriores |
| iPad | Pantalla, almacenamiento, conectividad (Wi‑Fi / Wi‑Fi + Cellular) | RAM | 0 Wi‑Fi, 1 Cellular | nativa solo Pro M4/M5, Air M2+, mini A17 Pro, iPad A16 (ficha 117759); resto manual con procedencia |
| Apple Watch | Tamaño de caja (mm), GPS / GPS + Cellular | RAM, almacenamiento | 0 GPS, 1 Cellular | nativa / no aplica |
| MacBook | Pantalla, RAM, SSD (combinaciones vendidas por chip) | conexión, eSIM | 0 | nativa / nativa |
| iMac | Pantalla, RAM, SSD | conexión, eSIM | 0 | no aplica |
| Mac mini | RAM, SSD | pantalla, conexión, eSIM | 0 | no aplica |
| Otros equipos (`otro`) | Descripción libre | — | desconocido: IMEI/IMEI2 opcionales (si se informan, 15 dígitos + Luhn), nunca requeridos | manual opcional |
| AirPods / Pro / Max | Generación → edición (ANC solo si la generación tiene versiones con y sin ANC documentadas) | RAM, almacenamiento, pantalla, chip, conexión | 0 | no se registra (nivel de carga es otra magnitud) |

Reglas comunes: una opción única comprobada se autocompleta y se guarda; un equipo `nuevo` (sellado) no muestra inspección de batería y conserva el flujo previo (limpia esos campos al guardar); la RAM de iPhone/iPad/Watch puede existir como metadato de AppleDB pero nunca es selector ni dato comercial. EID no es IMEI 2.

## 4. Contratos API (JWT; admin donde se indica)

| Método y ruta | Uso |
| --- | --- |
| `GET /apple-catalog/forms[?tipo=]` | Contrato completo de formularios: `{version, dataset, families{tipo:{selectors,hiddenFields}}, models[]}`. Una petición compartida por sesión (`api.get` con `maxAgeMs` 10 min). |
| `GET /apple-catalog/models?q=&tipo=&page=&pageSize=` | Búsqueda paginada (título, alias, Axxxx, identificador, código de pedido). |
| `GET /apple-catalog/models/:id` | Modelo con variantes, selectores, colores, capacidades, procedencia y conflictos. |
| `GET /apple-catalog/identify?q=` | Candidatos desde Axxxx / código de pedido / identificador. Axxxx compartido → `ambiguous`; nunca rellena RAM/SSD mínimos. |
| `POST /apple-catalog/resolve` `{tipo, detalle}` | Resolución exacta/ambigua/desconocida y selecciones inválidas. |
| `GET /apple-catalog/sync/status` (admin) | Fuente, periodicidad, latencia esperada, versión, última ejecución/éxito/error, instantáneas. |
| `POST /apple-catalog/sync` (admin) | «Actualizar ahora». |
| `GET /apple-catalog/coverage` (admin) | Cobertura por familia/campo, clasificación, conflictos, modelos a revisar. |
| `GET /apple-catalog/reconcile?limit=` (admin) | Informe **dry-run** de productos existentes: exacto, ambiguo, desconocido, inválido y propuestas inequívocas. No escribe. |
| `POST /apple-catalog/dataset/preview` / `publish` (admin) | Validar y previsualizar diferencias; publicar una versión posterior (idempotente). |
| `GET/POST /apple-catalog/overrides`, `DELETE /apple-catalog/overrides/:id` (admin) | Anulaciones: `{modelId, field, value, reason, sourceUrl}`; campos admitidos: `title, detalle, retired, anc, colors, macCombos, imeiCount, battery, selectors.*`. |

Cambios en contratos existentes (compatibles): `GET /inventario` y `GET /inventario/producto/:id` añaden `reglas` por fila (calculadas en memoria con una sola carga del catálogo, sin N+1); `PATCH /inventario/:id` acepta `exigirCompleta` y devuelve además `avisos` y `completitud`; `POST/PATCH /productos` rechazan `detalle` incompatible.

## 5. Validación en backend

- **Productos (alta y lote)**: familia del catálogo → el modelo debe resolverse de forma exacta; selecciones dentro de las opciones; combinaciones RAM/SSD vendidas; sin valores en campos no aplicables; opción única comprobada obligatoria (p. ej. pantalla del mini). **Edición**: solo se valida lo que cambia; valores legados sin cambios se conservan con aviso.
- **Inventario**: IMEI = 15 dígitos + Luhn (texto, ceros iniciales preservados; checksum ≠ autenticidad); IMEI1 ≠ IMEI2; IMEI rechazado en variantes sin celular; serial normalizado (mayúsculas, sin espacios, 5–24 alfanuméricos, sin patrón rígido); color dentro de los acabados del modelo cuando el modelo está resuelto; salud/ciclos rechazados donde no aplican. Valor legado incompatible que no cambia → se conserva y se devuelve en `avisos`. Duplicados de IMEI/serial en otra unidad **activa** → 409; en registros vendidos/archivados/cerrados → aviso de posible reingreso.
- **Borrador vs ficha completa**: guardar siempre permite borrador; `exigirCompleta: true` exige los campos requeridos por el modelo (serial; IMEI/IMEI2 según variante; color cuando hay varios acabados). La completitud se calcula, no se almacena.
- **OCR**: solo ofrece destinos aplicables; nunca asigna IMEI a un modelo sin IMEI; no pisa valores confirmados.

## 6. Sincronización AppleDB

- Configuración (solo backend, sin claves): `APPLE_CATALOG_SYNC_INTERVAL_HOURS` (defecto 24; `0` desactiva), `APPLE_CATALOG_SYNC_FIRST_DELAY_MS` (defecto 5 min tras arrancar), `APPLE_CATALOG_FETCH_TIMEOUT_MS` (defecto 30 s). Desactivada con `NODE_ENV=test`.
- Flujo: `pg_try_advisory_lock` (una réplica a la vez) → GET con `If-None-Match`/`If-Modified-Since` (304 = sin cambios) → 3 intentos con espera → minimiza a familias Apple relevantes → valida (feed vacío, caída >20 % o familia vacía ⇒ `rejected`, se conserva la versión válida) → modelos desaparecidos se **retienen** consultables (`retired`) → hash SHA‑256 (respaldo del ETag) → publica en transacción con `pg_advisory_xact_lock`; repetir no duplica (`unchanged`). Tipos AppleDB nuevos no clasificados quedan en `pendingReview`.
- Latencia: AppleDB es comunitario; un lanzamiento aparece cuando la fuente lo publica y se detecta en la siguiente ejecución (≤ intervalo) o con «Actualizar ahora». No hay inmediatez garantizada.
- Línea base: sin instantánea publicada se usa `data/appledb-baseline.data.ts` (subconjunto congelado el 2026-10-23, regenerable con `npm run apple-catalog:baseline`). Licencia y aviso en `data/APPLEDB_LICENSE.txt`. No se importan imágenes.

## 7. Despliegue

1. **Esquema**: no requiere SQL ni migraciones. Solo usa la tabla existente `app_catalog_items` (`kind varchar(40)`, `metadata jsonb`). No se añadieron migraciones en `src/migrations` (que `start:deploy` ejecutaría) ni columnas en entidades. No activar `DB_SYNC`.
2. Desplegar backend (nuevo módulo `AppleCatalogModule`) y luego frontend. El orden inverso también funciona salvo que los formularios mostrarían error de carga del catálogo hasta que el backend esté actualizado.
3. Opcional: definir `APPLE_CATALOG_SYNC_INTERVAL_HOURS`. La primera sincronización corre a los 5 min; o pulsar «Actualizar ahora» en Servicios (admin) → «Catálogo Apple».
4. Ejecutar `GET /apple-catalog/reconcile` (admin) y revisar los productos ambiguos/desconocidos/inválidos antes de exigir fichas completas. No hay aplicación automática de propuestas.
5. Salida de red requerida desde el backend: `https://api.appledb.dev` (GET).

## 8. Pruebas ejecutadas

- Backend `npm test -- --runInBand`: 36 suites, 294 pruebas en verde (nuevas: `apple-catalog.consolidator.spec`, `apple-catalog.resolver.spec`, `device-capabilities.spec`, `apple-catalog.service.spec`, ampliación de `inventario.service.spec`). `npm run build` OK.
- Frontend `CI=true npm test -- --watch=false --runInBand`: 56 suites, 335 pruebas; `CI=true npm run build` OK.
- Lectura real del endpoint: `npm run apple-catalog:coverage` (1.959 entradas, etag usado). Las pruebas usan fixtures congelados, no red.
- Fixtures del frontend (`src/__fixtures__/appleCatalogForms.json`, `appleCatalogIdentity.json`) se generan desde el backend; regenerarlos si cambia el contrato. Pruebas reescritas a propósito: `appleModelLookup.test.js` (la regla «completa RAM/SSD mínimos» contradecía el requisito), `FormProductoWatch.test.js` y `FormProductoMacDesktop.test.js` (ahora leen el catálogo mediante `api` simulado; fixture `src/__fixtures__/appleCatalogForms.json` generado del backend).

## 9. Límites y pendientes

- Huecos exactos: almacenamiento de iPhone 17e; RAM/SSD de MacBook Pro M5 Pro/M5 Max y Mac mini M5 Pro/M6 (se registran como «sin datos verificados»).
- La mayoría de capacidades/RAM/SSD están como `curated` o `project_rules`: publicadas, pero **pendientes de contraste oficial** (ver columnas Oficial/Curado de la cobertura). Oficial verificado: Mini 5/6, Ultra 2/3, Watch Series 10/11/SE 2/SE 3 (números A), MacBook Pro M1 13", colores MacBook Pro, Air M5 (pantallas, SSD, colores), AirPods 4/5/Pro/Max (ANC), salud de batería de iPad, iPhone 18 Pro/Pro Max/Duo (almacenamiento).
- Conflictos abiertos: números A del Air M5 13"/15" (AppleDB vs reglas previas), almacenamiento del Air M1 (128 GB en reglas previas), edición de estuche de AirPods 3. Corregidos con fuente oficial: números A de Watch Series 10 y SE 2 (las reglas previas eran erróneas).
- `iPhone Duo` requiere revisar su `numero` comercial. Mac Studio y Mac Pro están en el catálogo pero sin `producto.tipo` (fuera de selectores).
- Colores de muchos modelos provienen solo de AppleDB (no contrastados oficialmente). Accesorios por cantidad, accesorios incluidos y su normalización no cambiaron; la compatibilidad estructurada de accesorios queda como diseño extensible pendiente.
- No se probó la aplicación en ejecución contra una BD real (no se inició para no conectar con producción). Las dos consultas SQL nuevas (duplicados de IMEI/serial en `InventarioService` y el informe `reconcile`) solo se probaron con dobles en Jest: pendientes de una prueba de humo en una BD no productiva.
- Títulos enviados al catálogo de clientes (`buildTitle`/`buildCatalogDetalle`): iPad muestra la generación como «N.ª gen.» y la pantalla en pulgadas, AirPods usa la edición completa y la RAM solo se publica en Mac. Se aplica en la próxima sincronización de ese catálogo.

## 10. Importación desde EveryMac

- **Endpoints (admin)**: `POST /apple-catalog/everymac/preview {urls}` (lee y muestra, no guarda), `POST /apple-catalog/everymac/import {urls}` (guarda), `GET /apple-catalog/everymac` (semilla + importadas), `DELETE /apple-catalog/everymac/:id` (quitar una ficha), `GET /apple-catalog/pending` (lanzamientos de AppleDB sin ficha).
- **Uso responsable**: solo enlaces `https://everymac.com/systems/apple/...html`, máximo 25 por envío, una petición por enlace con pausa mínima de 2 s, agente de usuario identificable (`MacsomenosCatalogImport/1.0`), caché de 15 min para que vista previa e importación no repitan la descarga. No se guarda HTML ni textos descriptivos, solo valores y la URL de origen.
- **Configuración** (opcional): `EVERYMAC_IMPORT_ENABLED=false` desactiva la importación; `EVERYMAC_MIN_INTERVAL_MS`, `EVERYMAC_FETCH_TIMEOUT_MS`, `EVERYMAC_USER_AGENT`.
- **Lanzamiento nuevo** (p. ej. MacBook Air M6): pegar los enlaces de sus fichas (una por pantalla/configuración) → Previsualizar → Importar. El modelo aparece en el formulario en cascada (Air → M6 → pantallas/RAM/SSD de esas fichas) sin tocar código ni redesplegar.
- **Regenerar la semilla** (opcional, con las páginas ya descargadas una vez en una carpeta): `npm run apple-catalog:everymac-seed -- <carpeta>`.
- **Sin cobertura en EveryMac**: AirPods (siguen con AppleDB + dataset propio).

## 11. Alcance cargado (2026-10-23) y puntos a validar

- MacBook Air M1–M5 y Neo; MacBook Pro M1 en adelante (M1–M5 con Pro/Max); iMac M1/M3/M4; Mac mini M1/M2/M2 Pro/M4/M4 Pro/M5 Pro/M6.
- iPad 9.ª, 10.ª y A16; iPad mini 6 y A17 Pro; iPad Air 4.ª gen., M1, M2, M3, M4; iPad Pro M1, M2, M4, M5.
- iPhone 11 a 18 Pro Max, 16e, 17e, Air y Duo (las formas anteriores del formulario cubrían 11–17).
- Apple Watch Series 10, 11 y 12; Ultra 2, 3 y 4 (sin ediciones Hermès).
- AirPods 3, 4 (con/sin ANC), 5 (y con estuche inalámbrico), Pro 2 (Lightning y USB-C), Pro 3, Max (Lightning, USB-C) y Max 2.
- **Por confirmar**: Apple Watch SE 3 (posterior a la Series 10 pero no pedido), iPhone SE 2/3, Mac Studio (no hay tipo de producto), ediciones Hermès del Watch. Se pueden añadir importando sus enlaces o marcando `listed`.
- Las variantes de núcleos (p. ej. M4 Pro 12/14 núcleos) no son un selector: se respetan sus combinaciones RAM/SSD por bloque. Tres fichas no enumeran los SSD configurables (Neo y M1 Max 14"): se completan con las fichas hermanas del mismo chip.
