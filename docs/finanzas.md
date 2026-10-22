# Sistema financiero integrado

## Tres indicadores (no se suman entre sí)

| Indicador | Qué mide | Fecha que usa |
|---|---|---|
| **Ganancia comercial** | `venta.ganancia` (precio − costo), una sola vez por venta | Fecha comercial (`fechaVenta` = entrega) |
| **Margen cobrado / liberado** | Ganancia final × (dinero neto disponible ÷ neto esperado), acotado a 0–100 %. Gerencial | Fecha en que el dinero queda disponible (pago directo o liquidación) |
| **Flujo de caja** | Entradas y salidas reales en cuentas propias disponibles | Fecha efectiva del movimiento |

Ganancia final = ganancia comercial − comisiones (reales + estimadas pendientes) − gastos vinculados (costo directo / comisión) − devoluciones − contracargos netos.
El neto esperado descuenta comisiones, por eso una venta con tarjeta de S/ 3,000 con comisión S/ 120 libera S/ 480 (no S/ 460.80).

## Fuentes de datos (cada importe se cuenta una vez)

- **Cobros de clientes**: `venta_pagos` (+ `pago_liquidaciones` para liquidaciones, devoluciones y contracargos).
  Los ingresos de venta que ya existían en Gastos (`gastos` con `sale_id`) se siguen creando como antes; el libro de pagos los deriva con claves idempotentes y, al registrar un pago nuevo, actualiza el ingreso por cobrar de Gastos (historial con `pagoId`). El análisis excluye esas filas de Gastos para no duplicar.
- **Gastos, compras y pagos de tarjeta**: tabla `gastos` existente. Débito = salida de caja; crédito = deuda (sale de caja al registrar `pago_tarjeta`).
- **Transferencias y ajustes (saldo inicial)**: `movimientos_financieros`.
- **Reembolsos**: `reembolsos` + `reembolso_eventos`. Si llega a una tarjeta de crédito se crea un ingreso a crédito en Gastos (`__REFUND__:…`) que reduce su deuda; no es depósito.

## Despliegue (orden obligatorio)

El backend nuevo lee columnas nuevas: **ejecutar la migración antes de desplegar el código**.

```bash
# 1. Respaldo (pg_dump 15 o superior)
pg_dump -Fc --no-owner --no-acl -d "$DATABASE_URL" -f respaldo-antes-finanzas.dump

# 2. Revisar y ejecutar la migración (aditiva, idempotente, reversible)
npm run migration:show
npm run migration:run

# 3. Importar como "sin verificar" los cobros que Gastos ya registra (primero simula)
npm run finanzas:backfill
npm run finanzas:backfill -- --apply
```

`npm run migration:revert` elimina las tablas y columnas nuevas (y lo registrado en ellas).

## Datos históricos

- La migración marca todas las ventas existentes con `conciliacionHistorica = 'pendiente'`. No se crean pagos ficticios ni fechas de depósito.
- La importación usa solo fechas ya registradas en Gastos y deja los pagos con `verificado = false`: no cuentan como caja ni como margen hasta confirmarlos (Análisis → Finanzas y cobros → Conciliación). Esas ventas tampoco cuentan como saldo por cobrar.
- Opciones de conciliación: registros correctos, cobrado en fecha conocida, cobrado sin fecha (no entra a ningún mes), sigue debiendo, o vincular un ingreso suelto de Gastos (sugerencias por importe y fecha) sin copiarlo.
- `cancelAdelanto` ya no borra la reserva: la marca cancelada y registra la devolución en el libro de pagos.

## Permisos

Todos los endpoints `/finanzas/*` requieren JWT y rol `admin`. Las rutas existentes de `/ventas` siguen sin autenticación (la app principal no exige sesión); queda pendiente protegerlas.

## Pruebas

```bash
npm test                                   # unitarias (incluye finanzas-calc.spec.ts)
FINANZAS_IT_DB_URL=postgres://...base_de_pruebas npm run test:e2e -- finanzas   # integración: VACÍA esa base
```
