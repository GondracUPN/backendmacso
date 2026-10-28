# Cobertura del catálogo Apple

Generado: 2026-10-23T01:58:21.790Z · Fuente: lectura real https://api.appledb.dev/device/main.json (etag W/"6adaa84a-aed74", last-modified Fri, 23 Oct 2026 00:20:26 GMT) · 1959 entradas totales en device/main.json
Dataset complementario: 2026.10.22-1+everymac.168.2026-10-23 · Versión de catálogo: a5fa330016dcd7c9

## Clasificación de dispositivos AppleDB conservados

| Clasificación | Dispositivos |
| --- | ---: |
| commercial | 194 |
| out_of_window | 242 |
| intel_legacy | 14 |
| catalog_only | 21 |
| component | 32 |
| unreleased_or_internal | 21 |
| unclassified | 0 |

## Cobertura por familia y campo comercial

Cada celda: confirmados/total por procedencia (ficha oficial Apple · EveryMac · curado/reglas previas · AppleDB). Desconocido = hueco que requiere revisión.

| Familia | Modelos | Campo | Confirmados | Oficial | EveryMac | Curado/reglas | AppleDB | Desconocidos |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| iphone | 32 | almacenamiento | 32/32 | 3 | 29 | 0 | 0 | 0 |
| iphone | 32 | colors | 32/32 | 0 | 0 | 0 | 32 | 0 |
| iphone | 32 | imei | 32/32 | 0 | 0 | 32 | 0 | 0 |
| ipad | 14 | tamano | 14/14 | 1 | 13 | 0 | 0 | 0 |
| ipad | 14 | almacenamiento | 14/14 | 1 | 13 | 0 | 0 | 0 |
| ipad | 14 | conexion | 14/14 | 0 | 14 | 0 | 0 | 0 |
| ipad | 14 | colors | 14/14 | 1 | 0 | 0 | 13 | 0 |
| ipad | 14 | imei | 14/14 | 0 | 14 | 0 | 0 | 0 |
| watch | 6 | tamano | 6/6 | 2 | 4 | 0 | 0 | 0 |
| watch | 6 | conexion | 6/6 | 2 | 4 | 0 | 0 | 0 |
| watch | 6 | colors | 6/6 | 1 | 0 | 0 | 5 | 0 |
| watch | 6 | imei | 6/6 | 2 | 4 | 0 | 0 | 0 |
| macbook | 21 | tamano | 21/21 | 2 | 19 | 0 | 0 | 0 |
| macbook | 21 | ram | 21/21 | 2 | 19 | 0 | 0 | 0 |
| macbook | 21 | almacenamiento | 21/21 | 2 | 19 | 0 | 0 | 0 |
| macbook | 21 | colors | 21/21 | 12 | 0 | 0 | 9 | 0 |
| imac | 3 | tamano | 3/3 | 0 | 3 | 0 | 0 | 0 |
| imac | 3 | ram | 3/3 | 0 | 3 | 0 | 0 | 0 |
| imac | 3 | almacenamiento | 3/3 | 0 | 3 | 0 | 0 | 0 |
| imac | 3 | colors | 3/3 | 0 | 0 | 0 | 3 | 0 |
| macmini | 7 | ram | 7/7 | 0 | 7 | 0 | 0 | 0 |
| macmini | 7 | almacenamiento | 7/7 | 0 | 7 | 0 | 0 | 0 |
| macmini | 7 | colors | 7/7 | 0 | 0 | 0 | 7 | 0 |
| airpods | 11 | anc | 11/11 | 11 | 0 | 0 | 0 | 0 |
| airpods | 11 | colors | 11/11 | 0 | 0 | 0 | 11 | 0 |

## Huecos exactos

- Ninguno

## Conflictos entre fuentes (pendientes)

- `airpods-airpods-3` (edition): AppleDB agrupa los estuches Lightning y MagSafe en una sola edición; no se distingue el estuche.

## Conflictos resueltos

