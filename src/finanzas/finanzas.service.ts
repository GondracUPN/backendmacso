import { ConflictException } from '@nestjs/common';
import { operationHash } from '../venta/operation-hash';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { Venta } from '../venta/venta.entity';
import { VentaAdelanto } from '../venta/venta-adelanto.entity';
import { VentaDevolucion } from '../venta/venta-devolucion.entity';
import { VentaService } from '../venta/venta.service';
import { Producto } from '../producto/producto.entity';
import { ProductoDetalle } from '../producto/producto-detalle.entity';
import { ProductoValor } from '../producto/producto-valor.entity';
import { Gasto } from '../gastos/entities/gasto.entity';
import {
  CuentaFinanciera,
  TIPOS_DISPONIBLES,
} from './entities/cuenta-financiera.entity';
import { VentaPago } from './entities/venta-pago.entity';
import { PagoLiquidacion } from './entities/pago-liquidacion.entity';
import { MovimientoFinanciero } from './entities/movimiento-financiero.entity';
import { Reembolso } from './entities/reembolso.entity';
import { ReembolsoEvento } from './entities/reembolso-evento.entity';
import { FinanzasLedgerService, toPagoCalc } from './finanzas-ledger.service';
import {
  finanzasVenta,
  fromCents,
  penCents,
  resumenReembolso,
  resumenVentaRapida,
  toCents,
} from './finanzas-calc';
import {
  ActualizarCuentaDto,
  ClasificarGastoDto,
  ConciliarVentaDto,
  CrearReembolsoDto,
  CuentaDto,
  EventoReembolsoDto,
  MovimientoDto,
  VentaRapidaDto,
} from './dto/finanzas.dto';
import { productCost } from '../analytics/financial-core';
import { validarVinculos } from './finanzas-vinculos';

export { validarVinculos };

const isUniqueViolation = (error: any) =>
  error?.code === '23505' || error?.driverError?.code === '23505';
const hoyLima = () =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });

