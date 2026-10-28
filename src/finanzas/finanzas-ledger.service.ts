import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';
import { Venta } from '../venta/venta.entity';
import { VentaAdelanto } from '../venta/venta-adelanto.entity';
import { Gasto } from '../gastos/entities/gasto.entity';
import {
  CuentaFinanciera,
  TIPOS_DISPONIBLES,
} from './entities/cuenta-financiera.entity';
import { MetodoPago, VentaPago } from './entities/venta-pago.entity';
import {
  PagoLiquidacion,
  TipoEventoPago,
} from './entities/pago-liquidacion.entity';
import {
  finanzasVenta,
  fromCents,
  PagoCalc,
  penCents,
  resumenPago,
  toCents,
  VentaCalc,
} from './finanzas-calc';

export type RegistrarPagoInput = {
  ventaId?: number | null;
  adelantoId?: number | null;
  monto: number;
  moneda?: 'PEN' | 'USD';
  tipoCambio?: number | null;
  fechaPago: string;
  metodo: MetodoPago;
  cuentaReceptoraId?: number | null;
  cuentaOrigen?: string | null;
  referencia?: string | null;
  comisionEstimada?: number | null;
  fechaLiquidacionEstimada?: string | null;
  observacion?: string | null;
  idempotencyKey: string;
};

export type RegistrarEventoInput = {
  tipo: TipoEventoPago;
  fecha: string;
  montoBruto: number;
  comision?: number | null;
  cuentaId?: number | null;
  referencia?: string | null;
  nota?: string | null;
  idempotencyKey: string;
};

type HistEntry = {
  amount: number;
  paidAt: string;
  units500?: number;
  pagoId?: number;
  bank?: string;
};

const isUniqueViolation = (error: any) =>
  error?.code === '23505' || error?.driverError?.code === '23505';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Libro de pagos de ventas. Es la única fuente de cobros para el análisis financiero.
 * Mantiene sincronizados los ingresos de venta que ya existen en Gastos (el panel de
 * Gastos, el ITF y las cuentas siguen dependiendo de ellos) sin duplicar dinero:
 * cada pago guarda la referencia a su fila de Gastos y cada entrada de historial
 * creada desde aquí guarda el id del pago.
 */