- `ipad-air-m1` (storages): Reglas previas incluían 128 GB para Air M1; no se publica sin contraste oficial. Resuelto con EveryMac (https://everymac.com/systems/apple/ipad/specs/apple-ipad-air-5th-gen-a2589-wifi-cellular-specs.html).
- `macbook-air-m5` (hardwareModels): AppleDB: A3449 = 13" y A3448 = 15". Reglas previas: A3448 = 13" y A3449 = 15". El tamaño no se deduce del número A hasta revisarlo. Resuelto con EveryMac (https://everymac.com/systems/apple/macbook-air/specs/macbook-air-m5-10-core-cpu-10-core-gpu-13-2026-specs.html).
- `watch-se-2` (hardwareModels): Las reglas previas asignaban A2724 a 40 mm; Apple (108056) y AppleDB indican A2724 = 44 mm GPS + Cellular. Prevalece la fuente oficial.
- `watch-series-10` (hardwareModels): Las reglas previas asignaban A2999 a 42 mm y A2998 a 46 mm; Apple (108056) y AppleDB indican A2997/A2998 = 42 mm GPS y A2999/A3000 = 46 mm GPS. Prevalece la fuente oficial.

## Modelos que requieren revisión

- Ninguno

## Descubiertos por AppleDB fuera del alcance (no se ofrecen en formularios)

AirPods 2, AirPods Pro 1, iPad (7.ª generación), iPad (8.ª generación), iPad Air (3.ª generación), iPad mini (5.ª generación), iPad Pro (A12Z), iPhone SE (2nd generation), iPhone SE (3rd generation), Apple Watch SE 1, Apple Watch SE 2, Apple Watch SE 3, Apple Watch Series 5, Apple Watch Series 6, Apple Watch Series 7, Apple Watch Series 8, Apple Watch Series 9, Apple Watch Ultra

## Modelos por familia (alcance comercial)

- **iphone** (32): iPhone 11, iPhone 11 Pro, iPhone 11 Pro Max, iPhone 12 mini, iPhone 12, iPhone 12 Pro, iPhone 12 Pro Max, iPhone 13 mini, iPhone 13, iPhone 13 Pro, iPhone 13 Pro Max, iPhone 14, iPhone 14 Plus, iPhone 14 Pro, iPhone 14 Pro Max, iPhone 15, iPhone 15 Plus, iPhone 15 Pro, iPhone 15 Pro Max, iPhone 16e, iPhone 16, iPhone 16 Plus, iPhone 16 Pro, iPhone 16 Pro Max, iPhone 17e, iPhone 17, iPhone 17 Pro, iPhone 17 Pro Max, iPhone 18 Pro, iPhone 18 Pro Max, iPhone Air, iPhone Duo
- **ipad** (14): iPad (9.ª generación), iPad (10.ª generación), iPad (A16), iPad Air (4.ª generación), iPad Air (M1), iPad Air (M2), iPad Air (M3), iPad Air (M4), iPad mini (6.ª generación), iPad mini (A17 Pro), iPad Pro (M1), iPad Pro (M2), iPad Pro (M4), iPad Pro (M5)
- **watch** (6): Apple Watch Series 10, Apple Watch Series 11, Apple Watch Series 12, Apple Watch Ultra 2, Apple Watch Ultra 3, Apple Watch Ultra 4
- **macbook** (21): MacBook Air (M1), MacBook Air (M2), MacBook Air (M3), MacBook Air (M4), MacBook Air (M5), MacBook Neo (A18 Pro), MacBook Pro (M1), MacBook Pro (M1 Max), MacBook Pro (M1 Pro), MacBook Pro (M2), MacBook Pro (M2 Max), MacBook Pro (M2 Pro), MacBook Pro (M3), MacBook Pro (M3 Max), MacBook Pro (M3 Pro), MacBook Pro (M4), MacBook Pro (M4 Max), MacBook Pro (M4 Pro), MacBook Pro (M5), MacBook Pro (M5 Max), MacBook Pro (M5 Pro)
- **imac** (3): iMac (M1), iMac (M3), iMac (M4)
- **macmini** (7): Mac mini (M1), Mac mini (M2), Mac mini (M2 Pro), Mac mini (M4), Mac mini (M4 Pro), Mac mini (M5 Pro), Mac mini (M6)
- **airpods** (11): AirPods 3, AirPods 4 con ANC, AirPods 4 sin ANC, AirPods 5, AirPods 5 con estuche inalámbrico, AirPods Max, AirPods Max 2, AirPods Max USB-C, AirPods Pro 2, AirPods Pro 2 USB-C, AirPods Pro 3