@Injectable()
export class FinanzasService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ledger: FinanzasLedgerService,
    private readonly ventas: VentaService,
  ) {}

  // ————————————————————————— Cuentas —————————————————————————

  listarCuentas() {
    return this.dataSource
      .getRepository(CuentaFinanciera)
      .find({ order: { tipo: 'ASC', nombre: 'ASC' } });
  }

  async crearCuenta(dto: CuentaDto) {
    const repo = this.dataSource.getRepository(CuentaFinanciera);
    const codigo = dto.codigo
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_');
    if (await repo.findOne({ where: { codigo } }))
      throw new BadRequestException('Ya existe una cuenta con ese código.');
    return repo.save(
      repo.create({
        ...dto,
        codigo,
        moneda: dto.moneda || 'PEN',
        legacyCodigo: dto.legacyCodigo || null,
      }),
    );
  }

  async actualizarCuenta(id: number, dto: ActualizarCuentaDto) {
    const repo = this.dataSource.getRepository(CuentaFinanciera);
    const cuenta = await repo.findOne({ where: { id } });
    if (!cuenta) throw new NotFoundException('Cuenta no encontrada');
    Object.assign(cuenta, {
      ...(dto.nombre !== undefined ? { nombre: dto.nombre } : {}),
      ...(dto.activo !== undefined ? { activo: dto.activo } : {}),
      ...(dto.legacyCodigo !== undefined
        ? { legacyCodigo: dto.legacyCodigo || null }
        : {}),
    });
    return repo.save(cuenta);
  }

  // ————————————————————————— Transferencias y ajustes —————————————————————————

  async registrarMovimiento(dto: MovimientoDto, userId?: number) {
    const repo = this.dataSource.getRepository(MovimientoFinanciero);
    const repetido = await repo.findOne({
      where: { idempotencyKey: dto.idempotencyKey },
    });
    if (repetido) return repetido;
    const cuentas = this.dataSource.getRepository(CuentaFinanciera);
    const origen = dto.cuentaOrigenId
      ? await cuentas.findOne({ where: { id: dto.cuentaOrigenId } })
      : null;
    const destino = dto.cuentaDestinoId
      ? await cuentas.findOne({ where: { id: dto.cuentaDestinoId } })
      : null;
    if ((dto.cuentaOrigenId && !origen) || (dto.cuentaDestinoId && !destino))
      throw new BadRequestException('Cuenta no encontrada.');
    if (dto.tipo === 'transferencia') {
      if (!origen || !destino)
        throw new BadRequestException(
          'Una transferencia necesita cuenta de origen y destino.',
        );
      if (origen.id === destino.id)
        throw new BadRequestException('Las cuentas deben ser distintas.');
      if (
        origen.tipo === 'tarjeta_credito' ||
        destino.tipo === 'tarjeta_credito'
      ) {
        throw new BadRequestException(
          'Los pagos y consumos de tarjeta se registran en Gastos para no duplicar la deuda.',
        );
      }
    } else if (!!origen === !!destino) {
      throw new BadRequestException(
        'Un ajuste afecta a una sola cuenta (origen = salida, destino = entrada).',
      );
    }
    const montoPen = penCents(dto.monto, dto.moneda || 'PEN', dto.tipoCambio);
    try {
      return await repo.save(
        repo.create({
          tipo: dto.tipo,
          fecha: dto.fecha,
          cuentaOrigenId: origen?.id ?? null,
          cuentaDestinoId: destino?.id ?? null,
          monto: Number(dto.monto).toFixed(2),
          moneda: dto.moneda || 'PEN',
          tipoCambio:
            dto.moneda === 'USD' ? Number(dto.tipoCambio).toFixed(4) : null,
          montoPen: fromCents(montoPen).toFixed(2),
          metodo: dto.metodo || null,
          referencia: dto.referencia || null,
          nota: dto.nota || null,
          idempotencyKey: dto.idempotencyKey,
          createdBy: userId ?? null,
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        const existing = await repo.findOne({
          where: { idempotencyKey: dto.idempotencyKey },
        });
        if (existing) return existing;
      }
      throw error;
    }
  }

  async anularMovimiento(id: number, motivo: string) {
    const repo = this.dataSource.getRepository(MovimientoFinanciero);
    const mov = await repo.findOne({ where: { id } });
    if (!mov) throw new NotFoundException('Movimiento no encontrado');
    if (mov.anuladoAt) return mov;
    mov.anuladoAt = new Date();
    mov.nota = [mov.nota, `Anulado: ${motivo}`].filter(Boolean).join(' · ');
    return repo.save(mov);
  }

  listarMovimientos(params: {
    from?: string;
    to?: string;
    page?: number;
    pageSize?: number;
  }) {
    const pageSize = Math.min(200, Math.max(1, params.pageSize || 50));
    const qb = this.dataSource
      .getRepository(MovimientoFinanciero)
      .createQueryBuilder('m')
      .orderBy('m.fecha', 'DESC')
      .addOrderBy('m.id', 'DESC');
    if (params.from) qb.andWhere('m.fecha >= :from', { from: params.from });
    if (params.to) qb.andWhere('m.fecha <= :to', { to: params.to });
    return qb
      .skip(((params.page || 1) - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount()
      .then(([items, total]) => ({
        items,
        total,
        page: params.page || 1,
        pageSize,
      }));
  }

  // ————————————————————————— Detalle de venta —————————————————————————

  async detalleVenta(ventaId: number) {
    const venta = await this.dataSource
      .getRepository(Venta)
      .findOne({ where: { id: ventaId } });
    if (!venta) throw new NotFoundException(`Venta ${ventaId} no encontrada`);
    const pagos = await this.dataSource.getRepository(VentaPago).find({
      where: { ventaId },
      relations: ['liquidaciones'],
      order: { fechaPago: 'ASC', id: 'ASC' },
    });
    const adelanto = await this.dataSource
      .getRepository(VentaAdelanto)
      .findOne({ where: { ventaId } });
    const costos = await this.costosVinculados([venta]);
    const calc = finanzasVenta(
      this.ledger.ventaCalc(venta, costos.get(venta.id)?.cents || 0),
      pagos.map(toPagoCalc),
    );
    const cuentas = await this.listarCuentas();
    const nombreCuenta = (id?: number | null) =>
      cuentas.find((c) => c.id === id)?.nombre || null;
    const timeline = pagos
      .flatMap((p) => [
        {
          tipo: p.esAdelanto ? 'adelanto' : 'pago',
          fecha: p.fechaPago,
          pagoId: p.id,
          monto: Number(p.montoPen),
          metodo: p.metodo,
          cuenta: nombreCuenta(p.cuentaReceptoraId),
          estado: p.estado,
          verificado: p.verificado,
          origen: p.origen,
          referencia: p.referencia,
          anulado: !!p.anuladoAt,
        },
        ...(p.liquidaciones || []).map((l) => ({
          tipo: l.tipo,
          fecha: l.fecha,
          pagoId: p.id,
          eventoId: l.id,
          monto: Number(l.montoBruto),
          comision: Number(l.comision),
          neto: Number(l.montoNeto),
          cuenta: nombreCuenta(l.cuentaId),
          referencia: l.referencia,
          anulado: !!p.anuladoAt,
        })),
      ])
      .sort((a, b) =>
        String(a.fecha || '9999').localeCompare(String(b.fecha || '9999')),
      );
    return {
      venta: {
        id: venta.id,
        productoId: venta.productoId,
        fechaComercial: venta.fechaVenta,
        fechaReserva: venta.fechaReserva,
        precio: Number(venta.precioVenta),
        precioLista:
          venta.precioLista != null ? Number(venta.precioLista) : null,
        descuento: Number(venta.descuento || 0),
        moneda: venta.moneda,
        estadoComercial: venta.estadoComercial,
        conciliacionHistorica: venta.conciliacionHistorica,
        conciliacionNota: venta.conciliacionNota,
        costoPendiente: venta.costoPendiente,
        grupoOperacion: venta.grupoOperacion,
        ventaRapida: venta.ventaRapida,
        gananciaGuardada: Number(venta.ganancia),
        vendedor: venta.vendedor,
      },
      adelanto: adelanto
        ? {
            id: adelanto.id,
            fecha: adelanto.fechaAdelanto,
            monto: Number(adelanto.montoAdelanto),
          }
        : null,
      finanzas: centsToMoney(calc),
      costosVinculados: costos.get(venta.id)?.items || [],
      pagos: pagos.map((p) => ({
        ...p,
        monto: Number(p.monto),
        montoPen: Number(p.montoPen),
        comisionEstimada: Number(p.comisionEstimada),
      })),
      timeline,
    };
  }

  /** Gastos clasificados como costo directo o comisión y vinculados a la venta o a su producto. */
  async costosVinculados(
    ventas: Venta[],
    manager: EntityManager = this.dataSource.manager,
  ) {
    const result = new Map<
      number,
      {
        cents: number;
        items: Array<{
          gastoId: number;
          fecha: string;
          concepto: string;
          clasificacion: string;
          monto: number;
        }>;
      }
    >();
    if (!ventas.length) return result;
    const ventaIds = ventas.map((v) => v.id);
    const productoIds = ventas.map((v) => v.productoId);
    const rows: any[] = await manager.query(
      `SELECT g.id, g.fecha, g.concepto, g.clasificacion_financiera AS clasificacion, g.venta_vinculada_id AS "ventaId",
              g.producto_vinculado_id AS "productoId", g.moneda, g.monto, g.monto_pen AS "montoPen", g.tasa_usd_pen AS tasa
         FROM gastos g
        WHERE g.clasificacion_financiera IN ('costo_directo', 'comision_venta')
          AND (g.venta_vinculada_id = ANY($1) OR (g.venta_vinculada_id IS NULL AND g.producto_vinculado_id = ANY($2)))`,
      [ventaIds, productoIds],
    );
    const ventasPorProducto = new Map<number, Venta[]>();
    ventas.forEach((v) =>
      ventasPorProducto.set(v.productoId, [
        ...(ventasPorProducto.get(v.productoId) || []),
        v,
      ]),
    );
    for (const row of rows) {
      let ventaId = row.ventaId ? Number(row.ventaId) : null;
      if (!ventaId) {
        const candidatas = (
          ventasPorProducto.get(Number(row.productoId)) || []
        ).filter((v) => v.estadoComercial !== 'cancelada');
        if (candidatas.length !== 1) continue; // ambiguo: no se asigna por suposición
        ventaId = candidatas[0].id;
      }
      const cents = gastoPenCents(row);
      const entry = result.get(ventaId) || { cents: 0, items: [] };
      entry.cents += cents;
      entry.items.push({
        gastoId: row.id,
        fecha: String(row.fecha).slice(0, 10),
        concepto: row.concepto,
        clasificacion: row.clasificacion,
        monto: fromCents(cents),
      });
      result.set(ventaId, entry);
    }
    return result;
  }

  /** Guarda el precio pactado (antes de descuento). No altera precio de venta, costo ni ganancia. */
  costosPendientes() {
    return this.dataSource.getRepository(Venta).createQueryBuilder('v')
      .leftJoinAndSelect('v.producto', 'p').leftJoinAndSelect('p.detalle', 'd')
      .where('v."costoPendiente" = true').andWhere('v."estadoComercial" <> :cancelada', { cancelada: 'cancelada' })
      .orderBy('v.id', 'ASC').getMany();
  }

  async completarCosto(id: number, costoTotal: number, documento: string, userId: number) {
    if (!Number.isFinite(costoTotal) || costoTotal < 0 || Math.abs(costoTotal * 100 - Math.round(costoTotal * 100)) > 0.000001
      || !documento || documento.trim().length < 3) throw new BadRequestException('Indica el costo total y su comprobante o referencia.');
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT id FROM venta WHERE id = $1 FOR UPDATE', [id]);
      const repo = manager.getRepository(Venta);
      const venta = await repo.findOneBy({ id });
      if (!venta) throw new NotFoundException('Venta no encontrada.');
      if (!venta.costoPendiente) {
        if (Number(venta.costoCompletadoTotal) === costoTotal && venta.costoDocumento === documento.trim()) return venta;
        throw new ConflictException('El costo ya está confirmado; esta operación solo completa costos pendientes.');
      }
      const distribution: NonNullable<Venta['distribucionStock']> = venta.distribucionStock?.length ? venta.distribucionStock : [{ productoId: venta.productoId, cantidad: venta.cantidad || 1 }];
      const known = distribution.reduce((sum, part) => sum + (part.costoUnitario == null ? 0 : part.costoUnitario * part.cantidad), 0);
      const unknownQty = distribution.reduce((sum, part) => sum + (part.costoUnitario == null ? part.cantidad : 0), 0);
      if (!unknownQty || toCents(costoTotal) < toCents(known)) throw new BadRequestException('El costo indicado contradice los costos de lote ya conocidos.');
      const unit = (costoTotal - known) / unknownQty;
      const ids = [...new Set(distribution.map((part) => part.productoId))].sort((a, b) => a - b);
      await manager.query('SELECT id FROM producto WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE', [ids]);
      for (const part of distribution.filter((part) => part.costoUnitario == null)) {
        const p = await manager.getRepository(Producto).findOneByOrFail({ id: part.productoId });
        p.valor.monedaCompra = 'PEN';
        p.valor.valorProducto = +(unit * Number(p.stockInicial || part.cantidad)).toFixed(2);
        p.valor.valorSoles = p.valor.valorProducto; p.valor.costoTotal = p.valor.valorProducto;
        await manager.getRepository(ProductoValor).save(p.valor);
        part.costoUnitario = unit;
      }
      venta.distribucionStock = distribution;
      venta.ganancia = (toCents(venta.precioVenta) - toCents(costoTotal)) / 100;
      venta.porcentajeGanancia = costoTotal > 0 ? +(Number(venta.ganancia) / costoTotal * 100).toFixed(3) : 0;
      venta.costoPendiente = false; venta.costoCompletadoTotal = costoTotal;
      venta.costoDocumento = documento.trim(); venta.costoCompletadoPor = userId; venta.costoCompletadoAt = new Date();
      const devRepo = manager.getRepository(VentaDevolucion);
      const devoluciones = await devRepo.findBy({ ventaId: id });
      let recuperado = 0;
      for (const d of devoluciones) {
        d.lotes = d.lotes.map((part) => ({ ...part, costoUnitario: distribution.find((row) => row.productoId === part.productoId)!.costoUnitario! }));
        d.costoRecuperado = (d.destino === 'disponible' ? d.lotes.reduce((sum, part) => sum + part.costoUnitario * part.cantidad, 0) : 0).toFixed(2);
        recuperado += Number(d.costoRecuperado); await devRepo.save(d);
      }
      venta.costoDevuelto = recuperado;
      return repo.save(venta);
    });
  }

  async precioPactado(ventaId: number, precioLista: number) {
    const repo = this.dataSource.getRepository(Venta);
    const venta = await repo.findOne({ where: { id: ventaId } });
    if (!venta) throw new NotFoundException(`Venta ${ventaId} no encontrada`);
    const lista = toCents(precioLista);
    const precio = toCents(venta.precioVenta);
    if (!(lista >= precio))
      throw new BadRequestException(
        'El precio pactado no puede ser menor que el precio de venta.',
      );
    await repo.update(ventaId, {
      precioLista: fromCents(lista),
      descuento: fromCents(lista - precio),
    });
    return {
      ventaId,
      precioLista: fromCents(lista),
      descuento: fromCents(lista - precio),
      precioVenta: fromCents(precio),
    };
  }

  // ————————————————————————— Conciliación histórica —————————————————————————

  async conciliarVenta(
    ventaId: number,
    dto: ConciliarVentaDto,
    userId?: number,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(Venta);
      const venta = await repo
        .createQueryBuilder('v')
        .where('v.id = :id', { id: ventaId })
        .setLock('pessimistic_write')
        .getOne();
      if (!venta) throw new NotFoundException(`Venta ${ventaId} no encontrada`);
      const pagoRepo = manager.getRepository(VentaPago);
      if (dto.modo === 'vincular_ingresos') {
        // Ingresos sueltos ya registrados en Gastos: se enlazan a la venta, no se duplican.
        const gastoRepo = manager.getRepository(Gasto);
        const ingresos = await gastoRepo.find({
          where: { id: In(dto.gastoIds || []) },
        });
        if (ingresos.length !== (dto.gastoIds || []).length)
          throw new BadRequestException('Algún ingreso no existe.');
        for (const ingreso of ingresos) {
          if (
            ingreso.concepto !== 'ingreso' ||
            ingreso.metodoPago !== 'debito' ||
            ingreso.saleId ||
            /^__SALE_|^__REFUND__/.test(String(ingreso.notas || ''))
          ) {
            throw new BadRequestException(
              `El registro ${ingreso.id} no es un ingreso libre de Gastos.`,
            );
          }
        }
        const total = ingresos.reduce((acc, g) => acc + toCents(g.monto), 0);
        if (total > toCents(venta.precioVenta))
          throw new BadRequestException(
            'Los ingresos vinculados superan el precio de la venta.',
          );
        for (const ingreso of ingresos)
          await gastoRepo.update(ingreso.id, { saleId: ventaId });
        await this.ledger.sincronizarIngresosVenta(ventaId, manager);
      }
      await pagoRepo.update(
        { ventaId, verificado: false },
        { verificado: true },
      );
      const pagos = await this.ledger.pagosCalc(manager, { ventaId });
      const saldo = finanzasVenta(
        this.ledger.ventaCalc(venta),
        pagos,
      ).saldoPendienteCents;
      const nota =
        [dto.nota, userId ? `Usuario ${userId}` : null]
          .filter(Boolean)
          .join(' · ') || null;

      if (
        (dto.modo === 'con_fecha' || dto.modo === 'sin_fecha') &&
        saldo > 0 &&
        !dto.forzar
      ) {
        const candidatos = await this.ingresosSueltosCandidatos(manager, venta);
        if (candidatos.length) {
          throw new BadRequestException(
            `Gastos ya tiene ingresos sueltos que podrían ser este cobro (${candidatos
              .map(
                (c) =>
                  `#${c.id} S/ ${Number(c.monto).toFixed(2)} del ${c.fecha}`,
              )
              .join(
                ', ',
              )}). Vincúlalos para no contarlos dos veces, o confirma que es otro dinero.`,
          );
        }
      }
      if ((dto.modo === 'con_fecha' || dto.modo === 'sin_fecha') && saldo > 0) {
        const cuenta = dto.cuentaId
          ? await manager
              .getRepository(CuentaFinanciera)
              .findOne({ where: { id: dto.cuentaId } })
          : await this.ledger.cuentaPorCodigo(
              manager,
              dto.metodo === 'efectivo' ? 'efectivo' : 'bcp',
            );
        if (
          dto.modo === 'con_fecha' &&
          dto.fecha &&
          dto.fecha < String(venta.fechaVenta).slice(0, 10) &&
          !venta.fechaReserva
        ) {
          // Permitido (pudo ser un adelanto), pero se deja constancia.
        }
        await pagoRepo.insert(
          pagoRepo.create({
            ventaId,
            monto: fromCents(saldo).toFixed(2),
            montoPen: fromCents(saldo).toFixed(2),
            moneda: 'PEN',
            fechaPago: dto.modo === 'con_fecha' ? dto.fecha! : null,
            metodo: dto.metodo || 'transferencia',
            estado: 'disponible',
            requiereLiquidacion: false,
            cuentaReceptoraId: cuenta?.id ?? null,
            origen: 'conciliacion',
            verificado: true,
            idempotencyKey: `conciliacion:${ventaId}`,
            observacion:
              dto.modo === 'sin_fecha'
                ? 'Cobro histórico confirmado sin fecha conocida'
                : 'Cobro histórico confirmado',
          }),
        );
      }
      venta.conciliacionHistorica =
        dto.modo === 'sin_fecha' ? 'confirmada_sin_fecha' : 'confirmada';
      venta.conciliacionNota =
        dto.modo === 'pendiente_real'
          ? [nota, 'Saldo pendiente confirmado'].filter(Boolean).join(' · ')
          : nota;
      venta.conciliadaAt = new Date();
      await repo.save(venta);
      return { ventaId, conciliacionHistorica: venta.conciliacionHistorica };
    });
  }

  /** Ingresos libres de Gastos con importe y fecha compatibles con la venta (posibles cobros ya registrados). */
  private ingresosSueltosCandidatos(
    manager: EntityManager,
    venta: Venta,
  ): Promise<Array<{ id: number; monto: string; fecha: string }>> {
    return manager.query(
      `SELECT g.id, g.monto, g.fecha::text AS fecha
         FROM gastos g
         JOIN producto p ON p.id = $1
        WHERE g.concepto = 'ingreso' AND g.metodo_pago = 'debito' AND g.sale_id IS NULL
          AND COALESCE(g.notas, '') NOT LIKE '\\_\\_SALE\\_%' AND COALESCE(g.notas, '') NOT LIKE '\\_\\_REFUND\\_\\_%'
          AND g.monto <= $2 AND g.fecha BETWEEN $3::date - 45 AND $3::date + 120
          AND (g.monto = $2 OR g.notas ILIKE '%' || COALESCE(p."codigoInventario", p.id)::text || '%')
        ORDER BY abs(g.fecha - $3::date) LIMIT 3`,
      [
        venta.productoId,
        venta.precioVenta,
        String(venta.fechaVenta).slice(0, 10),
      ],
    );
  }

  /** Confirma en bloque que los ingresos registrados en Gastos son correctos. */
  async conciliarLote(ventaIds: number[], userId?: number) {
    const resultados: Array<{ ventaId: number; ok: boolean; error?: string }> =
      [];
    for (const ventaId of ventaIds) {
      try {
        await this.conciliarVenta(
          ventaId,
          { modo: 'confirmar_registros' } as ConciliarVentaDto,
          userId,
        );
        resultados.push({ ventaId, ok: true });
      } catch (error: any) {
        resultados.push({
          ventaId,
          ok: false,
          error: error?.message || String(error),
        });
      }
    }
    return resultados;
  }

  /**
   * Importa como pagos SIN VERIFICAR los ingresos que Gastos ya tiene registrados para
   * ventas antiguas. No inventa pagos ni fechas: usa solo fechas ya registradas.
   */
  async backfillHistorico(dryRun = true) {
    const ventas = await this.dataSource.getRepository(Venta).find({
      where: { conciliacionHistorica: 'pendiente' },
      order: { id: 'ASC' },
    });
    const adelantos = await this.dataSource.getRepository(VentaAdelanto).find();
    const before = await this.contarPagos();
    const run = async (manager: EntityManager) => {
      for (const venta of ventas)
        await this.ledger.sincronizarIngresosVenta(venta.id, manager);
      for (const adelanto of adelantos)
        await this.ledger.sincronizarAdelanto(adelanto.id, manager);
      const after = await this.contarPagos(manager);
      const sinEvidencia: Array<{ id: number }> = await manager.query(
        `SELECT v.id FROM venta v WHERE v."conciliacionHistorica" = 'pendiente'
           AND NOT EXISTS (SELECT 1 FROM venta_pagos p WHERE p.venta_id = v.id AND p.anulado_at IS NULL)`,
      );
      return {
        dryRun,
        ventasPendientes: ventas.length,
        pagosAntes: before,
        pagosDespues: after,
        pagosCreados: after.cantidad - before.cantidad,
        ventasSinEvidencia: sinEvidencia.length,
      };
    };
    if (!dryRun) return this.dataSource.transaction(run);
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      return await run(qr.manager);
    } finally {
      await qr.rollbackTransaction();
      await qr.release();
    }
  }

  private async contarPagos(manager: EntityManager = this.dataSource.manager) {
    const [row] = await manager.query(
      `SELECT count(*)::int AS cantidad, COALESCE(sum(monto_pen), 0)::text AS total FROM venta_pagos WHERE anulado_at IS NULL`,
    );
    return { cantidad: Number(row.cantidad), total: Number(row.total) };
  }

  listarConciliacionPendiente(params: { page?: number; pageSize?: number }) {
    const pageSize = Math.min(200, Math.max(1, params.pageSize || 50));
    const offset = ((params.page || 1) - 1) * pageSize;
    return this.dataSource
      .query(
        `SELECT v.id, v."fechaVenta" AS "fechaComercial", v."precioVenta"::float AS precio, v.vendedor, p.tipo,
              COALESCE(d.modelo, d."descripcionOtro", d.gama) AS modelo, p."codigoInventario",
              COALESCE((SELECT sum(vp.monto_pen) FROM venta_pagos vp WHERE vp.venta_id = v.id AND vp.anulado_at IS NULL), 0)::float AS registrado,
              (SELECT min(vp.fecha_pago) FROM venta_pagos vp WHERE vp.venta_id = v.id AND vp.anulado_at IS NULL)::text AS "primerCobro",
              (SELECT COALESCE(json_agg(s ORDER BY s.distancia), '[]'::json) FROM (
                 SELECT g.id, g.fecha::text AS fecha, g.monto::float AS monto, g.tarjeta, g.notas,
                        abs(g.fecha - v."fechaVenta") AS distancia
                   FROM gastos g
                  WHERE g.concepto = 'ingreso' AND g.metodo_pago = 'debito' AND g.sale_id IS NULL
                    AND COALESCE(g.notas, '') NOT LIKE '\\_\\_SALE\\_%' AND COALESCE(g.notas, '') NOT LIKE '\\_\\_REFUND\\_\\_%'
                    AND g.monto <= v."precioVenta" AND g.fecha BETWEEN v."fechaVenta" - 45 AND v."fechaVenta" + 120
                    AND (g.monto = v."precioVenta" OR g.notas ILIKE '%' || COALESCE(p."codigoInventario", p.id)::text || '%')
                  ORDER BY abs(g.fecha - v."fechaVenta") LIMIT 3) s) AS sugerencias,
              count(*) OVER()::int AS total
         FROM venta v
         JOIN producto p ON p.id = v."productoId"
         LEFT JOIN producto_detalle d ON d.id = p."detalleId"
        WHERE v."conciliacionHistorica" = 'pendiente'
        ORDER BY v."fechaVenta" DESC, v.id DESC
        LIMIT $1 OFFSET $2`,
        [pageSize, offset],
      )
      .then((rows: any[]) => ({
        items: rows.map(({ total, ...r }) => r),
        total: rows[0]?.total || 0,
        page: params.page || 1,
        pageSize,
      }));
  }

  // ————————————————————————— Gastos —————————————————————————

  async clasificarGasto(id: number, dto: ClasificarGastoDto) {
    const repo = this.dataSource.getRepository(Gasto);
    const gasto = await repo.findOne({ where: { id } });
    if (!gasto) throw new NotFoundException('Gasto no encontrado');
    if (
      gasto.saleId ||
      String(gasto.notas || '').startsWith('__SALE_') ||
      String(gasto.notas || '').startsWith('__REFUND__')
    ) {
      throw new BadRequestException(
        'Este registro es un cobro o reembolso automático: no se clasifica como gasto.',
      );
    }
    await validarVinculos(this.dataSource.manager, dto);
    if (dto.clasificacionFinanciera !== undefined)
      gasto.clasificacionFinanciera = dto.clasificacionFinanciera || null;
    if (dto.ventaVinculadaId !== undefined)
      gasto.ventaVinculadaId = dto.ventaVinculadaId || null;
    if (dto.productoVinculadoId !== undefined)
      gasto.productoVinculadoId = dto.productoVinculadoId || null;
    return repo.save(gasto);
  }

  listarGastosSinClasificar(params: {
    from?: string;
    to?: string;
    page?: number;
    pageSize?: number;
  }) {
    const pageSize = Math.min(200, Math.max(1, params.pageSize || 50));
    const qb = this.dataSource
      .getRepository(Gasto)
      .createQueryBuilder('g')
      .where('g.clasificacionFinanciera IS NULL')
      .andWhere(`g.concepto <> 'ingreso'`)
      .andWhere('g.saleId IS NULL')
      .orderBy('g.fecha', 'DESC')
      .addOrderBy('g.id', 'DESC');
    if (params.from) qb.andWhere('g.fecha >= :from', { from: params.from });
    if (params.to) qb.andWhere('g.fecha <= :to', { to: params.to });
    return qb
      .skip(((params.page || 1) - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount()
      .then(([items, total]) => ({
        items,
        total,
        page: params.page || 1,
        pageSize,
      }));
  }

  // ————————————————————————— Reembolsos y productos perdidos —————————————————————————

  async crearReembolso(dto: CrearReembolsoDto) {
    return this.dataSource.transaction(async (manager) => {
      const producto = await manager
        .getRepository(Producto)
        .findOne({ where: { id: dto.productoId }, relations: ['valor'] });
      if (!producto) throw new NotFoundException('Producto no encontrado');
      const abierto = await manager
        .getRepository(Reembolso)
        .createQueryBuilder('r')
        .where('r.productoId = :id', { id: producto.id })
        .andWhere(
          `r.estado NOT IN ('recibido', 'rechazado', 'perdida_definitiva')`,
        )
        .getOne();
      if (abierto)
        throw new BadRequestException(
          'El producto ya tiene una reclamación abierta.',
        );
      const costo = dto.costoOriginal ?? productCost(producto);
      if (costo == null)
        throw new BadRequestException(
          'El producto no tiene costo registrado: indícalo manualmente.',
        );
      const valor = producto.valor;
      const tcCompra =
        valor &&
        String(valor.monedaCompra || 'USD') === 'USD' &&
        Number(valor.valorProducto) > 0 &&
        Number(valor.valorSoles) > 0
          ? Number(valor.valorSoles) / Number(valor.valorProducto)
          : null;
      const moneda = dto.moneda || 'PEN';
      const repo = manager.getRepository(Reembolso);
      const saved = await repo.save(
        repo.create({
          productoId: producto.id,
          estado: dto.estado || 'incidencia',
          moneda,
          tipoCambioCompra: tcCompra ? tcCompra.toFixed(4) : null,
          costoOriginal: Number(costo).toFixed(2),
          gastosAdicionales: Number(dto.gastosAdicionales || 0).toFixed(2),
          montoReclamado: Number(
            dto.montoReclamado ??
              (moneda === 'USD' && valor ? Number(valor.valorProducto) : costo),
          ).toFixed(2),
          cuentaDevolucionId: dto.cuentaDevolucionId ?? null,
          fechaIncidencia: dto.fechaIncidencia || hoyLima(),
          referencia: dto.referencia || null,
          motivo: dto.motivo || null,
        }),
      );
      await manager.getRepository(ReembolsoEvento).insert({
        reembolsoId: saved.id,
        tipo: 'incidencia',
        fecha: saved.fechaIncidencia!,
        moneda,
        nota: dto.motivo || 'Incidencia reportada',
        idempotencyKey: `reembolso:${saved.id}:alta`,
      });
      return saved;
    });
  }

  async eventoReembolso(id: number, dto: EventoReembolsoDto, userId: number) {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const eventoRepo = manager.getRepository(ReembolsoEvento);
        const repetido = await eventoRepo.findOne({
          where: { idempotencyKey: dto.idempotencyKey },
        });
        if (repetido) return this.reembolsoConEventos(id, manager);
        const repo = manager.getRepository(Reembolso);
        const r = await repo
          .createQueryBuilder('r')
          .where('r.id = :id', { id })
          .setLock('pessimistic_write')
          .getOne();
        if (!r) throw new NotFoundException('Reembolso no encontrado');
        if (
          ['recibido', 'rechazado', 'perdida_definitiva'].includes(r.estado) &&
          dto.tipo !== 'nota'
        ) {
          throw new BadRequestException('La reclamación está cerrada.');
        }
        const moneda = dto.moneda || r.moneda;
        const requiereMonto = [
          'reclamo',
          'aprobado',
          'recibido',
          'gasto_adicional',
        ].includes(dto.tipo);
        if (requiereMonto && !(Number(dto.monto) > 0))
          throw new BadRequestException('Indica el monto.');
        const tc = dto.tipoCambio ?? r.tipoCambioCompra;
        if (moneda === 'USD' && dto.monto && !(Number(tc) > 0)) {
          throw new BadRequestException(
            'Indica el tipo de cambio para convertir el importe en USD.',
          );
        }
        const montoPen =
          dto.monto != null && dto.monto > 0
            ? penCents(dto.monto, moneda, tc)
            : null;
        let gastoId: number | null = null;
        let cuenta: CuentaFinanciera | null = null;
        if (dto.tipo === 'recibido') {
          const cuentaId = dto.cuentaId ?? r.cuentaDevolucionId;
          cuenta = cuentaId
            ? await manager
                .getRepository(CuentaFinanciera)
                .findOne({ where: { id: cuentaId } })
            : null;
          if (!cuenta)
            throw new BadRequestException(
              'Indica la cuenta o tarjeta donde llegó el reembolso.',
            );
          if (cuenta.tipo === 'tarjeta_credito') {
            // Crédito en la tarjeta: reduce su deuda en Gastos, no es un depósito bancario.
            if (!cuenta.legacyCodigo)
              throw new BadRequestException(
                'La tarjeta no está enlazada con Gastos.',
              );
            const gasto = await manager.getRepository(Gasto).save(
              manager.getRepository(Gasto).create({
                userId,
                concepto: 'ingreso',
                metodoPago: 'credito',
                tarjeta: cuenta.legacyCodigo,
                moneda,
                monto: Number(dto.monto).toFixed(2),
                montoPen: fromCents(montoPen!).toFixed(2),
                tasaUsdPen:
                  moneda === 'USD'
                    ? Number(dto.tipoCambio ?? r.tipoCambioCompra).toFixed(4)
                    : null,
                fecha: dto.fecha,
                notas: `__REFUND__:${r.id}`,
                clasificacionFinanciera: 'ajuste_devolucion',
                productoVinculadoId: r.productoId,
              }),
            );
            gastoId = gasto.id;
          }
        }
        const evento = await eventoRepo.save(
          eventoRepo.create({
            reembolsoId: r.id,
            tipo: dto.tipo,
            fecha: dto.fecha,
            monto: dto.monto != null ? Number(dto.monto).toFixed(2) : null,
            moneda,
            tipoCambio:
              moneda === 'USD' && dto.tipoCambio
                ? Number(dto.tipoCambio).toFixed(4)
                : null,
            montoPen: montoPen != null ? fromCents(montoPen).toFixed(2) : null,
            cuentaId: cuenta?.id ?? dto.cuentaId ?? null,
            gastoId,
            nota: dto.nota || null,
            idempotencyKey: dto.idempotencyKey,
          }),
        );
        if (gastoId)
          await manager
            .getRepository(Gasto)
            .update(gastoId, { notas: `__REFUND__:${r.id}:${evento.id}` });

        const eventos = await eventoRepo.find({ where: { reembolsoId: r.id } });
        const montoMoneda = Number(dto.monto || 0);
        switch (dto.tipo) {
          case 'incidencia':
            r.estado = 'incidencia';
            break;
          case 'reclamo':
            r.estado = 'reclamo_abierto';
            r.montoReclamado = montoMoneda.toFixed(2);
            break;
          case 'aprobado':
            r.estado = 'aprobado';
            r.montoAprobado = montoMoneda.toFixed(2);
            break;
          case 'gasto_adicional':
            r.gastosAdicionales = fromCents(
              toCents(r.gastosAdicionales) + montoPen!,
            ).toFixed(2);
            break;
          case 'rechazado':
            r.estado = 'rechazado';
            r.fechaCierre = dto.fecha;
            break;
          case 'perdida':
            r.estado = 'perdida_definitiva';
            r.fechaCierre = dto.fecha;
            break;
          case 'recibido': {
            const recibidoMoneda = eventos
              .filter((e) => e.tipo === 'recibido')
              .reduce((acc, e) => acc + toCents(e.monto), 0);
            const esperado = toCents(r.montoAprobado ?? r.montoReclamado);
            r.estado =
              recibidoMoneda >= esperado ? 'recibido' : 'reembolso_parcial';
            if (r.estado === 'recibido') r.fechaCierre = dto.fecha;
            break;
          }
          default:
            break;
        }
        await repo.save(r);
        if (['recibido', 'perdida_definitiva'].includes(r.estado)) {
          await manager
            .getRepository(Producto)
            .createQueryBuilder()
            .update()
            .set({ cierreMotivo: 'perdido' })
            .where('id = :id AND "cierreMotivo" IS NULL', { id: r.productoId })
            .execute();
        }
        return this.reembolsoConEventos(r.id, manager);
      });
    } catch (error) {
      if (isUniqueViolation(error)) return this.reembolsoConEventos(id);
      throw error;
    }
  }

  async reembolsoConEventos(
    id: number,
    manager: EntityManager = this.dataSource.manager,
  ) {
    const r = await manager
      .getRepository(Reembolso)
      .findOne({ where: { id }, relations: ['eventos'] });
    if (!r) throw new NotFoundException('Reembolso no encontrado');
    return { ...r, resumen: centsToMoney(resumenReembolso(reembolsoCalc(r))) };
  }

  async listarReembolsos(params: { productoId?: number; abiertos?: boolean }) {
    const qb = this.dataSource
      .getRepository(Reembolso)
      .createQueryBuilder('r')
      .leftJoinAndSelect('r.eventos', 'e')
      .orderBy('r.createdAt', 'DESC')
      .addOrderBy('e.fecha', 'ASC')
      .addOrderBy('e.id', 'ASC');
    if (params.productoId)
      qb.andWhere('r.productoId = :pid', { pid: params.productoId });
    if (params.abiertos)
      qb.andWhere(
        `r.estado NOT IN ('recibido', 'rechazado', 'perdida_definitiva')`,
      );
    const items = await qb.getMany();
    return items.map((r) => ({
      ...r,
      resumen: centsToMoney(resumenReembolso(reembolsoCalc(r))),
    }));
  }

  async cerrarProducto(
    productoId: number,
    motivo: 'perdido' | 'cancelado' | 'no_comercializable' | 'reabrir',
  ) {
    const repo = this.dataSource.getRepository(Producto);
    const exists = await repo.count({ where: { id: productoId } });
    if (!exists) throw new NotFoundException('Producto no encontrado');
    await repo.update(productoId, {
      cierreMotivo: motivo === 'reabrir' ? null : motivo,
    });
    return { productoId, cierreMotivo: motivo === 'reabrir' ? null : motivo };
  }

  // ————————————————————————— Venta rápida de accesorios —————————————————————————

  /** Accesorios con stock agrupados por código comercial, con su costo unitario (FIFO del primer lote). */
  async accesoriosDisponibles() {
    const rows: any[] = await this.dataSource.query(`
      SELECT p.id, COALESCE(p."codigoInventario", p.id) AS codigo, p."stockActual", p."stockInicial",
             NULLIF(trim(concat_ws(' ', d."descripcionOtro", d.modelo, d.gama)), '') AS nombre,
             COALESCE(val."costoTotalProrrateado", val."costoTotal", val."valorSoles") AS costo, val."fechaCompra" AS fecha
        FROM producto p
        LEFT JOIN producto_detalle d ON d.id = p."detalleId"
        LEFT JOIN producto_valor val ON val.id = p."valorId"
       WHERE lower(p.tipo) = 'accesorios' AND p."stockActual" > 0 AND p."cierreMotivo" IS NULL
       ORDER BY codigo, val."fechaCompra" NULLS LAST, p.id`);
    const grupos = new Map<
      number,
      {
        productoId: number;
        codigo: number;
        nombre: string;
        stock: number;
        costoUnitario: number | null;
      }
    >();
    for (const r of rows) {
      const codigo = Number(r.codigo);
      const unit =
        r.costo == null
          ? null
          : fromCents(
              Math.round(
                toCents(r.costo) / Math.max(1, Number(r.stockInicial || 1)),
              ),
            );
      const g = grupos.get(codigo);
      if (g) {
        g.stock += Number(r.stockActual);
        continue;
      }
      grupos.set(codigo, {
        productoId: Number(r.id),
        codigo,
        nombre: r.nombre || `Accesorio MS-${codigo}`,
        stock: Number(r.stockActual),
        costoUnitario: unit,
      });
    }
    return [...grupos.values()].sort((a, b) =>
      a.nombre.localeCompare(b.nombre),
    );
  }

  async ventaRapida(dto: VentaRapidaDto, manager?: EntityManager) {
    const grupo = `vr-${dto.idempotencyKey}`.slice(0, 64);
    const clave = (index: number) => `${dto.idempotencyKey}:${index}`;
    if (!manager) return this.dataSource.transaction((em) => this.ventaRapida(dto, em));
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [grupo]);
    const hash = operationHash(dto);
    {
      const ventaRepo = manager.getRepository(Venta);
      const previas = await ventaRepo.find({
        where: { operacionKey: In(dto.items.map((_, i) => clave(i))) },
        order: { id: 'ASC' },
      });
      if (previas.some((v) => v.operacionHash !== hash)) throw new ConflictException('La clave de operación ya se utilizó con otros datos.');
      if (previas.length === dto.items.length)
        return {
          grupoOperacion: previas[0].grupoOperacion,
          ventas: previas,
          repetida: true,
        };
      if (previas.length)
        throw new BadRequestException(
          'Esta operación quedó incompleta: revisa las ventas registradas antes de reintentar.',
        );

      const resumen = resumenVentaRapida(dto.items);
      let grupoFinal = grupo;
      if (dto.ventaRelacionadaId) {
        const principal = await ventaRepo.findOne({
          where: { id: dto.ventaRelacionadaId },
        });
        if (!principal)
          throw new BadRequestException('La venta relacionada no existe.');
        grupoFinal = principal.grupoOperacion || grupo;
        if (!principal.grupoOperacion)
          await ventaRepo.update(principal.id, { grupoOperacion: grupoFinal });
      }
      const cuenta = await this.cuentaParaCobro(dto, manager);
      const tipoCambio = dto.tipoCambio || (await this.ultimoTipoCambio(manager));
      const creadas: Venta[] = [];
      for (const [index, item] of dto.items.entries()) {
        const productoId =
          item.productoId ||
          (await this.crearProductoVentaRapida(item, dto.fecha, manager));
        const total = fromCents(toCents(item.precioUnitario) * item.cantidad);
        const parte =
          dto.estadoCobro === 'pagado' && dto.metodo === 'efectivo' && cuenta?.tipo !== 'tercero'
            ? 'cash'
            : dto.estadoCobro === 'pagado' &&
                !['tarjeta', 'x500'].includes(dto.metodo) &&
                cuenta?.tipo !== 'tercero'
              ? 'direct'
              : 'card';
        const venta = await this.ventas.conManager(manager).create({
          productoId,
          tipoCambio,
          fechaVenta: dto.fecha,
          precioVenta: total,
          cantidad: item.cantidad,
          modalidad: item.cantidad > 1 ? 'mayor' : 'unidad',
          vendedor: dto.vendedor,
          incomeParts: total > 0 ? [{ type: parte, amount: total }] : undefined,
          incomeBank: cuenta?.legacyCodigo || undefined,
          incomeAccountId: cuenta?.id,
          incomeMethod: dto.metodo,
        } as any);
        // Con producto registrado manda el costo del inventario; sin él, el costo indicado o "pendiente".
        const costoDesconocido = venta.costoPendiente || (!item.productoId && item.costoUnitario == null);
        await ventaRepo.update(venta.id, {
          ventaRapida: true,
          operacionKey: clave(index),
          operacionHash: hash,
          grupoOperacion: grupoFinal,
          costoPendiente: costoDesconocido,
          ...(costoDesconocido
            ? {
                ganancia: 0,
                porcentajeGanancia: 0,
                // Sin costo unitario guardado, el análisis existente marca el costo como no verificable.
                distribucionStock: (venta.distribucionStock || []).map(
                  ({ productoId: pid, cantidad }) => ({
                    productoId: pid,
                    cantidad,
                  }),
                ),
              }
            : {}),
        });
        if (dto.estadoCobro === 'pagado' && total > 0 && parte === 'card') {
          // Pagado por tarjeta (POS) o a un repartidor: queda pendiente de liquidación.
          await this.ledger.registrarPago({
            ventaId: venta.id,
            monto: total,
            fechaPago: dto.fecha,
            metodo: dto.metodo,
            cuentaReceptoraId: cuenta?.id,
            referencia: dto.referencia,
            idempotencyKey: `${dto.idempotencyKey}:${index}`,
          }, manager);
        }
        creadas.push((await ventaRepo.findOne({ where: { id: venta.id } }))!);
      }
      return {
        grupoOperacion: grupoFinal,
        ventas: creadas,
        resumen: centsToMoney(resumen),
        repetida: false,
      };
    }
  }

  private async cuentaParaCobro(dto: VentaRapidaDto, manager: EntityManager = this.dataSource.manager) {
    const repo = manager.getRepository(CuentaFinanciera);
    if (dto.cuentaReceptoraId) {
      const cuenta = await repo.findOne({
        where: { id: dto.cuentaReceptoraId },
      });
      if (!cuenta?.activo || cuenta.moneda !== 'PEN' || !['banco', 'billetera', 'efectivo', 'procesador', 'tercero'].includes(cuenta.tipo)) throw new BadRequestException('Cuenta de cobro inactiva o incompatible.');
      return cuenta;
    }
    if (dto.metodo === 'efectivo')
      return repo.findOne({ where: { codigo: 'efectivo' } });
    if (dto.metodo === 'tarjeta')
      return repo.findOne({ where: { codigo: 'procesador' } });
    if (dto.estadoCobro === 'pagado')
      throw new BadRequestException(
        'Selecciona la cuenta que recibió el pago.',
      );
    return null;
  }

  private async ultimoTipoCambio(manager: EntityManager = this.dataSource.manager) {
    const [row] = await manager.query(
      `SELECT "tipoCambio" FROM venta WHERE "tipoCambio" > 0 ORDER BY id DESC LIMIT 1`,
    );
    return Number(row?.tipoCambio) || 3.75;
  }

  /** Accesorio sin inventario previo: se crea un lote mínimo que se vende en el acto. */
  private async crearProductoVentaRapida(
    item: { nombre?: string; cantidad: number; costoUnitario?: number | null },
    fecha: string,
    manager?: EntityManager,
  ) {
    const run = async (manager: EntityManager) => {
      const detalle = await manager.getRepository(ProductoDetalle).save(
        manager.getRepository(ProductoDetalle).create({
          descripcionOtro: String(item.nombre || 'Accesorio').trim(),
          modelosCompatibles: [],
        }),
      );
      const costoTotal =
        item.costoUnitario == null
          ? null
          : fromCents(toCents(item.costoUnitario) * item.cantidad);
      const valor = await manager.getRepository(ProductoValor).save(
        manager.getRepository(ProductoValor).create({
          valorProducto: 0,
          valorDec: 0,
          peso: 0,
          fechaCompra: new Date(`${fecha}T12:00:00Z`),
          monedaCompra: 'PEN',
          valorSoles: costoTotal as any,
          costoEnvio: 0 as any,
          costoTotal: costoTotal as any,
        }),
      );
      const producto = await manager.getRepository(Producto).save(
        manager.getRepository(Producto).create({
          tipo: 'accesorios',
          estado: 'nuevo',
          accesorios: [],
          stockInicial: item.cantidad,
          stockActual: item.cantidad,
          soloInventario: true,
          origen: 'venta_rapida',
          detalle,
          valor,
          tracking: [],
        }),
      );
      return producto.id;
    };
    return manager ? run(manager) : this.dataSource.transaction(run);
  }
}

export function gastoPenCents(row: {
  moneda?: string;
  monto?: any;
  montoPen?: any;
  monto_pen?: any;
  tasa?: any;
  tasaUsdPen?: any;
}) {
  const pen = row.montoPen ?? row.monto_pen;
  if (pen != null && pen !== '') return toCents(pen);
  if (row.moneda === 'USD') {
    const rate = Number(row.tasa ?? row.tasaUsdPen);
    return Math.round(toCents(row.monto) * (rate > 0 ? rate : 0));
  }
  return toCents(row.monto);
}

export function reembolsoCalc(r: Reembolso) {
  const eventos = r.eventos || [];
  const rate = Number(r.tipoCambioCompra) || null;
  const aMoneda = (value: unknown) =>
    r.moneda === 'USD'
      ? rate
        ? Math.round(toCents(value) * rate)
        : 0
      : toCents(value);
  return {
    estado: r.estado,
    costoOriginalCents: toCents(r.costoOriginal),
    gastosAdicionalesCents: toCents(r.gastosAdicionales),
    reclamadoCents: aMoneda(r.montoReclamado),
    aprobadoCents: r.montoAprobado != null ? aMoneda(r.montoAprobado) : null,
    recibidoCents: eventos
      .filter((e) => e.tipo === 'recibido')
      .reduce((acc, e) => acc + toCents(e.montoPen), 0),
  };
}

/** Convierte las propiedades *Cents de un objeto a soles (número con 2 decimales). */
export function centsToMoney<T extends Record<string, any>>(
  obj: T,
): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key.endsWith('Cents'))
      out[key.slice(0, -5)] = value == null ? null : fromCents(value);
    else out[key] = value;
  }
  return out;
}

export { TIPOS_DISPONIBLES };
