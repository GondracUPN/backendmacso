import { cambioSaldoHistorico, cambioVentaConSaldo } from './saldo-cambio';
import { pedidoCliente } from '../venta/pedido-cliente';
import { operationHash } from '../venta/operation-hash';
import { Gasto } from '../gastos/entities/gasto.entity';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';
import { FinanzasLedgerService, toPagoCalc } from './finanzas-ledger.service';
import {
  finanzasVenta,
  fromCents,
  resumenPago,
  toCents,
} from './finanzas-calc';
import { Venta } from '../venta/venta.entity';
import { VentaPago } from './entities/venta-pago.entity';
import { Reembolso } from './entities/reembolso.entity';
import {
  CuentaFinanciera,
  TIPOS_DISPONIBLES,
} from './entities/cuenta-financiera.entity';
import { MovimientoFinanciero } from './entities/movimiento-financiero.entity';
import {
  AplicarSaldoDto,
  ClienteComercialDto,
  DevolverSaldoDto,
  GenerarSaldoDto,
} from './dto/saldos.dto';

export function distribuirSaldo(
  saldos: Array<{ id: number; disponible: string; fecha: string }>,
  monto: number,
  fecha: string,
) {
  let restante = toCents(monto);
  if (
    !Number.isSafeInteger(restante) ||
    restante <= 0 ||
    Math.abs(restante / 100 - monto) > 0.000001
  )
    throw new BadRequestException('Importe inválido.');
  const partes: Array<{ id: number; cents: number }> = [];
  const ordenados = [...saldos].sort((a, b) => toCents(a.disponible) - toCents(b.disponible) ||
    a.fecha.localeCompare(b.fecha) || a.id - b.id);
  for (const saldo of ordenados) {
    if (saldo.fecha > fecha) continue;
    const cents = Math.min(restante, toCents(saldo.disponible));
    if (cents > 0) partes.push({ id: saldo.id, cents });
    restante -= cents;
  }
  if (restante)
    throw new BadRequestException(
      'El importe supera el saldo disponible en esa fecha.',
    );
  return partes;
}
const money = (cents: number) => fromCents(cents).toFixed(2);

