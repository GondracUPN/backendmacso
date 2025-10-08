# Auditoría de Gastos (USD)

Este documento resume el estado actual del módulo de gastos y, en particular, cómo se manejan gastos en USD. Incluye hallazgos y un plan de cambios propuesto para corregir inconsistencias y preparar mejoras.

## Estado actual

- Entidad `Gasto` (`src/gastos/entities/gasto.entity.ts`):
  - Campos: `moneda: 'PEN'|'USD'`, `monto: numeric(12,2)` (se mapea como `string` en TypeORM), `metodoPago: 'debito'|'credito'`, `concepto`, `tarjeta`, `tarjetaPago`, etc.
  - No guarda tipo de cambio por movimiento.

- DTO `CreateGastoDto` (`src/gastos/dto/create-gasto.dto.ts`):
  - Valida `moneda` ∈ {PEN, USD} y `monto` numérico positivo.
  - Normalización de concepto en `GastosService` a snake_case (`compras_cuotas`, `pago_tarjeta`, etc.).

- Servicio `GastosService` (`src/gastos/gastos.service.ts`):
  - Crea/actualiza el gasto normalizando `concepto`, formatea `monto` a 2 decimales.
  - No realiza efectos colaterales (no actualiza `wallet`).

- Resumen de tarjetas `CardsService` (`src/cards/cards.service.ts`):
  - Para sumarizar consumos y pagos de tarjeta, convierte USD→PEN usando `GASTOS_USD_RATE` (default 3.8) proveniente de `ConfigService`.
  - Las consultas usan `CASE WHEN g.moneda='USD' THEN monto * :usd ELSE monto END`.
  - No usa un tipo de cambio por transacción (porque no existe en `Gasto`).

- `Wallet` (`src/wallet/*`):
  - Guarda `efectivoPen` y `efectivoUsd`.
  - Solo se actualiza mediante `WalletController`/`upsert` manual. Los gastos no impactan automáticamente el wallet.

## Problemas detectados

- Tipo de cambio fijo global:
  - El resumen de tarjetas depende de `GASTOS_USD_RATE` vigente. Si la tasa cambia, el histórico en USD se revaloriza, distorsionando reportes.
  - No hay forma de “congelar” la conversión según la tasa del día de la operación.

- Ausencia de `tasaUsdPen` por gasto:
  - Impide auditoría y reproducciones exactas del cálculo en el tiempo.
  - Dificulta reportes mixtos (PEN y USD) consistentes con la realidad de la fecha de gasto.

- `Wallet` no refleja gastos/ingresos:
  - Al crear un gasto en `debito`, no se descuenta ni de `efectivoPen` ni de `efectivoUsd`.
  - Al registrar un `ingreso` (p. ej. devolución) pagado con `debito`, tampoco se suma al wallet.
  - Pagos de tarjeta (`pago_tarjeta` desde `debito`) deberían impactar wallet en la moneda correspondiente.

- Validaciones de coherencia negocio:
  - Casos como `metodoPago='credito'` + `concepto='pago_tarjeta'` no deberían permitirse.
  - Falta guía/validación sobre cuándo `tarjeta` y `tarjetaPago` son requeridos.

## Cambios propuestos (en fases)

1) Congelar tipo de cambio por gasto
- Agregar a `Gasto` nuevos campos:
  - `tasaUsdPen: numeric(8,4) | null` (requerido cuando `moneda='USD'`).
  - Opcional pero útil: `montoPen: numeric(12,2)` para consultas más simples (PEN si `moneda='PEN'`; `monto * tasaUsdPen` si `moneda='USD'`).
- `CreateGastoDto`/`UpdateGastoDto`:
  - Permitir `tasaUsdPen?: number` y requerirlo si `moneda='USD'` (validación condicional).
  - Si no se envía y `moneda='USD'`, usar `GASTOS_USD_RATE` actual para autocompletar, pero persistirlo en el gasto.
- `GastosService`:
  - Al crear/actualizar: calcular y guardar `montoPen` si está habilitado.

2) Ajustar reportes de tarjetas
- `CardsService.getSummary`:
  - Reemplazar `CASE ... * :usd` por:
    - `CASE WHEN g.moneda='USD' THEN CAST(g.monto AS numeric) * COALESCE(g.tasaUsdPen, :usd) ELSE CAST(g.monto AS numeric) END`
  - Ideal si existe `montoPen`: solo sumar `CAST(g.montoPen AS numeric)`.

3) Impacto en Wallet (opcional pero recomendado)
- Política sugerida:
  - `metodoPago='debito'` y `concepto ≠ 'pago_tarjeta'`:
    - Restar de `efectivoPen` o `efectivoUsd` según `moneda`.
  - `metodoPago='debito'` y `concepto='pago_tarjeta'`:
    - Restar del wallet en la moneda del gasto (según la cuenta de débito usada por el usuario).
  - `concepto='ingreso'` con `metodoPago='debito'`:
    - Sumar al wallet en la moneda correspondiente.
- `GastosService`:
  - Al crear: aplicar ajuste.
  - Al actualizar: recalcular delta e impactar el wallet si cambian `moneda`, `monto`, `metodoPago` o `concepto`.
  - Al eliminar: revertir el impacto inicial.

4) Validaciones de negocio
- `CreateGastoDto`/`UpdateGastoDto`:
  - Si `concepto='pago_tarjeta'` => forzar `metodoPago='debito'` y requerir `tarjetaPago`.
  - Si `metodoPago='credito'` => requerir `tarjeta` ∈ tarjetas soportadas.

## Archivos a modificar

- `src/gastos/entities/gasto.entity.ts` (nuevos campos `tasaUsdPen`, `montoPen`).
- `src/gastos/dto/create-gasto.dto.ts` y `src/gastos/dto/update-gasto.dto.ts` (validaciones condicionales y nuevos campos).
- `src/gastos/gastos.service.ts` (persistencia de `tasaUsdPen`/`montoPen`; lógica de wallet si se adopta).
- `src/cards/cards.service.ts` (usar `tasaUsdPen` o `montoPen`).
- (Opcional) migraciones TypeORM para nuevas columnas.
- (Opcional) `src/wallet/*` si agregamos helpers para ajustes atómicos.

## Variables de entorno

- `GASTOS_USD_RATE`: tasa por defecto si no se envía `tasaUsdPen` en la creación. Actualmente no está definida en `.env` y se usa `3.8` por defecto.

## Notas

- Guardar `tasaUsdPen` por transacción evita revalorar históricos al cambiar la tasa global.
- Si se agrega `montoPen`, se simplifican consultas y se evitan multiplicaciones en SQL bajo filtros complejos.