@Injectable()
export class FinanzasLedgerService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  // ————————————————————————— Lecturas —————————————————————————

  async cuentaPorCodigo(
    manager: EntityManager,
    codigo: string | null | undefined,
  ): Promise<CuentaFinanciera | null> {
    if (!codigo) return null;
    const repo = manager.getRepository(CuentaFinanciera);
    const exact = await repo.findOne({ where: { codigo } });
    if (exact) return exact;
    // Códigos de Gastos (bcp, interbank, efectivo...) → cuenta disponible equivalente.
    return repo.findOne({
      where: { legacyCodigo: codigo, tipo: In(TIPOS_DISPONIBLES) },
    });
  }

  async pagosCalc(
    manager: EntityManager,
    where: { ventaId?: number; adelantoId?: number },
  ): Promise<PagoCalc[]> {
    const pagos = await manager.getRepository(VentaPago).find({
      where:
        where.ventaId != null
          ? { ventaId: where.ventaId }
          : { adelantoId: where.adelantoId },
      relations: ['liquidaciones'],
      order: { id: 'ASC' },
    });
    return pagos.map(toPagoCalc);
  }

  ventaCalc(venta: Venta, costosVinculadosCents = 0): VentaCalc {
    return {
      id: venta.id,
      fechaComercial: String(venta.fechaVenta).slice(0, 10),
      precioCents: toCents(venta.precioVenta),
      gananciaCents: venta.costoPendiente ? null : toCents(venta.ganancia),
      costoDevueltoCents: toCents(venta.costoDevuelto),
      precioDevueltoCents: toCents(venta.precioDevuelto),
      estadoComercial: venta.estadoComercial || 'entregada',
      conciliacionHistorica: venta.conciliacionHistorica,
      costosVinculadosCents,
    };
  }

  // ————————————————————————— Registro de pagos —————————————————————————

  async registrarPago(input: RegistrarPagoInput, manager?: EntityManager): Promise<VentaPago> {
    this.validarPagoInput(input);
    try {
      const run = async (manager: EntityManager) => {
        const repo = manager.getRepository(VentaPago);
        const repetido = await repo.findOne({
          where: { idempotencyKey: input.idempotencyKey },
        });
        if (repetido) return repetido;

        const montoPen = penCents(
          input.monto,
          input.moneda || 'PEN',
          input.tipoCambio,
        );
        let ventaId: number | null = null;
        let adelantoId: number | null = null;
        let esAdelanto = false;
        let verificado = true;

        if (input.ventaId) {
          const venta = await manager
            .getRepository(Venta)
            .createQueryBuilder('v')
            .where('v.id = :id', { id: input.ventaId })
            .setLock('pessimistic_write')
            .getOne();
          if (!venta)
            throw new NotFoundException(`Venta ${input.ventaId} no encontrada`);
          // Con la venta bloqueada, un reintento concurrente ya habrá guardado su pago.
          const yaRegistrado = await repo.findOne({
            where: { idempotencyKey: input.idempotencyKey },
          });
          if (yaRegistrado) return yaRegistrado;
          if (venta.estadoComercial === 'cancelada')
            throw new BadRequestException('La venta está cancelada.');
          const situacion = finanzasVenta(
            this.ventaCalc(venta),
            await this.pagosCalc(manager, { ventaId: venta.id }),
          );
          if (montoPen > situacion.saldoPendienteCents) {
            throw new BadRequestException(
              `El pago supera el saldo pendiente de S/ ${fromCents(situacion.saldoPendienteCents).toFixed(2)}.`,
            );
          }
          ventaId = venta.id;
          verificado = venta.conciliacionHistorica !== 'pendiente';
        } else {
          const adelanto = await manager
            .getRepository(VentaAdelanto)
            .createQueryBuilder('a')
            .where('a.id = :id', { id: input.adelantoId })
            .setLock('pessimistic_write')
            .getOne();
          if (!adelanto)
            throw new NotFoundException(
              `Adelanto ${input.adelantoId} no encontrado`,
            );
          const yaRegistrado = await repo.findOne({
            where: { idempotencyKey: input.idempotencyKey },
          });
          if (yaRegistrado) return yaRegistrado;
          if (adelanto.canceladoAt)
            throw new BadRequestException('La reserva está cancelada.');
          if (adelanto.completadoAt || adelanto.ventaId)
            throw new BadRequestException(
              'La reserva ya se convirtió en venta: registra el pago en la venta.',
            );
          const pagado = (
            await this.pagosCalc(manager, { adelantoId: adelanto.id })
          )
            .filter((p) => !p.anulado)
            .reduce((acc, p) => acc + p.montoCents, 0);
          const restante =
            toCents(adelanto.montoVenta) -
            Math.max(pagado, toCents(adelanto.montoAdelanto));
          if (montoPen > restante)
            throw new BadRequestException(
              `El adelanto supera el saldo de S/ ${fromCents(Math.max(0, restante)).toFixed(2)}.`,
            );
          adelantoId = adelanto.id;
          esAdelanto = true;
        }

        const cuenta = await this.resolverCuentaReceptora(
          manager,
          input.metodo,
          input.cuentaReceptoraId,
        );
        const requiere = ['procesador', 'tercero'].includes(cuenta.tipo);
        const pago = repo.create({
          ventaId,
          adelantoId,
          monto: Number(input.monto).toFixed(2),
          moneda: input.moneda || 'PEN',
          tipoCambio:
            input.moneda === 'USD' ? Number(input.tipoCambio).toFixed(4) : null,
          montoPen: fromCents(montoPen).toFixed(2),
          fechaPago: input.fechaPago,
          metodo: input.metodo,
          cuentaOrigen: input.cuentaOrigen || null,
          referencia: input.referencia || null,
          estado: requiere ? 'pendiente_liquidacion' : 'disponible',
          requiereLiquidacion: requiere,
          comisionEstimada: Number(input.comisionEstimada || 0).toFixed(2),
          fechaLiquidacionEstimada: requiere
            ? input.fechaLiquidacionEstimada || null
            : null,
          cuentaReceptoraId: cuenta.id,
          esAdelanto,
          origen: 'manual',
          verificado,
          idempotencyKey: input.idempotencyKey,
          observacion: input.observacion || null,
        });
        const saved = await repo.save(pago);
        if (ventaId)
          await this.aplicarAIngresosDeVenta(
            manager,
            ventaId,
            montoPen,
            input.fechaPago,
            saved.id,
          );
        if (adelantoId)
          await this.aplicarACuotasDeAdelanto(
            manager,
            adelantoId,
            montoPen,
            input.fechaPago,
            saved.id,
            cuenta,
          );
        return saved;
      };
      return manager ? await run(manager) : await this.dataSource.transaction(run);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const existing = await this.dataSource
          .getRepository(VentaPago)
          .findOne({ where: { idempotencyKey: input.idempotencyKey } });
        if (existing) return existing;
      }
      throw error;
    }
  }

  private validarPagoInput(input: RegistrarPagoInput) {
    if (!input.ventaId === !input.adelantoId)
      throw new BadRequestException('Indica la venta o la reserva del pago.');
    if (!input.idempotencyKey || input.idempotencyKey.length > 120)
      throw new BadRequestException('Falta la clave de idempotencia.');
    if (!DATE_RE.test(String(input.fechaPago || '')))
      throw new BadRequestException('Indica la fecha en que pagó el cliente.');
    const cents = toCents(input.monto);
    if (!(cents > 0) || Math.abs(cents / 100 - Number(input.monto)) > 0.000001)
      throw new BadRequestException('Monto inválido.');
    if ((input.moneda || 'PEN') === 'USD' && !(Number(input.tipoCambio) > 0))
      throw new BadRequestException(
        'Indica el tipo de cambio del pago en USD.',
      );
    if (
      input.comisionEstimada != null &&
      (Number(input.comisionEstimada) < 0 ||
        Number(input.comisionEstimada) > Number(input.monto))
    ) {
      throw new BadRequestException('Comisión estimada inválida.');
    }
    if (
      input.fechaLiquidacionEstimada &&
      !DATE_RE.test(input.fechaLiquidacionEstimada)
    )
      throw new BadRequestException('Fecha estimada inválida.');
  }

  private async resolverCuentaReceptora(
    manager: EntityManager,
    metodo: MetodoPago,
    cuentaId?: number | null,
  ) {
    const repo = manager.getRepository(CuentaFinanciera);
    let cuenta: CuentaFinanciera | null = null;
    if (cuentaId) cuenta = await repo.findOne({ where: { id: cuentaId } });
    else if (metodo === 'efectivo')
      cuenta = await repo.findOne({ where: { codigo: 'efectivo' } });
    else if (metodo === 'tarjeta')
      cuenta = await repo.findOne({ where: { codigo: 'procesador' } });
    if (!cuenta)
      throw new BadRequestException('Selecciona la cuenta que recibe el pago.');
    if (!cuenta.activo)
      throw new BadRequestException('La cuenta seleccionada está inactiva.');
    if (['tarjeta_credito', 'proveedor'].includes(cuenta.tipo))
      throw new BadRequestException('Un cobro no puede ingresar a esa cuenta.');
    return cuenta;
  }

  /** Refleja el pago en las filas de ingreso por cobrar (Deuda / x500) que ya existen en Gastos. */
  private async aplicarAIngresosDeVenta(
    manager: EntityManager,
    ventaId: number,
    cents: number,
    fecha: string,
    pagoId: number,
  ) {
    const repo = manager.getRepository(Gasto);
    const rows = await repo.find({
      where: { saleId: ventaId, concepto: 'ingreso' },
      order: { id: 'ASC' },
    });
    let restante = cents;
    for (const row of rows.filter(
      (r) => r.salePaymentType === 'card' || r.salePaymentType === 'debt',
    )) {
      if (restante <= 0) break;
      const total = toCents(row.monto);
      const recibido = toCents(row.saleReceivedAmount);
      const aplicar = Math.min(total - recibido, restante);
      if (aplicar <= 0) continue;
      const history: HistEntry[] = Array.isArray(row.salePaymentHistory)
        ? [...row.salePaymentHistory]
        : [];
      if (!history.length && recibido > 0)
        history.push({ amount: recibido / 100, paidAt: row.salePaidAt || '' });
      history.push({ amount: aplicar / 100, paidAt: fecha, pagoId });
      row.salePaymentHistory = history;
      row.saleReceivedAmount = fromCents(recibido + aplicar).toFixed(2);
      row.salePaidAt = fecha;
      await repo.save(row);
      restante -= aplicar;
    }
  }

  private async aplicarACuotasDeAdelanto(
    manager: EntityManager,
    adelantoId: number,
    cents: number,
    fecha: string,
    pagoId: number,
    cuenta: CuentaFinanciera,
  ) {
    const repo = manager.getRepository(VentaAdelanto);
    const adelanto = await repo.findOne({ where: { id: adelantoId } });
    if (!adelanto) return;
    const cuotas =
      Array.isArray(adelanto.cuotas) && adelanto.cuotas.length
        ? [...adelanto.cuotas]
        : [
            {
              fecha: adelanto.fechaAdelanto,
              monto: Number(adelanto.montoAdelanto),
            },
          ];
    const banco = ['bcp', 'interbank', 'bbva'].includes(
      String(cuenta.legacyCodigo),
    )
      ? (cuenta.legacyCodigo as any)
      : undefined;
    cuotas.push({
      fecha,
      monto: cents / 100,
      ...(banco ? { banco } : {}),
      tipoPago: 'direct',
      pagoId,
    } as any);
    adelanto.cuotas = cuotas;
    adelanto.montoAdelanto = fromCents(toCents(adelanto.montoAdelanto) + cents);
    await repo.save(adelanto);
  }

  // ————————————————————————— Liquidaciones, devoluciones y contracargos —————————————————————————

  async registrarEvento(
    pagoId: number,
    input: RegistrarEventoInput,
    manager?: EntityManager,
  ): Promise<PagoLiquidacion> {
    if (!input.idempotencyKey || input.idempotencyKey.length > 120)
      throw new BadRequestException('Falta la clave de idempotencia.');
    if (!DATE_RE.test(String(input.fecha || '')))
      throw new BadRequestException('Indica la fecha.');
    const bruto = toCents(input.montoBruto);
    const comision =
      input.tipo === 'liquidacion' ? toCents(input.comision || 0) : 0;
    if (!(bruto > 0) || comision < 0 || comision > bruto)
      throw new BadRequestException('Importes inválidos.');
    try {
      const run = async (manager: EntityManager) => {
        const repo = manager.getRepository(PagoLiquidacion);
        const repetido = await repo.findOne({
          where: { idempotencyKey: input.idempotencyKey },
        });
        if (repetido) return repetido;
        const pagoRepo = manager.getRepository(VentaPago);
        const locked = await pagoRepo
          .createQueryBuilder('p')
          .where('p.id = :id', { id: pagoId })
          .setLock('pessimistic_write')
          .getOne();
        if (!locked)
          throw new NotFoundException(`Pago ${pagoId} no encontrado`);
        const yaRegistrado = await repo.findOne({
          where: { idempotencyKey: input.idempotencyKey },
        });
        if (yaRegistrado) return yaRegistrado;
        if (locked.anuladoAt)
          throw new BadRequestException('El pago está anulado.');
        if (input.fecha < String(locked.fechaPago || ''))
          throw new BadRequestException(
            'La fecha no puede ser anterior al pago.',
          );
        const pago = await pagoRepo.findOne({
          where: { id: pagoId },
          relations: ['liquidaciones'],
        });
        const r = resumenPago(toPagoCalc(pago!));
        const cobradoDelPago =
          toCents(pago!.montoPen) -
          r.devueltoCents -
          r.contracargoCents +
          r.reversionCents;

        let cuentaId: number | null = input.cuentaId ?? null;
        if (cuentaId) {
          const cuenta = await manager
            .getRepository(CuentaFinanciera)
            .findOne({ where: { id: cuentaId } });
          if (!cuenta) throw new BadRequestException('Cuenta no encontrada.');
          if (
            input.tipo === 'liquidacion' &&
            !TIPOS_DISPONIBLES.includes(cuenta.tipo)
          ) {
            throw new BadRequestException(
              'La liquidación debe ingresar a una cuenta propia disponible.',
            );
          }
        }
        if (input.tipo === 'liquidacion') {
          if (!pago!.requiereLiquidacion)
            throw new BadRequestException(
              'Este pago ya estaba disponible: no requiere liquidación.',
            );
          if (!cuentaId)
            throw new BadRequestException(
              'Indica la cuenta donde se depositó la liquidación.',
            );
          if (bruto > r.pendienteLiquidacionCents) {
            throw new BadRequestException(
              `La liquidación supera lo pendiente (S/ ${fromCents(r.pendienteLiquidacionCents).toFixed(2)}).`,
            );
          }
        } else if (
          input.tipo === 'devolucion' ||
          input.tipo === 'contracargo'
        ) {
          if (bruto > cobradoDelPago)
            throw new BadRequestException(
              `Supera lo cobrado en este pago (S/ ${fromCents(cobradoDelPago).toFixed(2)}).`,
            );
          // Sin cuenta: la pasarela lo descontó antes de liquidar, solo es posible sobre lo retenido.
          if (
            !cuentaId &&
            (!pago!.requiereLiquidacion || bruto > r.pendienteLiquidacionCents)
          ) {
            if (pago!.requiereLiquidacion || !pago!.cuentaReceptoraId) {
              throw new BadRequestException(
                'Indica de qué cuenta salió el dinero.',
              );
            }
            cuentaId = pago!.cuentaReceptoraId;
          }
        } else if (input.tipo === 'reversion_contracargo') {
          if (bruto > r.contracargoCents - r.reversionCents)
            throw new BadRequestException(
              'La reversión supera el contracargo abierto.',
            );
          if (!cuentaId)
            throw new BadRequestException(
              'Indica la cuenta que recibe la reversión.',
            );
        }

        const saved = await repo.save(
          repo.create({
            pagoId,
            tipo: input.tipo,
            fecha: input.fecha,
            montoBruto: fromCents(bruto).toFixed(2),
            comision: fromCents(comision).toFixed(2),
            montoNeto: fromCents(bruto - comision).toFixed(2),
            cuentaId,
            referencia: input.referencia || null,
            nota: input.nota || null,
            idempotencyKey: input.idempotencyKey,
          }),
        );
        const actualizado = await pagoRepo.findOne({
          where: { id: pagoId },
          relations: ['liquidaciones'],
        });
        actualizado!.estado = estadoPago(actualizado!);
        await pagoRepo.save(actualizado!);
        return saved;
      };
      return manager ? await run(manager) : await this.dataSource.transaction(run);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const existing = await this.dataSource
          .getRepository(PagoLiquidacion)
          .findOne({ where: { idempotencyKey: input.idempotencyKey } });
        if (existing) return existing;
      }
      throw error;
    }
  }

  /** Anula un pago registrado por error. Solo si no tiene liquidaciones ni devoluciones. */
  async anularPago(pagoId: number, motivo: string): Promise<VentaPago> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(VentaPago);
      const pago = await repo
        .createQueryBuilder('p')
        .where('p.id = :id', { id: pagoId })
        .setLock('pessimistic_write')
        .getOne();
      if (!pago) throw new NotFoundException(`Pago ${pagoId} no encontrado`);
      if (pago.anuladoAt) return pago;
      if (pago.origen !== 'manual' && pago.origen !== 'conciliacion') {
        throw new BadRequestException(
          'Este pago proviene de la venta o del adelanto: corrígelo desde su origen.',
        );
      }
      const eventos = await manager
        .getRepository(PagoLiquidacion)
        .count({ where: { pagoId } });
      if (eventos)
        throw new BadRequestException(
          'El pago tiene liquidaciones o devoluciones: registra una devolución en lugar de anularlo.',
        );
      if (pago.ventaId) {
        const gastoRepo = manager.getRepository(Gasto);
        const rows = await gastoRepo.find({
          where: { saleId: pago.ventaId, concepto: 'ingreso' },
        });
        for (const row of rows) {
          const history = (
            Array.isArray(row.salePaymentHistory) ? row.salePaymentHistory : []
          ) as HistEntry[];
          const entry = history.find((h) => h.pagoId === pago.id);
          if (!entry) continue;
          row.salePaymentHistory = history.filter((h) => h !== entry);
          row.saleReceivedAmount = fromCents(
            toCents(row.saleReceivedAmount) - toCents(entry.amount),
          ).toFixed(2);
          row.salePaidAt = row.salePaymentHistory.at(-1)?.paidAt || null;
          await gastoRepo.save(row);
        }
      }
      if (pago.adelantoId) {
        const adelantoRepo = manager.getRepository(VentaAdelanto);
        const adelanto = await adelantoRepo.findOne({
          where: { id: pago.adelantoId },
        });
        if (adelanto && Array.isArray(adelanto.cuotas)) {
          const cuota = adelanto.cuotas.find((c: any) => c.pagoId === pago.id);
          if (cuota) {
            adelanto.cuotas = adelanto.cuotas.filter((c) => c !== cuota);
            adelanto.montoAdelanto = fromCents(
              toCents(adelanto.montoAdelanto) - toCents(cuota.monto),
            );
            await adelantoRepo.save(adelanto);
          }
        }
      }
      pago.anuladoAt = new Date();
      pago.estado = 'anulado';
      pago.observacion = [
        pago.observacion,
        `Anulado: ${motivo || 'sin motivo'}`,
      ]
        .filter(Boolean)
        .join(' · ');
      return repo.save(pago);
    });
  }

  // ————————————————————————— Puente con los ingresos existentes —————————————————————————

  /**
   * Deriva los pagos de una venta desde sus filas de ingreso en Gastos. Idempotente:
   * cada fila / entrada de historial genera siempre la misma clave. En ventas con
   * conciliación histórica pendiente, los pagos quedan sin verificar.
   */
  async sincronizarIngresosVenta(
    ventaId: number,
    manager: EntityManager = this.dataSource.manager,
    partes?: {
      parts?: Array<{ type: string; amount: number }>;
      incomeBank?: string | null;
      cuentaId?: number;
      metodo?: string;
    },
  ): Promise<void> {
    const venta = await manager
      .getRepository(Venta)
      .findOne({ where: { id: ventaId } });
    // Una venta anulada no vuelve a derivar ni reactivar pagos.
    if (!venta || venta.anuladaAt) return;
    const gastoRepo = manager.getRepository(Gasto);
    // Las filas de adelanto también llevan sale_id: sus pagos se derivan de la reserva.
    const rows = (
      await gastoRepo.find({
        where: { saleId: ventaId, concepto: 'ingreso' },
        order: { id: 'ASC' },
      })
    ).filter((row) => !String(row.notas || '').startsWith('__SALE_ADVANCE__'));
    // Filas antiguas enlazadas solo por producto: se usan si el producto tiene una única venta.
    const ventasDelProducto = await manager
      .getRepository(Venta)
      .count({ where: { productoId: venta.productoId } });
    if (ventasDelProducto === 1) {
      const legacyRef = `__SALE_INCOME__:${venta.productoId}`;
      const legacy = await gastoRepo.find({
        where: [
          { saleId: IsNull(), concepto: 'ingreso', notas: legacyRef },
          ...['direct', 'card', 'debt', 'cash'].map((t) => ({
            saleId: IsNull(),
            concepto: 'ingreso',
            notas: `${legacyRef}:${t}`,
          })),
        ],
        order: { id: 'ASC' },
      });
      rows.push(...legacy);
    }
    const verificado = venta.conciliacionHistorica !== 'pendiente';
    const deseados: Array<Partial<VentaPago> & { idempotencyKey: string }> = [];
    for (const row of rows) {
      const cuenta = row.saleCuentaId
        ? await manager.getRepository(CuentaFinanciera).findOneBy({ id: row.saleCuentaId })
        : await this.cuentaPorCodigo(manager, row.tarjeta);
      const efectivo =
        row.salePaymentType === 'cash' || row.tarjeta === 'efectivo';
      const base = {
        ventaId,
        moneda: 'PEN' as const,
        metodo: (row.saleMetodo || (efectivo ? 'efectivo' : 'transferencia')) as MetodoPago,
        estado: 'disponible' as const,
        requiereLiquidacion: false,
        cuentaReceptoraId: cuenta?.id ?? null,
        origen: 'ingreso_venta' as const,
        verificado,
        gastoId: row.id,
      };
      const type = row.salePaymentType;
      if (!type || type === 'direct' || type === 'cash') {
        const fecha = row.salePaidAt || row.fecha;
        deseados.push({
          ...base,
          idempotencyKey: `ingreso:${row.id}`,
          monto: row.monto,
          montoPen: row.monto,
          fechaPago: fecha,
        });
        continue;
      }
      const history = (
        Array.isArray(row.salePaymentHistory) ? row.salePaymentHistory : []
      ) as HistEntry[];
      if (history.length) {
        for (const [i, h] of history.entries()) {
          if (h.pagoId || !(toCents(h.amount) > 0)) continue; // registrado desde el libro de pagos
          // Cada cobro puede haber entrado en una cuenta distinta a la de la venta.
          const cuentaPago = h.bank ? await this.cuentaPorCodigo(manager, h.bank) : null;
          deseados.push({
            ...base,
            ...(cuentaPago ? { cuentaReceptoraId: cuentaPago.id } : {}),
            idempotencyKey: `ingreso:${row.id}:h${i}`,
            metodo: type === 'debt' ? 'x500' : base.metodo,
            monto: Number(h.amount).toFixed(2),
            montoPen: Number(h.amount).toFixed(2),
            fechaPago: h.paidAt || null,
          });
        }
      } else if (toCents(row.saleReceivedAmount) > 0) {
        deseados.push({
          ...base,
          idempotencyKey: `ingreso:${row.id}:recibido`,
          metodo: type === 'debt' ? 'x500' : base.metodo,
          monto: row.saleReceivedAmount!,
          montoPen: row.saleReceivedAmount!,
          fechaPago: row.salePaidAt || null,
        });
      }
    }
    if (!rows.length) {
      // Venta sin vendedor asignado: Gastos no crea filas de ingreso. Se usan las formas
      // de cobro indicadas al registrar la venta (solo las ya recibidas).
      if (!partes?.parts?.length) return;
      const cuentaBanco = partes.cuentaId ? await manager.getRepository(CuentaFinanciera).findOneBy({ id: partes.cuentaId }) : await this.cuentaPorCodigo(
        manager,
        partes.incomeBank || 'bcp',
      );
      const cuentaEfectivo = await this.cuentaPorCodigo(manager, 'efectivo');
      for (const part of partes.parts) {
        if (part.type !== 'direct' && part.type !== 'cash') continue;
        const monto = fromCents(toCents(part.amount)).toFixed(2);
        deseados.push({
          idempotencyKey: `venta:${ventaId}:${part.type}`,
          ventaId,
          monto,
          montoPen: monto,
          moneda: 'PEN',
          fechaPago: String(venta.fechaVenta).slice(0, 10),
          metodo: (partes.metodo || (part.type === 'cash' ? 'efectivo' : 'transferencia')) as MetodoPago,
          estado: 'disponible',
          requiereLiquidacion: false,
          cuentaReceptoraId:
            (partes.cuentaId ? cuentaBanco : part.type === 'cash' ? cuentaEfectivo : cuentaBanco)?.id ?? null,
          origen: 'ingreso_venta',
          verificado,
        });
      }
      await this.reconciliarDerivados(
        manager,
        { ventaId, origen: 'ingreso_venta' },
        deseados,
        (k) => k.startsWith('venta:'),
      );
      return;
    }
    await this.reconciliarDerivados(
      manager,
      { ventaId, origen: 'ingreso_venta' },
      deseados,
    );
  }

  /** Deriva los pagos de un adelanto desde sus cuotas (las registradas aquí ya existen). */
  async sincronizarAdelanto(
    adelantoId: number,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<void> {
    const adelanto = await manager
      .getRepository(VentaAdelanto)
      .findOne({ where: { id: adelantoId } });
    if (!adelanto) return;
    const venta = adelanto.ventaId
      ? await manager
          .getRepository(Venta)
          .findOne({ where: { id: adelanto.ventaId } })
      : null;
    // Las cuotas se conservan como historial, pero sus pagos quedaron anulados con la venta.
    if (venta?.anuladaAt) return;
    const cuotas =
      Array.isArray(adelanto.cuotas) && adelanto.cuotas.length
        ? adelanto.cuotas
        : [
            {
              fecha: adelanto.fechaAdelanto,
              monto: Number(adelanto.montoAdelanto),
            },
          ];
    const cuentas = await manager.getRepository(CuentaFinanciera).find();
    const cuentaPorCodigo = (codigo: string) => cuentas.find((c) => c.codigo === codigo)
      || cuentas.find((c) => c.legacyCodigo === codigo && TIPOS_DISPONIBLES.includes(c.tipo as any));
    const deseados: Array<Partial<VentaPago> & { idempotencyKey: string }> = [];
    for (const [i, cuota] of cuotas.entries()) {
      if (
        (cuota as any).pagoId ||
        (cuota.tipoPago && cuota.tipoPago !== 'direct') ||
        !(toCents(cuota.monto) > 0)
      )
        continue;
      const cuenta = cuentaPorCodigo(cuota.banco || 'bcp');
      deseados.push({
        idempotencyKey: `adelanto:${adelanto.id}:${i}`,
        adelantoId: adelanto.id,
        ventaId: adelanto.ventaId || null,
        monto: Number(cuota.monto).toFixed(2),
        montoPen: Number(cuota.monto).toFixed(2),
        moneda: 'PEN',
        fechaPago: cuota.fecha,
        metodo: 'transferencia',
        estado: 'disponible',
        requiereLiquidacion: false,
        cuentaReceptoraId: cuenta?.id ?? null,
        esAdelanto: true,
        origen: 'adelanto',
        verificado: venta ? venta.conciliacionHistorica !== 'pendiente' : true,
      });
    }
    await this.reconciliarDerivados(
      manager,
      { adelantoId: adelanto.id, origen: 'adelanto' },
      deseados,
    );
    // Los pagos registrados desde el libro también pasan a la venta al completarse.
    if (adelanto.ventaId) {
      await manager
        .getRepository(VentaPago)
        .update(
          { adelantoId: adelanto.id, ventaId: IsNull() },
          { ventaId: adelanto.ventaId },
        );
    }
  }

  private async reconciliarDerivados(
    manager: EntityManager,
    scope: {
      ventaId?: number;
      adelantoId?: number;
      origen: 'ingreso_venta' | 'adelanto';
    },
    deseados: Array<Partial<VentaPago> & { idempotencyKey: string }>,
    gestionada: (key: string) => boolean = () => true,
  ) {
    const repo = manager.getRepository(VentaPago);
    const actuales = (
      await repo.find({
        where:
          scope.ventaId != null
            ? { ventaId: scope.ventaId, origen: scope.origen }
            : { adelantoId: scope.adelantoId, origen: scope.origen },
      })
    ).filter((p) => gestionada(p.idempotencyKey));
    const claves = new Set(deseados.map((d) => d.idempotencyKey));
    const currentKeys = new Set(actuales.map((p) => p.idempotencyKey));
    const missingKeys = [...claves].filter((key) => !currentKeys.has(key));
    const outsideScope = missingKeys.length
      ? await repo.find({ where: { idempotencyKey: In(missingKeys) } }) : [];
    const byKey = new Map([...actuales, ...outsideScope].map((p) => [p.idempotencyKey, p]));
    for (const d of deseados) {
      if (!(toCents(d.montoPen) > 0)) continue;
      const existente = byKey.get(d.idempotencyKey);
      if (existente) {
        const cambios: Partial<VentaPago> = {};
        if (toCents(existente.montoPen) !== toCents(d.montoPen))
          Object.assign(cambios, { monto: d.monto, montoPen: d.montoPen });
        if ((existente.fechaPago || null) !== (d.fechaPago || null))
          cambios.fechaPago = d.fechaPago;
        if (d.ventaId && existente.ventaId !== d.ventaId)
          cambios.ventaId = d.ventaId;
        if (
          d.cuentaReceptoraId !== undefined &&
          (existente.cuentaReceptoraId ?? null) !== (d.cuentaReceptoraId ?? null)
        )
          cambios.cuentaReceptoraId = d.cuentaReceptoraId;
        if (existente.anuladoAt)
          Object.assign(cambios, { anuladoAt: null, estado: 'disponible' });
        // Nunca se "des-verifica" algo confirmado manualmente.
        if (d.verificado && !existente.verificado) cambios.verificado = true;
        if (Object.keys(cambios).length)
          await repo.update(existente.id, cambios);
        continue;
      }
      try {
        await repo.insert(repo.create(d));
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    for (const sobrante of actuales.filter(
      (p) => !claves.has(p.idempotencyKey) && !p.anuladoAt,
    )) {
      const eventos = await manager
        .getRepository(PagoLiquidacion)
        .count({ where: { pagoId: sobrante.id } });
      if (eventos) continue; // tiene historia propia: se conserva
      await repo.update(sobrante.id, {
        anuladoAt: new Date(),
        estado: 'anulado',
        observacion: 'Ya no figura en los ingresos de la venta.',
      });
    }
  }

  /** Cancela una reserva conservando su historial: los pagos quedan devueltos. */
  async devolverPagosAdelanto(
    manager: EntityManager,
    adelantoId: number,
    fecha: string,
    montoDevueltoCents: number,
    cuentaId?: number | null,
  ) {
    await this.sincronizarAdelanto(adelantoId, manager);
    const repo = manager.getRepository(VentaPago);
    const pagos = await repo.find({
      where: { adelantoId },
      relations: ['liquidaciones'],
      order: { id: 'ASC' },
    });
    let restante = montoDevueltoCents;
    for (const pago of pagos) {
      if (pago.anuladoAt || restante <= 0) continue;
      const r = resumenPago(toPagoCalc(pago));
      const cobrado =
        toCents(pago.montoPen) -
        r.devueltoCents -
        r.contracargoCents +
        r.reversionCents;
      const devolver = Math.min(cobrado, restante);
      if (devolver <= 0) continue;
      const salida =
        pago.requiereLiquidacion && devolver <= r.pendienteLiquidacionCents
          ? null
          : cuentaId || pago.cuentaReceptoraId || null;
      await manager.getRepository(PagoLiquidacion).insert({
        pagoId: pago.id,
        tipo: 'devolucion',
        fecha,
        montoBruto: fromCents(devolver).toFixed(2),
        comision: '0.00',
        montoNeto: fromCents(devolver).toFixed(2),
        cuentaId: salida,
        idempotencyKey: `cancelacion-adelanto:${adelantoId}:${pago.id}`,
        nota: 'Devolución por cancelación de reserva',
      });
      const actualizado = await repo.findOne({
        where: { id: pago.id },
        relations: ['liquidaciones'],
      });
      await repo.update(pago.id, { estado: estadoPago(actualizado!) });
      restante -= devolver;
    }
  }

  /**
   * Anulación completa de una venta: todos sus pagos (de la venta y de la reserva que la
   * originó, incluidos los que tienen liquidaciones o devoluciones) dejan de aportar.
   * Los eventos se conservan como historial; todas las lecturas los excluyen al
   * estar anulado su pago, por lo que no se registra ninguna devolución compensatoria.
   */
  async anularPagosVenta(
    manager: EntityManager,
    ventaId: number,
    adelantoId: number | null | undefined,
    motivo: string,
  ): Promise<number> {
    const repo = manager.getRepository(VentaPago);
    const where = [
      { ventaId, anuladoAt: IsNull() },
      ...(adelantoId ? [{ adelantoId, anuladoAt: IsNull() }] : []),
    ];
    const pagos = await repo.find({ where, order: { id: 'ASC' } });
    const anuladoAt = new Date();
    for (const pago of pagos) {
      await repo.update(pago.id, {
        anuladoAt,
        estado: 'anulado',
        observacion: [pago.observacion, `Venta ${ventaId} anulada: ${motivo}`]
          .filter(Boolean)
          .join(' · '),
      });
    }
    return pagos.length;
  }

  /** Al eliminar una venta se conservan sus pagos como anulados (sin borrar historia). */
  async marcarVentaEliminada(ventaId: number, manager: EntityManager = this.dataSource.manager) {
    await manager.getRepository(VentaPago).update(
      { ventaId, adelantoId: IsNull(), anuladoAt: IsNull() },
      {
        anuladoAt: new Date(),
        estado: 'anulado',
        observacion: `Venta ${ventaId} eliminada`,
      },
    );
  }
}

export function toPagoCalc(p: VentaPago): PagoCalc {
  return {
    id: p.id,
    montoCents: toCents(p.montoPen),
    fechaPago: p.fechaPago ? String(p.fechaPago).slice(0, 10) : null,
    requiereLiquidacion: !!p.requiereLiquidacion,
    comisionEstimadaCents: toCents(p.comisionEstimada),
    anulado: !!p.anuladoAt,
    verificado: p.verificado !== false,
    disputado: p.estado === 'disputado',
    esAdelanto: !!p.esAdelanto,
    eventos: (p.liquidaciones || []).map((l) => ({
      tipo: l.tipo,
      fecha: String(l.fecha).slice(0, 10),
      brutoCents: toCents(l.montoBruto),
      comisionCents: toCents(l.comision),
      netoCents: toCents(l.montoNeto),
      cuentaId: l.cuentaId ?? null,
    })),
  };
}

export function estadoPago(p: VentaPago): VentaPago['estado'] {
  if (p.anuladoAt) return 'anulado';
  const r = resumenPago({ ...toPagoCalc(p), disputado: false });
  const monto = toCents(p.montoPen);
  if (r.contracargoCents > r.reversionCents) return 'disputado';
  if (r.devueltoCents >= monto) return 'devuelto';
  if (!p.requiereLiquidacion) return 'disponible';
  if (r.pendienteLiquidacionCents <= 0) return 'liquidado';
  if (r.liquidadoBrutoCents > 0) return 'parcialmente_liquidado';
  return 'pendiente_liquidacion';
}