@Injectable()
export class SaldosClientesService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly ledger: FinanzasLedgerService,
  ) {}

  async resolverPedido(
    vendedor: string | null | undefined,
    userId: number,
    manager?: EntityManager,
  ) {
    const pedido = pedidoCliente(vendedor);
    if (!pedido) return null;
    const run = async (m: EntityManager) => {
      await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        'cliente-pedido:' + pedido.key,
      ]);
      const [existente] = await m.query(
        'SELECT * FROM clientes_comerciales WHERE pedido_key=$1',
        [pedido.key],
      );
      if (existente) {
        this.externo(existente);
        return existente;
      }
      // Adopta únicamente una identidad externa con nombre exacto normalizado; nunca coincidencias parciales.
      const anteriores = await m.query(
        `SELECT * FROM clientes_comerciales WHERE clase='externo' AND pedido_key IS NULL`,
      );
      const candidatos = anteriores.filter(
        (c) =>
          c.nombre
            .normalize('NFKC')
            .trim()
            .replace(/\s+/g, ' ')
            .toLocaleLowerCase('es-PE') === pedido.key,
      );
      if (candidatos.length > 1)
        throw new BadRequestException(
          'Hay clientes duplicados con ese nombre. Vincula la identidad antes de usar su saldo.',
        );
      if (candidatos.length === 1) {
        this.externo(candidatos[0]);
        await m.query(
          'UPDATE clientes_comerciales SET pedido_key=$1 WHERE id=$2',
          [pedido.key, candidatos[0].id],
        );
        const [c] = await m.query(
          'SELECT * FROM clientes_comerciales WHERE id=$1',
          [candidatos[0].id],
        );
        return c;
      }
      const [c] = await m.query(
        `INSERT INTO clientes_comerciales(nombre,clase,admite_saldo,pedido_key,creado_por) VALUES($1,'externo',true,$2,$3) RETURNING *`,
        [pedido.nombre, pedido.key, userId],
      );
      return c;
    };
    return manager ? run(manager) : this.db.transaction(run);
  }
  async resolverPedidoVenta(ventaId: number, userId: number) {
    return this.db.transaction(async (m) => {
      const v = await m
        .getRepository(Venta)
        .findOne({ where: { id: ventaId }, relations: ['producto'] });
      if (!v) throw new NotFoundException('Venta no encontrada.');
      const vendedor = pedidoCliente(v.vendedor)
        ? v.vendedor
        : v.producto?.vendedor;
      const c = await this.resolverPedido(vendedor, userId, m);
      if (!c) return null;
      if (v.clienteId && v.clienteId !== c.id)
        throw new BadRequestException(
          'La venta ya tiene saldo vinculado a otro cliente.',
        );
      await m.getRepository(Venta).update(v.id, { clienteId: c.id });
      return c;
    });
  }
  async clientes() {
    return this.db
      .query(`SELECT c.*, COALESCE((SELECT sum(disponible) FROM cliente_saldos s WHERE s.cliente_id=c.id),0)::text AS disponible
      FROM clientes_comerciales c ORDER BY c.nombre, c.id`);
  }
  async crearCliente(dto: ClienteComercialDto, userId: number) {
    if (dto.clase !== 'externo' && dto.admiteSaldo)
      throw new BadRequestException(
        'Solo los clientes externos admiten saldo.',
      );
    const [c] = await this.db.query(
      `INSERT INTO clientes_comerciales(nombre,clase,admite_saldo,creado_por) VALUES ($1,$2,$3,$4) RETURNING *`,
      [dto.nombre.trim(), dto.clase, dto.admiteSaldo, userId],
    );
    return c;
  }
  private async cliente(m: EntityManager, id: number) {
    const [c] = await m.query(
      'SELECT * FROM clientes_comerciales WHERE id=$1 FOR UPDATE',
      [id],
    );
    if (!c) throw new NotFoundException('Cliente no encontrado.');
    return c;
  }
  private externo(c: any) {
    if (c.clase !== 'externo' || !c.admite_saldo)
      throw new BadRequestException('Este comprador no admite saldos a favor.');
  }
  async asignar(ventaId: number, clienteId: number) {
    return this.db.transaction(async (m) => {
      await this.cliente(m, clienteId);
      const [v] = await m.query('SELECT * FROM venta WHERE id=$1 FOR UPDATE', [
        ventaId,
      ]);
      if (!v) throw new NotFoundException('Venta no encontrada.');
      if (v.cliente_id && v.cliente_id !== clienteId)
        throw new BadRequestException('La venta ya pertenece a otro cliente.');
      await m.query('UPDATE venta SET cliente_id=$1 WHERE id=$2', [
        clienteId,
        ventaId,
      ]);
      return { clienteId };
    });
  }
  /** Solo referencias exactas generadas por Ventas; nunca importe/fecha aproximados. */
  private async ingresosLegacy(
    m: EntityManager,
    v: Venta,
    contexto?: {
      ingresos: Gasto[];
      registrados: VentaPago[];
      conteos: Map<number, number>;
    },
  ): Promise<Gasto[]> {
    const base = '__SALE_INCOME__:' + v.productoId;
    const referencias = [
      base + ':' + v.id,
      ...['direct', 'card', 'debt', 'cash'].map(
        (t) => base + ':' + v.id + ':' + t,
      ),
    ];
    if (
      (contexto?.conteos.get(v.productoId) ??
        (await m
          .getRepository(Venta)
          .countBy({ productoId: v.productoId }))) === 1
    )
      referencias.push(
        base,
        ...['direct', 'card', 'debt', 'cash'].map((t) => base + ':' + t),
      );
    const rows = contexto
      ? contexto.ingresos.filter(
          (g) =>
            g.saleId === v.id ||
            (g.saleId == null && referencias.includes(g.notas || '')),
        )
      : await m.getRepository(Gasto).find({
          where: [
            {
              saleId: v.id,
              concepto: 'ingreso',
              metodoPago: 'debito',
              moneda: 'PEN',
            },
            {
              saleId: IsNull(),
              concepto: 'ingreso',
              metodoPago: 'debito',
              moneda: 'PEN',
              notas: In(referencias),
            },
          ],
          order: { id: 'ASC' },
        });
    if (!rows.length) return [];
    const registrados =
      contexto?.registrados ||
      (await m.getRepository(VentaPago).find({
        where: { gastoId: In(rows.map((g) => g.id)), anuladoAt: IsNull() },
      }));
    return rows.filter((g) => !registrados.some((p) => p.gastoId === g.id));
  }
  private ingresoRecibido(g: Gasto): number {
    if (!g.salePaymentType || g.salePaymentType === 'direct')
      return toCents(g.monto);
    return toCents(g.saleReceivedAmount);
  }
  private async pagosConCobroExplicito(m: EntityManager, pagos: VentaPago[], venta: Venta) {
    const ids = pagos.filter(p => p.origen === 'ingreso_venta' && p.gastoId).map(p => p.gastoId!);
    const ingresos = ids.length ? await m.getRepository(Gasto).findBy({ id: In(ids) }) : [];
    return pagos.filter(p => p.origen !== 'ingreso_venta' || !p.gastoId ||
      ingresos.some(g => g.id === p.gastoId && this.cobroConfirmado(g, venta) && this.ingresoRecibido(g) > 0));
  }
  private cobroConfirmado(g: Gasto, v: Venta) {
    // Los ingresos anteriores al desglose de pagos carecen de salePaymentType.
    // La conciliación explícita de la venta también confirma esos cobros.
    return Boolean(g.salePaymentType) || v.conciliacionHistorica === 'confirmada';
  }
  private async conciliarIngresosLegacy(m: EntityManager, v: Venta, automatico = false) {
    const ingresos = (await this.ingresosLegacy(m, v)).filter(g => !automatico || (this.cobroConfirmado(g, v) && this.ingresoRecibido(g) > 0));
    if (!ingresos.length) return;
    const pagos = await m
      .getRepository(VentaPago)
      .findBy({ ventaId: v.id, anuladoAt: IsNull() });
    // Versiones anteriores guardaban el adicional en el historial del ingreso,
    // sin enlazar gastoId en el pago. Recupera solo esa referencia exacta.
    for (const g of ingresos) {
      if (g.notas !== '__SALE_CREDIT_DIFFERENCE__:' + v.id) continue;
      const candidatos = pagos.filter(p => !p.gastoId && p.idempotencyKey?.startsWith('extra:') &&
        toCents(p.montoPen) === this.ingresoRecibido(g) &&
        g.salePaymentHistory?.some(h => h.pagoId === p.id));
      if (candidatos.length !== 1) continue;
      await m.getRepository(VentaPago).update(candidatos[0].id, { gastoId: g.id });
      candidatos[0].gastoId = g.id;
    }
    if (pagos.some((p) => !p.gastoId && p.origen !== 'saldo_cliente'))
      throw new BadRequestException(
        'Concilia los pagos manuales con los ingresos originales antes de convertirlos.',
      );
    if (
      ingresos.reduce((n, g) => n + this.ingresoRecibido(g), 0) >
      toCents(v.precioVenta)
    )
      throw new BadRequestException(
        'Los ingresos originales superan la venta; revisa la conciliación.',
      );
    await m.query(
      'SELECT id FROM gastos WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE',
      [ingresos.map((g) => g.id)],
    );
    for (const g of ingresos) {
      const [otro] = await m.query(
        'SELECT id FROM venta_pagos WHERE gasto_id=$1 AND venta_id<>$2 LIMIT 1',
        [g.id, v.id],
      );
      if (otro)
        throw new BadRequestException(
          'El ingreso original ya está vinculado a otra venta.',
        );
      await m.getRepository(Gasto).update(g.id, { saleId: v.id });
    }
    if (v.conciliacionHistorica === 'pendiente') {
      v.conciliacionHistorica = 'confirmada';
      await m.getRepository(Venta).update(v.id, {
        conciliacionHistorica: 'confirmada',
        conciliadaAt: new Date(),
        conciliacionNota:
          'Ingreso original vinculado al confirmar conversión a saldo: ' +
          ingresos.map((g) => g.id).join(', '),
      });
    }
    await this.ledger.sincronizarIngresosVenta(v.id, m, {
      incluirCanceladaParaSaldo: true,
    });
  }
  async importePagadoParaSaldo(v: Venta, m: EntityManager, automatico = false): Promise<number> {
    const pagos = automatico ? await this.pagosConCobroExplicito(m,
      await m.getRepository(VentaPago).find({ where: { ventaId: v.id }, relations: ['liquidaciones'] }), v) : null;
    const resumen = finanzasVenta(
      this.ledger.ventaCalc(v),
      pagos ? pagos.map(toPagoCalc) : await this.ledger.pagosCalc(m, { ventaId: v.id }),
    );
    const legacy = (await this.ingresosLegacy(m, v)).filter(g => !automatico || this.cobroConfirmado(g, v));
    return (
      Math.max(0, resumen.cobradoClienteCents) +
      legacy.reduce((n, g) => n + this.ingresoRecibido(g), 0)
    );
  }
  async historial(clienteId: number) {
    const [cliente] = await this.db.query(
      'SELECT * FROM clientes_comerciales WHERE id=$1',
      [clienteId],
    );
    if (!cliente) throw new NotFoundException('Cliente no encontrado.');
    const saldos = await this.db.query(
      `SELECT s.*, s.fecha::text AS fecha, p.origen AS pago_origen,
        CASE WHEN p.origen='saldo_cliente' THEN 'saldo_recuperado'
          WHEN p.idempotency_key LIKE 'extra:%' THEN 'pago_recuperado'
          ELSE 'pago_convertido' END AS origen_saldo
       FROM cliente_saldos s LEFT JOIN venta_pagos p ON p.id=s.pago_id
       WHERE s.cliente_id=$1 ORDER BY s.fecha,s.id`,
      [clienteId],
    );
    const movimientos = await this.db.query(
      `SELECT m.*, m.fecha::text AS fecha, s.sku AS sku_origen, COALESCE(p."codigoInventario",p.id) AS sku_destino, s.tipo_cambio,
        EXISTS(SELECT 1 FROM cliente_saldos retorno WHERE retorno.pago_id=m.pago_id AND retorno.anulada_at IS NULL) AS saldo_recuperado
      FROM cliente_saldo_movimientos m JOIN cliente_saldos s ON s.id=m.saldo_id
      LEFT JOIN venta v ON v.id=m.venta_id LEFT JOIN producto p ON p.id=v."productoId"
      WHERE s.cliente_id=$1 ORDER BY m.fecha,m.id`,
      [clienteId],
    );
    const clavePedidoSql = (alias: string) =>
      'lower(regexp_replace(btrim(substring(' +
      alias +
      ".vendedor from '(?i)^gonzalo[[:space:]]*[(]([^)]*)[)]$')), '[[:space:]]+', ' ', 'g'))";
    const posibles = await this.db
      .getRepository(Venta)
      .createQueryBuilder('v')
      .leftJoinAndSelect('v.producto', 'p')
      .where('v.clienteId=:clienteId', { clienteId })
      .orWhere(
        'v.clienteId IS NULL AND (' +
          clavePedidoSql('v') +
          '=:key OR ' +
          clavePedidoSql('p') +
          '=:key)',
        { key: cliente.pedido_key || null },
      )
      .orderBy('v.id', 'ASC')
      .getMany();
    const ventas = posibles.filter(
      (v) =>
        v.clienteId === clienteId ||
        (cliente.pedido_key &&
          (pedidoCliente(v.vendedor) || pedidoCliente(v.producto?.vendedor))
            ?.key === cliente.pedido_key),
    );
    const ids = ventas.map((v) => v.id),
      productoIds = ventas.map((v) => v.productoId);
    const referencias = ventas.flatMap((v) => {
      const base = '__SALE_INCOME__:' + v.productoId;
      return [
        base,
        base + ':' + v.id,
        ...['direct', 'card', 'debt', 'cash'].flatMap((t) => [
          base + ':' + t,
          base + ':' + v.id + ':' + t,
        ]),
      ];
    });
    const [pagosTodos, ingresos, conteos] = ids.length
      ? await Promise.all([
          this.db.getRepository(VentaPago).find({
            where: { ventaId: In(ids) },
            relations: ['liquidaciones'],
            order: { id: 'ASC' },
          }),
          this.db.getRepository(Gasto).find({
            where: [
              {
                saleId: In(ids),
                concepto: 'ingreso',
                metodoPago: 'debito',
                moneda: 'PEN',
              },
              {
                saleId: IsNull(),
                concepto: 'ingreso',
                metodoPago: 'debito',
                moneda: 'PEN',
                notas: In(referencias),
              },
            ],
            order: { id: 'ASC' },
          }),
          this.db.query(
            'SELECT "productoId",count(*)::int AS n FROM venta WHERE "productoId"=ANY($1::int[]) GROUP BY "productoId"',
            [productoIds],
          ),
        ])
      : [[], [], []];
    const registrados = ingresos.length
      ? await this.db.getRepository(VentaPago).find({
          where: {
            gastoId: In(ingresos.map((g) => g.id)),
            anuladoAt: IsNull(),
          },
        })
      : [];
    const contexto = {
      ingresos,
      registrados,
      conteos: new Map<number, number>(
        conteos.map((r) => [Number(r.productoId), Number(r.n)]),
      ),
    };
    const operaciones = [] as any[];
    for (const v of ventas) {
      const pagos = pagosTodos.filter((p) => p.ventaId === v.id);
      const resumen = finanzasVenta(
        this.ledger.ventaCalc(v),
        pagos.map(toPagoCalc),
      );
      const producto = { sku: v.producto?.codigoInventario || v.productoId };
      const legacy = await this.ingresosLegacy(this.db.manager, v, contexto);
      const legacyPagado = legacy.reduce(
        (n, g) => n + this.ingresoRecibido(g),
        0,
      );
      const recibido = Math.max(0, resumen.cobradoClienteCents) + legacyPagado;
      const convertible = v.anuladaAt
        ? 0
        : Math.min(toCents(v.precioVenta), recibido);
      operaciones.push({
        sku: producto?.sku,
        ventaId: v.id,
        productoId: v.productoId,
        estadoComercial: v.estadoComercial,
        anulada: !!v.anuladaAt,
        afectada:
          !!v.producto?.cierreMotivo || v.estadoComercial === 'cancelada',
        convertible: money(convertible),
        deuda: money(Math.max(0, resumen.saldoPendienteCents - legacyPagado)),
        pagos,
        ingresosOriginales: legacy.map((g) => ({
          id: g.id,
          monto: money(this.ingresoRecibido(g)),
          fecha: String(g.fecha).slice(0, 10),
        })),
      });
    }
    const devoluciones = await this.db.query(`SELECT r.id, r.producto_id, COALESCE(p."codigoInventario",p.id) sku,
        r.fecha_incidencia::text fecha, r.estado, r.motivo, ultima.id venta_id,
        COALESCE(ultima."precioVenta",0)::numeric(12,2)::text precio_venta,
        COALESCE(credito.original,0)::numeric(12,2)::text saldo_generado, COALESCE(credito.disponible,0)::numeric(12,2)::text disponible,
        GREATEST(0,COALESCE(ultima."precioVenta",0)-COALESCE(credito.original,0))::numeric(12,2)::text importe_sin_pagar
      FROM reembolsos r JOIN producto p ON p.id=r.producto_id
      LEFT JOIN LATERAL (SELECT v.id,v."precioVenta" FROM venta v
        WHERE v."productoId"=p.id AND v.id=ANY($2::int[])
        ORDER BY EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(r.reversion_reclamo->'ventas','[]'::jsonb)) x WHERE (x->>'id')::int=v.id) DESC,v.id DESC LIMIT 1) ultima ON true
      LEFT JOIN LATERAL (SELECT sum(s.original) original,sum(s.disponible) disponible FROM cliente_saldos s
        WHERE s.venta_id=ultima.id AND s.cliente_id=$1 AND s.anulada_at IS NULL) credito ON true
      WHERE r.estado<>'anulado' AND (p.id=ANY($3::int[]) OR ${clavePedidoSql('p')}=$4)
      ORDER BY r.fecha_incidencia DESC,r.id DESC`, [clienteId, ids, productoIds, cliente.pedido_key || null]);
    return {
      cliente,
      saldos,
      devoluciones,
      movimientos,
      ventas: operaciones,
      disponible: money(saldos.reduce((n, s) => n + toCents(s.disponible), 0)),
    };
  }
  async generar(
    ventaId: number,
    dto: GenerarSaldoDto,
    userId: number,
    manager?: EntityManager,
    automatico = false,
  ) {
    const fecha =
      dto.fecha ||
      new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
    const motivo =
      dto.motivo ||
      'Venta anulada y pago conservado como saldo a favor del cliente';
    const run = async (m: EntityManager) => {
      const preliminary = await m
        .getRepository(Venta)
        .findOne({ where: { id: ventaId }, relations: ['producto'] });
      if (!preliminary) throw new NotFoundException('Venta no encontrada.');
      const pedido = preliminary.clienteId
        ? null
        : await this.resolverPedido(
            pedidoCliente(preliminary.vendedor)
              ? preliminary.vendedor
              : preliminary.producto?.vendedor,
            userId,
            m,
          );
      const clienteId = preliminary.clienteId || pedido?.id;
      if (!clienteId)
        throw new BadRequestException(
          'La venta no pertenece a un cliente externo de pedido.',
        );
      this.externo(await this.cliente(m, clienteId));
      const v = await m.getRepository(Venta).findOne({
        where: { id: ventaId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!v || v.anuladaAt || (v.clienteId && v.clienteId !== clienteId))
        throw new BadRequestException('Venta no válida para convertir pagos.');
      if (!v.clienteId) {
        await m.getRepository(Venta).update(v.id, { clienteId });
        v.clienteId = clienteId;
      }
      const existentes = await m.query(
        'SELECT id FROM cliente_saldos WHERE venta_id=$1 AND anulada_at IS NULL',
        [ventaId],
      );
      if (existentes.length)
        throw new BadRequestException(
          'Los pagos de esta venta ya se convirtieron en saldo.',
        );
      await this.conciliarIngresosLegacy(m, v, automatico);
      const registrados = await m.getRepository(VentaPago).find({
        where: { ventaId, anuladoAt: IsNull() },
        relations: ['liquidaciones'],
        order: { id: 'ASC' },
      });
      const pagos = automatico ? await this.pagosConCobroExplicito(m, registrados, v) : registrados;
      if (!pagos.length)
        throw new BadRequestException(
          'La venta no tiene pagos efectivos registrados.',
        );
      const [producto] = await m.query(
        'SELECT COALESCE("codigoInventario",id) AS sku FROM producto WHERE id=$1',
        [v.productoId],
      );
      let total = 0;
      for (const p of pagos) {
        const calc = toPagoCalc(p),
          r = resumenPago(calc);
        if (
          !p.verificado ||
          !p.fechaPago ||
          p.fechaPago > fecha ||
          (p.origen === 'saldo_cliente' && !automatico) ||
          calc.disputado ||
          r.contracargoCents ||
          r.pendienteLiquidacionCents ||
          toCents(p.saldoConvertido)
        )
          throw new BadRequestException(
            'Concilia los pagos, fechas, disputas y liquidaciones antes de convertirlos.',
          );
        const cents = toCents(p.montoPen) - r.devueltoCents;
        if (cents <= 0) continue;
        const tc = String(p.origen === 'saldo_cliente' || p.idempotencyKey?.startsWith('extra:')
          ? p.tipoCambio || v.tipoCambio : v.tipoCambio);
        if (!(Number(tc) > 0))
          throw new BadRequestException('Falta el tipo de cambio histórico.');
        await m.query(
          `INSERT INTO cliente_saldos(cliente_id,venta_id,pago_id,sku,original,disponible,moneda,monto_original,tipo_cambio,fecha,motivo,creado_por,equivalente_usd)
          VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT (pago_id) DO UPDATE SET disponible=EXCLUDED.disponible, fecha=EXCLUDED.fecha, motivo=EXCLUDED.motivo, anulada_at=NULL
          WHERE cliente_saldos.anulada_at IS NOT NULL`,
          [
            v.clienteId,
            v.id,
            p.id,
            producto.sku,
            money(cents),
            p.moneda,
            p.monto,
            tc,
            fecha,
            motivo,
            userId,
            money(Math.round(cents / Number(tc))),
          ],
        );
        await m
          .getRepository(VentaPago)
          .update(p.id, { saldoConvertido: money(cents) });
        total += cents;
      }
      if (!total)
        throw new BadRequestException(
          'No hay dinero pagado disponible para convertir.',
        );
      // Cancelación comercial: se conservan cobros, ingresos bancarios y el importe original.
      await m
        .getRepository(Venta)
        .update(v.id, { estadoComercial: 'cancelada' });
      // Convertir el cobro en saldo cancela la venta, pero no cierra el producto.
      // El reclamo de compra establece su propio cierre en FinanzasService.
      return { monto: money(total), ventaId, clienteId: v.clienteId };
    };
    return manager ? run(manager) : this.db.transaction(run);
  }
  /** Anulación/reembolso confirmado: conserva el cobro y genera saldo una sola vez. */
  async cancelarPedidoConSaldo(
    ventaId: number,
    fecha: string,
    userId: number,
    m: EntityManager,
  ) {
    await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      'saldo-cancelacion:' + ventaId,
    ]);
    const v = await m
      .getRepository(Venta)
      .findOne({ where: { id: ventaId }, relations: ['producto'] });
    if (!v) return false;
    const esPedido = pedidoCliente(v.vendedor) || pedidoCliente(v.producto?.vendedor);
    if (!esPedido && !(v.clienteId && await m.getRepository(VentaPago).countBy({
      ventaId, origen: 'saldo_cliente', anuladoAt: IsNull(),
    }))) return false;
    const existentes = await m.query(
      'SELECT id FROM cliente_saldos WHERE venta_id=$1 AND anulada_at IS NULL',
      [ventaId],
    );
    if (existentes.length) return true;
    // Actualiza derivados antiguos: elegir efectivo no confirma que el cliente pagó.
    if (!v.anuladaAt) await this.ledger.sincronizarIngresosVenta(v.id, m, { incluirCanceladaParaSaldo: true });
    if (v.anuladaAt || (await this.importePagadoParaSaldo(v, m, true)) <= 0)
      return false;
    await this.generar(ventaId, { fecha }, userId, m, true);
    await m.getRepository(Venta).update(ventaId, {
      anuladaAt: new Date(),
      anuladaPor: userId,
      anulacionMotivo:
        'Anulación: pago conservado como saldo a favor del cliente',
    });
    return true;
  }
  async reembolsarProductoCliente(
    productoId: number,
    fecha: string,
    userId: number,
    m: EntityManager,
  ) {
    const ventas = await m
      .getRepository(Venta)
      .find({ where: { productoId }, order: { id: 'ASC' } });
    const convertidas: NonNullable<import('./entities/reembolso.entity').Reembolso['reversionReclamo']>['ventas'] = [];
    for (const v of ventas) {
      await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['saldo-cancelacion:' + v.id]);
      const existentes = await m.query('SELECT id FROM cliente_saldos WHERE venta_id=$1 AND anulada_at IS NULL', [v.id]);
      if (existentes.length) continue;
      if (await this.cancelarPedidoConSaldo(v.id, fecha, userId, m)) {
        const saldos = await m.query('SELECT id FROM cliente_saldos WHERE venta_id=$1 AND anulada_at IS NULL', [v.id]);
        convertidas.push({ id: v.id, estadoComercial: v.estadoComercial, anuladaAt: v.anuladaAt?.toISOString() || null,
          anuladaPor: v.anuladaPor ?? null, anulacionMotivo: v.anulacionMotivo ?? null, saldoIds: saldos.map(s => s.id) });
      }
    }
    return convertidas;
  }
  async actualizarSaldoPorReclamo(productoId: number, userId: number, m: EntityManager) {
    const r = await m.getRepository(Reembolso).createQueryBuilder('r')
      .where('r.productoId=:productoId', { productoId })
      .andWhere("r.estado NOT IN ('anulado','rechazado','perdida_definitiva')")
      .orderBy('r.id', 'DESC').setLock('pessimistic_write').getOne();
    if (!r) return false;
    const [pago] = await m.query(`SELECT max(p.fecha_pago)::text fecha FROM venta_pagos p
      JOIN venta v ON v.id=p.venta_id WHERE v."productoId"=$1 AND p.anulado_at IS NULL AND p.verificado=true`, [productoId]);
    const fecha = [r.fechaIncidencia, pago?.fecha].filter(Boolean).sort().pop();
    if (!fecha) return false;
    const ventas = await this.reembolsarProductoCliente(productoId, fecha, userId, m);
    if (!ventas.length) return false;
    r.reversionReclamo = { cierreMotivo: r.reversionReclamo?.cierreMotivo ?? null,
      ventas: [...(r.reversionReclamo?.ventas || []), ...ventas] };
    await m.getRepository(Reembolso).save(r);
    return true;
  }
  async prepararCambioSaldo(clienteId:number,dto:AplicarSaldoDto,m:EntityManager, precioVenta?: number) {
    this.externo(await this.cliente(m,clienteId));
    const saldos=await m.query('SELECT *,fecha::text AS fecha FROM cliente_saldos WHERE cliente_id=$1 AND disponible>0 ORDER BY cliente_saldos.fecha,cliente_saldos.id FOR UPDATE',[clienteId]);
    const partes=distribuirSaldo(saldos,dto.monto,dto.fecha);
    return cambioVentaConSaldo(partes.map(p=>({cents:p.cents,tipoCambio:saldos.find(s=>s.id===p.id)!.tipo_cambio})),
      dto.pagoAdicional ? Math.max(0, toCents(precioVenta) - toCents(dto.monto)) : 0, dto.tipoCambioPagoAdicional);
  }
  async aplicar(
    ventaId: number,
    dto: AplicarSaldoDto,
    userId: number,
    manager?: EntityManager,
  ) {
    const run = async (m: EntityManager) => {
      await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        'saldo-operacion:' + dto.operacion,
      ]);
      const hash = operationHash({ ventaId, ...dto });
      const preliminary = await m
        .getRepository(Venta)
        .findOneBy({ id: ventaId });
      if (!preliminary?.clienteId)
        throw new BadRequestException('Selecciona el cliente de la venta.');
      this.externo(await this.cliente(m, preliminary.clienteId));
      const v = await m.getRepository(Venta).findOne({
        where: { id: ventaId },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        !v ||
        v.clienteId !== preliminary.clienteId ||
        v.estadoComercial === 'cancelada' ||
        v.anuladaAt
      )
        throw new BadRequestException('Venta no válida para aplicar saldo.');
      const repetidos = await m.query(
        'SELECT * FROM cliente_saldo_movimientos WHERE operacion=$1',
        [dto.operacion],
      );
      if (repetidos.length) {
        if (
          repetidos.some(
            (r) =>
              r.venta_id !== ventaId ||
              r.tipo !== 'aplicacion' ||
              r.operacion_hash !== hash,
          ) ||
          repetidos.reduce((n, r) => n + toCents(r.monto), 0) !==
            toCents(dto.monto)
        )
          throw new BadRequestException('Clave utilizada para otra operación.');
        return { ventaId, aplicado: money(toCents(dto.monto)) };
      }
      const pagos = await this.ledger.pagosCalc(m, { ventaId });
      const deuda = finanzasVenta(
        this.ledger.ventaCalc(v),
        pagos,
      ).saldoPendienteCents;
      if (toCents(dto.monto) > deuda)
        throw new BadRequestException(
          'El saldo aplicado supera la deuda de esta venta.',
        );
      const saldos = await m.query(
        'SELECT *, fecha::text AS fecha FROM cliente_saldos WHERE cliente_id=$1 AND disponible>0 ORDER BY cliente_saldos.fecha,cliente_saldos.id FOR UPDATE',
        [v.clienteId],
      );
      const partes = distribuirSaldo(saldos, dto.monto, dto.fecha);
      const cambio=cambioSaldoHistorico(partes.map(p=>({cents:p.cents,tipoCambio:saldos.find(s=>s.id===p.id)!.tipo_cambio})));
      const repo = m.getRepository(VentaPago);
      const p = await repo.save(
        repo.create({
          ventaId,
          monto: money(toCents(dto.monto)),
          montoPen: money(toCents(dto.monto)),
          moneda: 'PEN',
          fechaPago: dto.fecha,
          metodo: 'otro',
          estado: 'disponible',
          requiereLiquidacion: false,
          comisionEstimada: '0.00',
          esAdelanto: false,
          origen: 'saldo_cliente',
          tipoCambio: cambio.tipoCambio.toFixed(4),
          verificado: true,
          idempotencyKey: 'saldo:' + dto.operacion,
          observacion:
            'Aplicación de saldo a favor; sin ingreso bancario nuevo',
        }),
      );
      for (const parte of partes) {
        await m.query(
          'UPDATE cliente_saldos SET disponible=disponible-$1::numeric WHERE id=$2',
          [money(parte.cents), parte.id],
        );
        await m.query(
          `INSERT INTO cliente_saldo_movimientos(saldo_id,venta_id,pago_id,tipo,monto,fecha,operacion,creado_por,operacion_hash) VALUES($1,$2,$3,'aplicacion',$4,$5,$6,$7,$8)`,
          [
            parte.id,
            ventaId,
            p.id,
            money(parte.cents),
            dto.fecha,
            dto.operacion,
            userId,
            hash,
          ],
        );
      }
      const restante = deuda - toCents(dto.monto);
      const ingresos = await m.getRepository(Gasto).find({
        where: { saleId: ventaId, concepto: 'ingreso' },
        order: { id: 'ASC' },
      });
      let ingresoDiferencia: Gasto | undefined;
      if (!ingresos.length && restante > 0) {
        const [producto] = await m.query('SELECT id,tipo,"codigoInventario" FROM producto WHERE id=$1', [v.productoId]);
        ingresoDiferencia = await m.getRepository(Gasto).save({
          userId,
          concepto: 'ingreso',
          metodoPago: 'debito',
          moneda: 'PEN',
          monto: money(restante),
          montoPen: money(restante),
          fecha: v.fechaVenta,
          saleId: ventaId,
          saleSku: `${String(producto.tipo).toLowerCase() === 'accesorios' ? 'ACC' : 'MS'}-${producto.codigoInventario || producto.id}`,
          salePaymentType: 'debt',
          saleReceivedAmount: '0.00',
          salePaidAt: null,
          saleCuentaId: dto.cuentaId || null,
          notas: '__SALE_CREDIT_DIFFERENCE__:' + ventaId,
        });
      } else if (ingresos.length) {
        let reducir = toCents(dto.monto);
        for (const ingreso of ingresos) {
          if (!['debt', 'card'].includes(ingreso.salePaymentType || ''))
            continue;
          const parte = Math.min(
            reducir,
            Math.max(
              0,
              toCents(ingreso.monto) - toCents(ingreso.saleReceivedAmount),
            ),
          );
          if (!parte) continue;
          await m.getRepository(Gasto).update(ingreso.id, {
            monto: money(toCents(ingreso.monto) - parte),
            montoPen: money(toCents(ingreso.monto) - parte),
          });
          reducir -= parte;
        }
      }
      if (restante > 0 && dto.pagoAdicional) {
        if (!dto.fechaPago || !dto.cuentaId)
          throw new BadRequestException(
            'Indica la fecha efectiva y cuenta del pago adicional.',
          );
        const tipoCambioAdicional = restante >= toCents(dto.monto) ? dto.tipoCambioPagoAdicional : cambio.tipoCambio;
        if (!(Number(tipoCambioAdicional) > 0)) throw new BadRequestException('Indica el tipo de cambio del pago adicional.');
        const pago = await this.ledger.registrarPago(
          {
            ventaId,
            monto: fromCents(restante),
            moneda: 'PEN',
            tipoCambio: Number(tipoCambioAdicional),
            fechaPago: dto.fechaPago,
            metodo: 'transferencia',
            cuentaReceptoraId: dto.cuentaId,
            idempotencyKey: 'extra:' + dto.operacion,
          },
          m,
        );
        if (ingresoDiferencia) {
          const cuenta = await m.getRepository(CuentaFinanciera).findOneByOrFail({ id: dto.cuentaId });
          await m.getRepository(Gasto).update(ingresoDiferencia.id, {
            salePaymentType: 'direct', saleReceivedAmount: money(restante), salePaidAt: dto.fechaPago,
            fecha: dto.fechaPago, tarjeta: cuenta.legacyCodigo || cuenta.codigo,
            saleExchangeRate: Number(tipoCambioAdicional).toFixed(4),
          });
        }
        await m.getRepository(VentaPago).update(pago.id, {
          tipoCambio: Number(tipoCambioAdicional).toFixed(4),
          ...(ingresoDiferencia ? { gastoId: ingresoDiferencia.id } : {}),
        });
      }
      return {
        ventaId,
        aplicado: money(toCents(dto.monto)),
        pendiente: dto.pagoAdicional ? '0.00' : money(restante),
      };
    };
    return manager ? run(manager) : this.db.transaction(run);
  }
  async devolver(clienteId: number, dto: DevolverSaldoDto, userId: number) {
    return this.db.transaction(async (m) => {
      await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        'saldo-operacion:' + dto.operacion,
      ]);
      const hash = operationHash({ clienteId, ...dto });
      this.externo(await this.cliente(m, clienteId));
      const saldos = await m.query(
        'SELECT *,fecha::text AS fecha FROM cliente_saldos WHERE cliente_id=$1 ORDER BY cliente_saldos.fecha,cliente_saldos.id FOR UPDATE',
        [clienteId],
      );
      const repetidos = await m.query(
        'SELECT * FROM cliente_saldo_movimientos WHERE operacion=$1',
        [dto.operacion],
      );
      if (repetidos.length) {
        if (
          repetidos.some(
            (r) => r.tipo !== 'devolucion' || r.operacion_hash !== hash,
          )
        )
          throw new BadRequestException('Clave utilizada para otra operación.');
        return m
          .getRepository(MovimientoFinanciero)
          .findOneBy({ id: repetidos[0].movimiento_id });
      }
      const partes = distribuirSaldo(saldos, dto.monto, dto.fecha);
      const cuenta = await m
        .getRepository(CuentaFinanciera)
        .findOneBy({ id: dto.cuentaId });
      if (!cuenta?.activo || !TIPOS_DISPONIBLES.includes(cuenta.tipo))
        throw new BadRequestException('Selecciona una cuenta disponible.');
      const movimiento = await m.getRepository(MovimientoFinanciero).save({
        tipo: 'ajuste',
        fecha: dto.fecha,
        cuentaOrigenId: cuenta.id,
        monto: money(toCents(dto.monto)),
        moneda: 'PEN',
        montoPen: money(toCents(dto.monto)),
        idempotencyKey: 'devolver:' + dto.operacion,
        createdBy: userId,
        nota: 'Devolución de saldo del cliente ' + clienteId,
      });
      for (const parte of partes) {
        await m.query(
          'UPDATE cliente_saldos SET disponible=disponible-$1::numeric WHERE id=$2',
          [money(parte.cents), parte.id],
        );
        await m.query(
          `INSERT INTO cliente_saldo_movimientos(saldo_id,movimiento_id,tipo,monto,fecha,operacion,creado_por,operacion_hash) VALUES($1,$2,'devolucion',$3,$4,$5,$6,$7)`,
          [
            parte.id,
            movimiento.id,
            money(parte.cents),
            dto.fecha,
            dto.operacion,
            userId,
            hash,
          ],
        );
      }
      return movimiento;
    });
  }
}
