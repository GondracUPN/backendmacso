import { VentaService } from '../venta/venta.service';
import { VentaAdelanto } from '../venta/venta-adelanto.entity';
import { ProductoValor } from '../producto/producto-valor.entity';
/** PostgreSQL desechable: solo acepta una base local con nombre *_test. */
import { DataSource } from 'typeorm';
import { join } from 'path';
import { Producto } from '../producto/producto.entity';
import { Venta } from '../venta/venta.entity';
import { VentaPago } from './entities/venta-pago.entity';
import { Gasto } from '../gastos/entities/gasto.entity';
import { User } from '../auth/entities/user.entity';
import { CuentaFinanciera } from './entities/cuenta-financiera.entity';
import { Reembolso } from './entities/reembolso.entity';
import { FinanzasService } from './finanzas.service';
import { FinanzasLedgerService } from './finanzas-ledger.service';
import { FinanzasAnalisisService } from './finanzas-analisis.service';
import { SaldosClientesService } from './saldos-clientes.service';
import { prepareLocalDatabase } from '../db/local-schema';
import { finanzasVenta } from './finanzas-calc';
import { ReclamoSaldoInmediato1794096000000 } from '../migrations/1794096000000-ReclamoSaldoInmediato';
import { ConstanciaVentaOculta1794268800000 } from '../migrations/1794268800000-ConstanciaVentaOculta';
import { DiferenciaSaldoDirecta1794355200000 } from '../migrations/1794355200000-DiferenciaSaldoDirecta';
import { AnulacionVentaSinPerdida1794441600000 } from '../migrations/1794441600000-AnulacionVentaSinPerdida';
import { repararSaldosReclamoSinCobro } from './reclamo-saldos-reparacion';
import { reabrirProductoConReclamosAnulados } from './reclamo-producto-disponibilidad';
import { Inventario } from '../inventario/inventario.entity';
import { InventarioService } from '../inventario/inventario.service';

const url = process.env.RECLAMOS_SALDOS_TEST_URL;
if (url && url !== 'postgres://codex_test@127.0.0.1:55439/reclamos_saldos_test')
  throw new Error('Usar únicamente la instancia desechable documentada.');
const suite = url ? describe : describe.skip;
jest.setTimeout(60000);
suite('Reclamos y saldos: PostgreSQL aislado', () => {
  let ds: DataSource,
    ledger: FinanzasLedgerService,
    fin: FinanzasService,
    saldos: SaldosClientesService;
  let userId: number,
    cuentaId: number,
    tarjetaId: number,
    seq = 0;
  const key = () => 'test-operacion-' + ++seq;
  const dia = '2026-11-12';
  const reclamoDia = () =>
    new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      url,
      entities: [join(__dirname, '../**/*.entity.ts')],
      synchronize: true,
      dropSchema: true,
    });
    await ds.initialize();
    await prepareLocalDatabase(ds);
    userId = (
      await ds
        .getRepository(User)
        .save({ username: 'test-admin', passwordHash: 'x', role: 'admin' })
    ).id;
    cuentaId = (
      await ds.getRepository(CuentaFinanciera).save({
        codigo: 'bcp',
        nombre: 'Banco de prueba',
        tipo: 'banco',
        moneda: 'PEN',
        legacyCodigo: 'bcp',
      })
    ).id;
    tarjetaId = (
      await ds.getRepository(CuentaFinanciera).save({
        codigo: 'visa-test',
        nombre: 'Tarjeta de prueba',
        tipo: 'tarjeta_credito',
        moneda: 'USD',
        legacyCodigo: 'bcp_visa',
      })
    ).id;
    ledger = new FinanzasLedgerService(ds);
    saldos = new SaldosClientesService(ds, ledger);
    fin = new FinanzasService(ds, ledger, {} as any, saldos);
  });
  afterAll(async () => {
    await ds?.destroy();
  });
  const cliente = (clase: 'externo' | 'propio' | 'renato' = 'externo') =>
    saldos.crearCliente(
      { nombre: 'Cliente ' + key(), clase, admiteSaldo: clase === 'externo' },
      userId,
    );
  const producto = async (usd = 750.19) =>
    ds.getRepository(Producto).save(
      ds.getRepository(Producto).create({
        tipo: 'macbook',
        estado: 'usado',
        accesorios: [],
        vendedor: 'Gonzalo',
        valor: {
          valorProducto: usd,
          valorDec: 0,
          peso: 1,
          fechaCompra: new Date('2026-10-10T12:00:00Z'),
          monedaCompra: 'USD',
          tipoCambioCompra: 3.4,
          valorSoles: Number((usd * 3.4).toFixed(2)),
          costoEnvio: 123.45,
          costoTotal: Number((usd * 3.4 + 123.45).toFixed(2)),
        } as any,
      }),
    );
  const venta = async (clienteId: number, precio = 3000) => {
    const p = await producto();
    return ds.getRepository(Venta).save({
      productoId: p.id,
      clienteId,
      precioVenta: precio,
      tipoCambio: 3.4,
      fechaVenta: '2026-10-10',
      ganancia: 100,
      porcentajeGanancia: 10,
      vendedor: 'Gonzalo',
      estadoComercial: 'entregada',
      conciliacionHistorica: 'no_aplica',
    });
  };
  const pago = async (v: Venta, monto = 3000) =>
    ledger.registrarPago({
      ventaId: v.id,
      monto,
      moneda: 'PEN',
      fechaPago: '2026-10-11',
      metodo: 'transferencia',
      cuentaReceptoraId: cuentaId,
      idempotencyKey: key(),
    });
  const generar = (v: Venta) =>
    saldos.generar(
      v.id,
      { fecha: '2026-11-01', motivo: 'Reemplazo por producto no recibido' },
      userId,
    );
  const aplicar = (v: Venta, monto: number, extra = false, op = key()) =>
    saldos.aplicar(
      v.id,
      {
        monto,
        fecha: dia,
        operacion: op,
        pagoAdicional: extra,
        ...(extra ? { fechaPago: dia, cuentaId } : {}),
      },
      userId,
    );
  const situacion = async (v: Venta) =>
    finanzasVenta(
      ledger.ventaCalc(
        (await ds.getRepository(Venta).findOneBy({ id: v.id }))!,
      ),
      await ledger.pagosCalc(ds.manager, { ventaId: v.id }),
    );
  const conSaldo = async (monto = 3000) => {
    const c = await cliente(),
      v = await venta(c.id, monto);
    await pago(v, monto);
    await generar(v);
    return { c, v };
  };

  it.each(['No llegó a Eshopex.', 'Llegó algo distinto al producto comprado.'])(
    'registra motivo permitido: %s',
    async (motivo) => {
      const p = await producto();
      const r = await fin.crearReembolso({ productoId: p.id, motivo }, userId);
      expect(r).toMatchObject({
        moneda: 'USD',
        montoReclamado: '750.19',
        gastosAdicionales: '0.00',
        estado: 'reclamo_abierto',
        fechaIncidencia: reclamoDia(),
      });
      expect(
        (await ds.getRepository(Producto).findOneBy({ id: p.id }))
          ?.cierreMotivo,
      ).toBe('no_comercializable');
      await expect(
        servicioVentas().create(
          {
            productoId: p.id,
            tipoCambio: 3.4,
            precioVenta: 1300,
            fechaVenta: dia,
            vendedor: 'Gonzalo',
            operacionKey: key(),
          },
          userId,
        ),
      ).rejects.toThrow('no está disponible');
    },
  );
  it('el importe proviene de la compra y no permite sobrescribirlo', async () => {
    const p = await producto(999.99);
    const r = await fin.crearReembolso(
      {
        productoId: p.id,
        motivo: 'No llegó a Eshopex.',
        montoReclamado: 1,
        gastosAdicionales: 99,
        costoOriginal: 1,
        moneda: 'PEN',
      },
      userId,
    );
    expect(r.montoReclamado).toBe('999.99');
    expect(r.gastosAdicionales).toBe('0.00');
    expect(
      (await ds.getRepository(Producto).findOneBy({ id: p.id }))?.valor
        .costoEnvio,
    ).toBe('123.45');
  });
  it('rechaza motivo libre y compra sin USD original', async () => {
    const p = await producto();
    await expect(
      fin.crearReembolso({ productoId: p.id, motivo: 'otro' }, userId),
    ).rejects.toThrow('motivo');
    await ds.query('UPDATE producto_valor SET "monedaCompra"=$1 WHERE id=$2', [
      'PEN',
      p.valor.id,
    ]);
    await expect(
      fin.crearReembolso(
        { productoId: p.id, motivo: 'No llegó a Eshopex.' },
        userId,
      ),
    ).rejects.toThrow('USD');
  });
  it('dos reclamos concurrentes dejan solo uno activo', async () => {
    const p = await producto();
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        fin.crearReembolso(
          { productoId: p.id, motivo: 'No llegó a Eshopex.' },
          userId,
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      await ds.getRepository(Reembolso).countBy({ productoId: p.id }),
    ).toBe(1);
  });
  it('el reembolso posterior conserva cargo, envío e historial y evita duplicados', async () => {
    const p = await producto();
    const cargo = await ds.getRepository(Gasto).save({
      userId,
      concepto: 'compra',
      metodoPago: 'credito',
      tarjeta: 'bcp_visa',
      monto: '750.19',
      moneda: 'USD',
      fecha: '2026-10-10',
      productoVinculadoId: p.id,
    });
    const r = await fin.crearReembolso(
      { productoId: p.id, motivo: 'No llegó a Eshopex.' },
      userId,
    );
    const fecha = '2026-12-12',
      op = key();
    const dto = {
      tipo: 'recibido' as const,
      fecha,
      monto: 750.19,
      moneda: 'USD' as const,
      cuentaId: tarjetaId,
      idempotencyKey: op,
    };
    const recibido = await fin.eventoReembolso(r.id, dto, userId);
    expect(recibido.estado).toBe('recibido');
    expect(recibido.fechaCierre).toBe(fecha);
    expect(
      (await ds.getRepository(Gasto).findOneBy({ id: cargo.id }))?.monto,
    ).toBe('750.19');
    expect(recibido.eventos?.filter((e) => e.tipo === 'recibido')).toHaveLength(
      1,
    );
    await fin.eventoReembolso(r.id, dto, userId);
    await expect(
      fin.eventoReembolso(r.id, { ...dto, idempotencyKey: key() }, userId),
    ).rejects.toThrow('cerrada');
    expect(
      await ds.getRepository(Gasto).countBy({
        notas:
          '__REFUND__:' +
          r.id +
          ':' +
          recibido.eventos!.find((e) => e.tipo === 'recibido')!.id,
      }),
    ).toBe(1);
  });
  it('crear reclamo no crea reembolso ni saldo cliente', async () => {
    const p = await producto();
    const [antes] = await ds.query(
      'SELECT count(*)::int AS n FROM cliente_saldos',
    );
    const r = await fin.crearReembolso(
      { productoId: p.id, motivo: 'No llegó a Eshopex.' },
      userId,
    );
    expect(
      (await fin.reembolsoConEventos(r.id)).eventos?.some(
        (e) => e.tipo === 'recibido',
      ),
    ).toBe(false);
    const [despues] = await ds.query(
      'SELECT count(*)::int AS n FROM cliente_saldos',
    );
    expect(despues.n).toBe(antes.n);
  });
  it('genera 3000, aplica 1000 y luego 2000 conservando el pago original', async () => {
    const { c, v } = await conSaldo();
    expect((await saldos.historial(c.id)).disponible).toBe('3000.00');
    const a = await venta(c.id, 1000);
    await aplicar(a, 1000);
    expect((await saldos.historial(c.id)).disponible).toBe('2000.00');
    expect((await situacion(a)).saldoPendienteCents).toBe(0);
    const b = await venta(c.id, 2000);
    await aplicar(b, 2000);
    expect((await saldos.historial(c.id)).disponible).toBe('0.00');
    expect(
      (await ds.getRepository(VentaPago).findOneBy({ ventaId: v.id }))
        ?.anuladoAt,
    ).toBeNull();
    expect(
      (await ds.getRepository(Venta).findOneBy({ id: v.id }))?.precioVenta,
    ).toBe('3000.00');
  });
  it('saldo 1000 y venta 1300: NO conserva deuda 300 sin fecha de pago', async () => {
    const { c } = await conSaldo(1000),
      v = await venta(c.id, 1300);
    await aplicar(v, 1000);
    expect((await situacion(v)).saldoPendienteCents).toBe(30000);
    const p = await ds.getRepository(VentaPago).findBy({ ventaId: v.id });
    expect(p).toHaveLength(1);
    expect(p[0].origen).toBe('saldo_cliente');
    const g = await ds.getRepository(Gasto).findOneBy({ saleId: v.id });
    expect(g?.salePaidAt).toBeNull();
    expect(g?.saleReceivedAmount).toBe('0.00');
    expect(g?.salePaymentType).toBe('debt');
    expect(g?.saleSku).toBe('MS-' + v.productoId);
  });
  it('saldo 1000 y venta 1300: SÍ registra solo 300 nuevos con fecha', async () => {
    const { c } = await conSaldo(1000),
      v = await venta(c.id, 1300);
    await aplicar(v, 1000, true);
    expect((await situacion(v)).saldoPendienteCents).toBe(0);
    const p = await ds.getRepository(VentaPago).findBy({ ventaId: v.id });
    expect(
      p.filter((x) => x.origen !== 'saldo_cliente').map((x) => x.montoPen),
    ).toEqual(['300.00']);
    expect(
      (await ds.getRepository(Gasto).findOneBy({ saleId: v.id }))?.salePaidAt,
    ).toBe(dia);
    const g = await ds.getRepository(Gasto).findOneByOrFail({ saleId: v.id });
    expect(g.salePaymentType).toBe('direct');
    expect(g.saleSku).toBe('MS-' + v.productoId);
    expect(g.saleReceivedAmount).toBe('300.00');
    expect(g.tarjeta).toBe('bcp');
    await ledger.sincronizarIngresosVenta(v.id);
    expect(await ds.getRepository(VentaPago).countBy({ ventaId: v.id })).toBe(2);
    // Reproduce la presentación antigua y comprueba su reparación idempotente.
    await ds.getRepository(Gasto).update(g.id, { salePaymentType: 'debt', saleSku: null, tarjeta: null });
    const q = ds.createQueryRunner();
    try {
      await q.connect();
      await new DiferenciaSaldoDirecta1794355200000().up(q);
      await new DiferenciaSaldoDirecta1794355200000().up(q);
    } finally { await q.release(); }
    expect(await ds.getRepository(Gasto).findOneByOrFail({ id: g.id })).toMatchObject({
      salePaymentType: 'direct', saleSku: 'MS-' + v.productoId, tarjeta: 'bcp', monto: '300.00', saleReceivedAmount: '300.00',
    });
  });
  it('deuda adicional se paga posteriormente mediante el ledger existente', async () => {
    const { c } = await conSaldo(1000),
      v = await venta(c.id, 1300);
    await aplicar(v, 1000);
    await pago(v, 300);
    expect((await situacion(v)).saldoPendienteCents).toBe(0);
    expect((await ds.getRepository(Gasto).findOneByOrFail({ saleId: v.id })).salePaymentType).toBe('debt');
  });
  it('consume varios SKU de menor a mayor saldo disponible', async () => {
    const c = await cliente(),
      a = await venta(c.id, 800),
      b = await venta(c.id, 1200);
    await pago(a, 800);
    await pago(b, 1200);
    await generar(a);
    await generar(b);
    const v = await venta(c.id, 1500);
    await aplicar(v, 1500);
    const h = await saldos.historial(c.id);
    expect(h.saldos.map((s) => s.disponible)).toEqual(['0.00', '500.00']);
    expect(h.movimientos.filter((m) => m.venta_id === v.id)).toHaveLength(2);
  });
  it('usa el saldo más pequeño aunque el mayor se haya generado antes', async () => {
    const c = await cliente(), grande = await venta(c.id, 1200), pequeno = await venta(c.id, 800);
    await pago(grande, 1200);
    await pago(pequeno, 800);
    await generar(grande);
    await generar(pequeno);
    const destino = await venta(c.id, 1000);
    await aplicar(destino, 1000);
    const h = await saldos.historial(c.id);
    expect(h.saldos.find(s => s.venta_id === pequeno.id).disponible).toBe('0.00');
    expect(h.saldos.find(s => s.venta_id === grande.id).disponible).toBe('1000.00');
    expect(h.movimientos.filter(m => m.venta_id === destino.id).map(m => m.sku_origen)).toEqual([pequeno.productoId, grande.productoId]);
  });
  it('el pago adicional solo vuelve a saldo después de anular y queda identificado en el desglose', async () => {
    const { c } = await conSaldo(3140);
    const destino = await venta(c.id, 1300);
    await ds.getRepository(Venta).update(destino.id, { vendedor: 'Gonzalo (' + c.nombre + ')' });
    const fecha = reclamoDia();
    await saldos.aplicar(destino.id, { monto: 1000, fecha, operacion: key(), pagoAdicional: true,
      fechaPago: fecha, cuentaId }, userId);
    expect((await saldos.historial(c.id)).disponible).toBe('2140.00');
    await servicioVentas().anular(destino.id, userId);
    await servicioVentas().anular(destino.id, userId);
    const h = await saldos.historial(c.id);
    expect(h.disponible).toBe('3440.00');
    expect(h.saldos.filter(s => s.origen_saldo === 'pago_recuperado').map(s => s.disponible)).toEqual(['300.00']);
    expect(h.saldos.filter(s => s.origen_saldo === 'saldo_recuperado').map(s => s.disponible)).toEqual(['1000.00']);
    expect(h.movimientos.filter(m => m.venta_id === destino.id).every(m => m.saldo_recuperado)).toBe(true);
  });
  it('mantiene equivalencia USD y TC 3.40 aunque la venta nueva use 3.50', async () => {
    const c = await cliente(),
      a = await venta(c.id, 3400);
    await ledger.registrarPago({
      ventaId: a.id,
      monto: 1000,
      moneda: 'USD',
      tipoCambio: 3.4,
      fechaPago: '2026-10-11',
      metodo: 'transferencia',
      cuentaReceptoraId: cuentaId,
      idempotencyKey: key(),
    });
    await generar(a);
    const v = await venta(c.id, 3400);
    await ds.getRepository(Venta).update(v.id, { tipoCambio: 3.5 });
    await aplicar(v, 3400);
    const h = await saldos.historial(c.id);
    expect(h.saldos[0]).toMatchObject({
      original: '3400.00',
      monto_original: '1000.00',
      tipo_cambio: '3.4000',
      equivalente_usd: '1000.00',
    });
  });
  it('no usa saldo de otro cliente', async () => {
    await conSaldo(1000);
    const c = await cliente(),
      v = await venta(c.id, 1000);
    await expect(aplicar(v, 1000)).rejects.toThrow('supera el saldo');
  });
  it.each(['propio', 'renato'] as const)(
    'excluye comprador %s por clasificación e ID',
    async (clase) => {
      const c = await cliente(clase),
        v = await venta(c.id, 1000);
      await pago(v, 1000);
      await expect(generar(v)).rejects.toThrow('no admite');
    },
  );
  it('rechaza exceso de saldo y doble conversión', async () => {
    const { c, v } = await conSaldo(1000);
    await expect(generar(v)).rejects.toThrow('ya se convirtieron');
    const b = await venta(c.id, 1500);
    await expect(aplicar(b, 1100)).rejects.toThrow('supera el saldo');
  });
  it('no genera dinero sobre la parte no pagada de una venta', async () => {
    const c = await cliente(),
      v = await venta(c.id, 3000);
    await pago(v, 500);
    await generar(v);
    expect((await saldos.historial(c.id)).disponible).toBe('500.00');
  });
  it('dos aplicaciones concurrentes no gastan el mismo saldo', async () => {
    const { c } = await conSaldo(1000),
      a = await venta(c.id, 1000),
      b = await venta(c.id, 1000);
    const results = await Promise.allSettled([
      aplicar(a, 1000),
      aplicar(b, 1000),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await saldos.historial(c.id)).disponible).toBe('0.00');
  });
  it('falla de pago adicional revierte consumo y movimiento completos', async () => {
    const { c } = await conSaldo(1000),
      v = await venta(c.id, 1300);
    await expect(
      saldos.aplicar(
        v.id,
        {
          monto: 1000,
          fecha: dia,
          operacion: key(),
          pagoAdicional: true,
          fechaPago: dia,
          cuentaId: 999999,
        },
        userId,
      ),
    ).rejects.toThrow();
    expect((await saldos.historial(c.id)).disponible).toBe('1000.00');
    expect(await ds.getRepository(VentaPago).countBy({ ventaId: v.id })).toBe(
      0,
    );
    expect(await ds.getRepository(Gasto).countBy({ saleId: v.id })).toBe(0);
  });
  it('reintento de aplicación no repite el consumo ni el pago adicional', async () => {
    const { c } = await conSaldo(1000),
      v = await venta(c.id, 1300),
      op = key();
    await aplicar(v, 1000, true, op);
    await aplicar(v, 1000, true, op);
    expect(await ds.getRepository(VentaPago).countBy({ ventaId: v.id })).toBe(
      2,
    );
  });
  it('devolución al cliente reduce la obligación sin borrar historial', async () => {
    const { c } = await conSaldo(1000);
    await saldos.devolver(
      c.id,
      { monto: 300, fecha: dia, cuentaId, operacion: key() },
      userId,
    );
    const h = await saldos.historial(c.id);
    expect(h.disponible).toBe('700.00');
    expect(h.movimientos[0].tipo).toBe('devolucion');
  });
  it('preserva historial con FK RESTRICT y bloquea anulación de pagos usados', async () => {
    const { c, v } = await conSaldo(1000);
    await expect(ds.getRepository(Venta).delete(v.id)).rejects.toThrow();
    const p = await ds.getRepository(VentaPago).findOneBy({ ventaId: v.id });
    await expect(ledger.anularPago(p!.id, 'prueba')).rejects.toThrow('saldo');
    expect((await saldos.historial(c.id)).disponible).toBe('1000.00');
  });
  it('reportes reconocen solo caja original y adicional, sin duplicar utilidad', async () => {
    const { c, v } = await conSaldo(1000),
      b = await venta(c.id, 1300);
    await aplicar(b, 1000, true);
    const a = new FinanzasAnalisisService(ds);
    const original = await a.analisis({
      from: '2026-10-01',
      to: '2026-12-31',
      productoId: v.productoId,
    });
    expect(original.resumen.ingresosComerciales).toBe(0);
    expect(original.resumen.cajaEntradas).toBe(1000);
    const destino = await a.analisis({
      from: '2026-10-01',
      to: '2026-12-31',
      productoId: b.productoId,
    });
    expect(destino.resumen.cajaEntradas).toBe(300);
    expect(destino.resumen.ingresosComerciales).toBe(1300);
  });
  const servicioVentas = () =>
    new VentaService(
      ds.getRepository(Venta),
      ds.getRepository(VentaAdelanto),
      ds.getRepository(Producto),
      ds.getRepository(ProductoValor),
      { del: async () => {} } as any,
      ds.getRepository(Gasto),
      ds.getRepository(User),
      ledger,
      saldos,
    );
  it.each([
    ['venta primero', 1000], ['venta primero', 250], ['venta primero', 0],
    ['reclamo primero', 1000], ['reclamo primero', 250], ['reclamo primero', 0],
    ['venta primero con fecha de pago posterior', 1000],
  ])('%s: conserva constancia y genera saldo solo por lo pagado (%s)', async (orden, pagado) => {
    const c = await cliente(), p = await producto();
    const vendedor = 'Gonzalo (' + c.nombre + ')';
    await ds.getRepository(Producto).update(p.id, { vendedor });
    const reclamar = () => fin.crearReembolso({ productoId: p.id, motivo: 'No llegó a Eshopex.', fechaIncidencia: '2026-11-01' }, userId);
    if (orden === 'reclamo primero') await reclamar();
    const v = await servicioVentas().create({ productoId: p.id, vendedor, precioVenta: 1000, tipoCambio: 3.4,
      fechaVenta: orden === 'reclamo primero' || String(orden).includes('posterior') ? '2026-11-02' : '2026-10-10', operacionKey: key(), incomeBank: 'bcp',
      ...(pagado === 0 ? { incomePaymentType: 'debt' as const } : pagado === 250 ? {
        incomeParts: [{ type: 'direct' as const, amount: 250 }, { type: 'debt' as const, amount: 750 }],
      } : {}) }, userId);
    if (orden !== 'reclamo primero') await reclamar();
    const h = await saldos.historial(c.id);
    expect(h.disponible).toBe(Number(pagado).toFixed(2));
    expect(h.devoluciones).toHaveLength(1);
    expect(h.devoluciones[0]).toMatchObject({ sku: p.codigoInventario || p.id, saldo_generado: Number(pagado).toFixed(2),
      importe_sin_pagar: (1000 - Number(pagado)).toFixed(2) });
    await ds.transaction(m => saldos.actualizarSaldoPorReclamo(p.id, userId, m));
    expect((await saldos.historial(c.id)).disponible).toBe(Number(pagado).toFixed(2));
    const otra = await producto();
    await servicioVentas().create({ productoId: otra.id, vendedor, precioVenta: 500, tipoCambio: 3.4, fechaVenta: dia, incomeBank: 'bcp' }, userId);
    expect((await saldos.historial(c.id)).devoluciones).toHaveLength(1);
    expect(v.id).toBeTruthy();
  });
  it('crea venta y aplica saldo de forma atómica sin ingreso automático ficticio', async () => {
    const { c } = await conSaldo(1000),
      p = await producto();
    const v = await servicioVentas().create(
      {
        productoId: p.id,
        clienteId: c.id,
        tipoCambio: 3.5,
        fechaVenta: dia,
        precioVenta: 1300,
        vendedor: 'Gonzalo',
        operacionKey: key(),
        saldoCliente: {
          monto: 1000,
          fecha: dia,
          operacion: key(),
          pagoAdicional: false,
        },
      },
      userId,
    );
    expect((await situacion(v)).saldoPendienteCents).toBe(30000);
    const pagos = await ds.getRepository(VentaPago).findBy({ ventaId: v.id });
    expect(pagos).toHaveLength(1);
    expect(pagos[0].origen).toBe('saldo_cliente');
    expect(
      (await ds.getRepository(Gasto).findOneBy({ saleId: v.id }))
        ?.saleReceivedAmount,
    ).toBe('0.00');
  });
  it('falla de aplicación revierte también la creación de la venta', async () => {
    const { c } = await conSaldo(1000),
      p = await producto();
    await expect(
      servicioVentas().create(
        {
          productoId: p.id,
          clienteId: c.id,
          tipoCambio: 3.5,
          fechaVenta: dia,
          precioVenta: 1300,
          vendedor: 'Gonzalo',
          operacionKey: key(),
          saldoCliente: {
            monto: 1200,
            fecha: dia,
            operacion: key(),
            pagoAdicional: false,
          },
        },
        userId,
      ),
    ).rejects.toThrow();
    expect(await ds.getRepository(Venta).countBy({ productoId: p.id })).toBe(0);
    expect((await saldos.historial(c.id)).disponible).toBe('1000.00');
  });
  it('el ingreso original en Gastos no puede alterarse después de generar saldo', async () => {
    const c = await cliente(),
      p = await producto();
    const v = await servicioVentas().create(
      {
        productoId: p.id,
        clienteId: c.id,
        tipoCambio: 3.4,
        fechaVenta: '2026-10-10',
        precioVenta: 3000,
        vendedor: 'Gonzalo',
        incomeBank: 'bcp',
        operacionKey: key(),
      },
      userId,
    );
    await generar(v);
    const ingreso = await ds.getRepository(Gasto).findOneBy({ saleId: v.id });
    expect(ingreso).toBeTruthy();
    await expect(
      ds.getRepository(Gasto).update(ingreso!.id, { monto: '1.00' }),
    ).rejects.toThrow('saldo');
    await expect(ds.getRepository(Gasto).delete(ingreso!.id)).rejects.toThrow(
      'saldo',
    );
  });
  it('no permite reusar la clave de una aplicación con fecha o confirmación distinta', async () => {
    const { c } = await conSaldo(1000),
      v = await venta(c.id, 1300),
      op = key();
    await aplicar(v, 1000, false, op);
    await expect(aplicar(v, 1000, true, op)).rejects.toThrow('Clave');
    expect((await situacion(v)).saldoPendienteCents).toBe(30000);
  });
  it('reintento de devolución conserva un solo egreso y bloquea su anulación aislada', async () => {
    const { c } = await conSaldo(1000),
      dto = { monto: 300, fecha: dia, cuentaId, operacion: key() };
    const m = await saldos.devolver(c.id, dto, userId);
    await saldos.devolver(c.id, dto, userId);
    expect((await saldos.historial(c.id)).disponible).toBe('700.00');
    await expect(
      ds.query(
        'UPDATE movimientos_financieros SET anulado_at=now() WHERE id=$1',
        [m!.id],
      ),
    ).rejects.toThrow('historial');
  });
  it('synchronize y preparación local repetidos conservan saldos e historial sin migraciones', async () => {
    const { c, v } = await conSaldo(1000);
    await ds.synchronize();
    await prepareLocalDatabase(ds);
    await prepareLocalDatabase(ds);
    expect((await saldos.historial(c.id)).disponible).toBe('1000.00');
    expect(
      (await ds.getRepository(VentaPago).findOneBy({ ventaId: v.id }))
        ?.montoPen,
    ).toBe('1000.00');
    const triggers = await ds.query(
      "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('proteger_pago_con_saldo','proteger_ingreso_con_saldo','proteger_devolucion_saldo')",
    );
    expect(triggers).toHaveLength(3);
  });
  it('la migración de producción es idempotente sobre el esquema sincronizado', async () => {
    const q = ds.createQueryRunner();
    await q.connect();
    try {
      const migration = new ReclamoSaldoInmediato1794096000000();
      await migration.up(q);
      await migration.up(q);
    } finally { await q.release(); }
  });
  it('Gonzalo (Jorge) resuelve una sola identidad por ID y adopta el saldo ya registrado', async () => {
    const c = await saldos.crearCliente(
        { nombre: 'Jorge', clase: 'externo', admiteSaldo: true },
        userId,
      ),
      v = await venta(c.id, 3000);
    await pago(v, 3000);
    await generar(v);
    const [a, b] = await Promise.all([
      saldos.resolverPedido('Gonzalo (Jorge)', userId),
      saldos.resolverPedido('gonzalo (  jorge  )', userId),
    ]);
    expect(a.id).toBe(c.id);
    expect(b.id).toBe(c.id);
    expect((await saldos.historial(a.id)).disponible).toBe('3000.00');
    const destino = await producto();
    const nueva = await servicioVentas().create(
      {
        productoId: destino.id,
        vendedor: 'Gonzalo (Jorge)',
        tipoCambio: 3.4,
        fechaVenta: dia,
        precioVenta: 1000,
        operacionKey: key(),
        saldoCliente: {
          monto: 1000,
          fecha: dia,
          operacion: key(),
          pagoAdicional: false,
        },
      },
      userId,
    );
    expect(nueva.clienteId).toBe(c.id);
    expect((await saldos.historial(c.id)).disponible).toBe('2000.00');
    expect(await saldos.resolverPedido('Gonzalo', userId)).toBeNull();
    expect(await saldos.resolverPedido('Renato', userId)).toBeNull();
  });
  it('descubre el pago histórico de una venta afectada sin cliente_id y lo convierte sin duplicar el ingreso', async () => {
    const c = await cliente();
    await saldos.resolverPedido('Gonzalo (' + c.nombre + ')', userId);
    const v = await venta(c.id, 1000);
    await ds.getRepository(Venta).update(v.id, {
      clienteId: null,
      vendedor: 'Gonzalo (' + c.nombre + ')',
      conciliacionHistorica: 'pendiente',
    });
    await ds
      .getRepository(Producto)
      .update(v.productoId, { cierreMotivo: 'no_comercializable' });
    const g = await ds.getRepository(Gasto).save({
      userId,
      concepto: 'ingreso',
      metodoPago: 'debito',
      moneda: 'PEN',
      monto: '1000.00',
      fecha: '2026-10-10',
      tarjeta: 'bcp',
      notas: '__SALE_INCOME__:' + v.productoId,
    });
    const antes = await saldos.historial(c.id),
      origen = antes.ventas.find((x) => x.ventaId === v.id);
    expect(origen).toMatchObject({
      convertible: '1000.00',
      deuda: '0.00',
      afectada: true,
    });
    expect(antes.disponible).toBe('0.00');
    const cantidad = await ds.getRepository(Gasto).count();
    await generar(v);
    expect((await saldos.historial(c.id)).disponible).toBe('1000.00');
    expect(await ds.getRepository(Gasto).count()).toBe(cantidad);
    expect(await ds.getRepository(Gasto).findOneBy({ id: g.id })).toMatchObject(
      { monto: '1000.00', fecha: '2026-10-10', saleId: v.id },
    );
    expect(await ds.getRepository(VentaPago).countBy({ ventaId: v.id })).toBe(
      1,
    );
    const destino = await venta(c.id, 1300);
    await aplicar(destino, 1000);
    expect((await situacion(destino)).saldoPendienteCents).toBe(30000);
    await expect(generar(v)).rejects.toThrow('ya se convirtieron');
  });
  it('no convierte una venta sin pagos aunque el producto esté cerrado', async () => {
    const c = await cliente(),
      v = await venta(c.id, 1000);
    await ds
      .getRepository(Producto)
      .update(v.productoId, { cierreMotivo: 'no_comercializable' });
    const h = await saldos.historial(c.id);
    expect(h.ventas[0].convertible).toBe('0.00');
    await expect(generar(v)).rejects.toThrow('no tiene pagos');
    expect((await saldos.historial(c.id)).disponible).toBe('0.00');
  });
  it('la conciliación del ingreso histórico se revierte si falla la creación del saldo', async () => {
    const c = await cliente(),
      v = await venta(c.id, 1000);
    await ds.getRepository(Venta).update(v.id, { tipoCambio: 0 });
    const g = await ds.getRepository(Gasto).save({
      userId,
      concepto: 'ingreso',
      metodoPago: 'debito',
      moneda: 'PEN',
      monto: '1000.00',
      fecha: '2026-10-10',
      tarjeta: 'bcp',
      notas: '__SALE_INCOME__:' + v.productoId,
    });
    await expect(generar(v)).rejects.toThrow('tipo de cambio');
    expect(
      (await ds.getRepository(Gasto).findOneBy({ id: g.id }))?.saleId,
    ).toBeNull();
    expect(await ds.getRepository(VentaPago).countBy({ ventaId: v.id })).toBe(
      0,
    );
  });

  it.each([
    { precio: 1000, extra: false, esperado: '1000.00' },
    { precio: 1300, extra: false, esperado: '1000.00' },
    { precio: 1300, extra: true, esperado: '1300.00' },
  ])('anula una venta pagada con saldo y devuelve solo lo pagado: $esperado', async ({ precio, extra, esperado }) => {
    const { c } = await conSaldo(1000);
    const v = await venta(c.id, precio);
    // La identidad persistente también funciona si el texto del vendedor no lleva el nombre del cliente.
    if (precio === 1000 || extra) await ds.getRepository(Venta).update(v.id, { vendedor: 'Gonzalo (' + c.nombre + ')' });
    const fecha = reclamoDia();
    await saldos.aplicar(v.id, { monto: 1000, fecha, operacion: key(), pagoAdicional: extra,
      ...(extra ? { fechaPago: fecha, cuentaId } : {}) }, userId);
    const pagosAntes = await ds.getRepository(VentaPago).findBy({ ventaId: v.id });
    const saldoPago = pagosAntes.find(p => p.origen === 'saldo_cliente')!;
    if (extra) {
      // Los adicionales antiguos solo quedaron enlazados desde salePaymentHistory.
      const pagoExtra = pagosAntes.find(p => p.origen !== 'saldo_cliente')!;
      await ds.getRepository(VentaPago).update(pagoExtra.id, { gastoId: null });
    }
    expect((await saldos.historial(c.id)).disponible).toBe('0.00');
    await Promise.all([servicioVentas().anular(v.id, userId), servicioVentas().anular(v.id, userId)]);
    const h = await saldos.historial(c.id);
    expect(h.disponible).toBe(esperado);
    expect(h.saldos.filter(s => s.venta_id === v.id)).toHaveLength(extra ? 2 : 1);
    expect(h.saldos.find(s => s.pago_id === saldoPago.id)?.tipo_cambio).toBe(saldoPago.tipoCambio);
    expect(await ds.getRepository(VentaPago).countBy({ ventaId: v.id })).toBe(pagosAntes.length);
    expect((await ds.getRepository(Venta).findOneByOrFail({ id: v.id })).anuladaAt).toBeTruthy();
    expect((await ds.getRepository(Producto).findOneByOrFail({ id: v.productoId })).cierreMotivo).toBeNull();
    if (extra) {
      const g = await ds.getRepository(Gasto).findOneByOrFail({ saleId: v.id });
      expect(g.monto).toBe('300.00');
      expect(g.saleReceivedAmount).toBe('300.00');
    }
  });

  it('anular un pedido pagado genera saldo automáticamente y conserva sus cobros', async () => {
    const c = await cliente(),
      v = await venta(c.id, 1000);
    await ds
      .getRepository(Venta)
      .update(v.id, { vendedor: 'Gonzalo (' + c.nombre + ')' });
    await pago(v, 1000);
    await servicioVentas().anular(v.id, userId, 'Reemplazo');
    await servicioVentas().anular(v.id, userId, 'Reintento');
    expect((await ds.getRepository(Producto).findOneByOrFail({ id: v.productoId })).cierreMotivo).toBeNull();
    expect(
      (await ds.getRepository(VentaPago).findOneBy({ ventaId: v.id }))
        ?.anuladoAt,
    ).toBeNull();
    expect((await saldos.historial(c.id)).disponible).toBe('1000.00');
    // Repara el cierre heredado de versiones anteriores sin retirar dinero del cliente.
    await ds.getRepository(Producto).update(v.productoId, { cierreMotivo: 'no_comercializable' });
    const q = ds.createQueryRunner();
    try {
      await q.connect();
      await new AnulacionVentaSinPerdida1794441600000().up(q);
      await new AnulacionVentaSinPerdida1794441600000().up(q);
      expect((await ds.getRepository(Producto).findOneByOrFail({ id: v.productoId })).cierreMotivo).toBeNull();
      const nueva = await servicioVentas().create({ productoId: v.productoId, vendedor: 'Gonzalo (' + c.nombre + ')',
        precioVenta: 1200, tipoCambio: 3.4, fechaVenta: dia, operacionKey: key() }, userId, true);
      expect(nueva.id).not.toBe(v.id);
      await fin.crearReembolso({ productoId: v.productoId, motivo: 'No llegó a Eshopex.', fechaIncidencia: dia }, userId);
      await new AnulacionVentaSinPerdida1794441600000().up(q);
      expect((await ds.getRepository(Producto).findOneByOrFail({ id: v.productoId })).cierreMotivo).toBe('no_comercializable');
    } finally { await q.release(); }
  });

  it('el reclamo genera saldo inmediatamente con su fecha y el reembolso posterior no lo duplica', async () => {
    const c = await cliente(),
      v = await venta(c.id, 1000);
    await ds
      .getRepository(Venta)
      .update(v.id, { vendedor: 'Gonzalo (' + c.nombre + ')' });
    await pago(v, 1000);
    const r = await fin.crearReembolso(
      { productoId: v.productoId, motivo: 'No llegó a Eshopex.', fechaIncidencia: '2026-11-02' },
      userId,
    );
    const inmediato = await saldos.historial(c.id);
    expect(inmediato.disponible).toBe('1000.00');
    expect(inmediato.saldos[0].fecha).toBe('2026-11-02');
    const constancia = await servicioVentas().constanciaProducto(v.productoId);
    expect(constancia.ventas).toHaveLength(1);
    expect(constancia.ventas[0]).toMatchObject({ id: v.id, precioVenta: '1000.00',
      tipoCambio: '3.4000', pagado: '1000.00', saldoGenerado: '1000.00', saldoDisponible: '1000.00' });
    expect(constancia.ventas[0].pagos).toHaveLength(1);
    expect(constancia.ventas[0].pagos[0]).toMatchObject({ monto: '1000.00', verificado: true, anulado: false });
    expect(constancia.reclamos[0].estado).toBe('reclamo_abierto');
    expect(await ds.getRepository(Gasto).count({ where: { productoVinculadoId: v.productoId } })).toBe(0);
    await fin.eventoReembolso(
      r.id,
      {
        tipo: 'recibido',
        fecha: '2026-12-12',
        monto: 750.19,
        moneda: 'USD',
        cuentaId: tarjetaId,
        idempotencyKey: key(),
      },
      userId,
    );
    expect((await saldos.historial(c.id)).disponible).toBe('1000.00');
    await servicioVentas().anular(v.id, userId);
    expect((await saldos.historial(c.id)).saldos).toHaveLength(1);
    expect((await servicioVentas().constanciaProducto(v.productoId)).ventas[0].pagado).toBe('1000.00');
    expect(
      (await ds.getRepository(VentaPago).findOneBy({ ventaId: v.id }))
        ?.anuladoAt,
    ).toBeNull();
  });
  it('quitar una venta duplicada solo la oculta de la constancia y conserva cobros y saldo', async () => {
    const { c, v } = await conSaldo(1000);
    const duplicada = await ds.getRepository(Venta).save(ds.getRepository(Venta).create({
      ...v, id: undefined, createdAt: undefined, estadoComercial: 'cancelada',
    }));
    const antes = await saldos.historial(c.id);
    await servicioVentas().quitarDeConstancia(v.productoId, duplicada.id, userId);
    await servicioVentas().quitarDeConstancia(v.productoId, duplicada.id, userId);
    expect((await servicioVentas().constanciaProducto(v.productoId)).ventas.map(row => row.id)).toEqual([v.id]);
    expect(await ds.getRepository(Venta).findOneByOrFail({ id: duplicada.id })).toMatchObject({ constanciaOcultaPor: userId });
    expect((await ds.getRepository(Venta).findOneByOrFail({ id: duplicada.id })).constanciaOcultaAt).toBeTruthy();
    const despues = await saldos.historial(c.id);
    expect(despues.disponible).toBe(antes.disponible);
    expect(despues.saldos).toEqual(antes.saldos);
    expect(await ds.getRepository(VentaPago).countBy({ ventaId: v.id })).toBe(1);
    const otro = await producto();
    await expect(servicioVentas().quitarDeConstancia(otro.id, v.id, userId)).rejects.toThrow('no pertenece');
    expect((await servicioVentas().constanciaProducto(v.productoId)).ventas.map(row => row.id)).toEqual([v.id]);
    const q = ds.createQueryRunner();
    try {
      await q.connect();
      await new ConstanciaVentaOculta1794268800000().up(q);
      await new ConstanciaVentaOculta1794268800000().up(q);
    } finally { await q.release(); }
    expect((await servicioVentas().constanciaProducto(v.productoId)).ventas.map(row => row.id)).toEqual([v.id]);
  });
  it.each([true, false])('el reclamo convierte el ingreso histórico conciliado, derivado previamente: %s', async (derivado) => {
    const c = await cliente(), v = await venta(c.id, 1000);
    await ds.getRepository(Venta).update(v.id, {
      vendedor: 'Gonzalo (' + c.nombre + ')', conciliacionHistorica: 'confirmada',
    });
    await ds.getRepository(Gasto).save({ userId, concepto: 'ingreso', metodoPago: 'debito', moneda: 'PEN',
      monto: '1000.00', fecha: '2026-10-10', tarjeta: 'bcp', saleId: v.id,
      notas: '__SALE_INCOME__:' + v.productoId + ':' + v.id });
    if (derivado) await ledger.sincronizarIngresosVenta(v.id);
    const r = await fin.crearReembolso({ productoId: v.productoId, motivo: 'No llegó a Eshopex.', fechaIncidencia: '2026-11-02' }, userId);
    const h = await saldos.historial(c.id);
    expect(h.disponible).toBe('1000.00');
    expect(h.saldos[0].fecha).toBe('2026-11-02');
    expect(await ds.transaction(m => repararSaldosReclamoSinCobro(m, v.productoId))).toEqual([]);
    await fin.eventoReembolso(r.id, { tipo: 'recibido', fecha: '2026-11-03', monto: 750.19, moneda: 'USD', cuentaId: tarjetaId, idempotencyKey: key() }, userId);
    expect((await saldos.historial(c.id)).disponible).toBe('1000.00');
    await fin.eventoReembolso(r.id, { tipo: 'anulacion', fecha: '2026-11-04', idempotencyKey: key() }, userId);
    expect((await saldos.historial(c.id)).disponible).toBe('0.00');
  });
  it.each([0, 250])('un reembolso al vendedor solo genera el efectivo realmente cobrado: %s', async (recibido) => {
    const c = await cliente(), v = await venta(c.id, 1000);
    await ds.getRepository(Venta).update(v.id, { vendedor: 'Gonzalo (' + c.nombre + ')' });
    await ds.getRepository(Gasto).save({ userId, concepto: 'ingreso', metodoPago: 'debito', moneda: 'PEN',
      monto: '1000.00', montoPen: '1000.00', fecha: '2026-10-10', tarjeta: 'efectivo', saleId: v.id,
      salePaymentType: 'cash', saleReceivedAmount: recibido.toFixed(2), salePaidAt: recibido ? '2026-10-11' : null,
      notas: '__SALE_INCOME__:' + v.productoId + ':' + v.id + ':cash' });
    await ledger.sincronizarIngresosVenta(v.id);
    const r = await fin.crearReembolso({ productoId: v.productoId, motivo: 'No llegó a Eshopex.', fechaIncidencia: '2026-11-02' }, userId);
    expect((await saldos.historial(c.id)).disponible).toBe(recibido.toFixed(2));
    expect((await servicioVentas().constanciaProducto(v.productoId)).ventas[0].pagado).toBe(recibido.toFixed(2));
    await fin.eventoReembolso(r.id, { tipo: 'recibido', fecha: '2026-11-03', monto: 750.19, moneda: 'USD', cuentaId: tarjetaId, idempotencyKey: key() }, userId);
    expect((await saldos.historial(c.id)).disponible).toBe(recibido.toFixed(2));
    expect((await saldos.historial(c.id)).saldos).toHaveLength(recibido ? 1 : 0);
  });
  it('el ingreso automático sin confirmación de cobro no da saldo al recibir el reembolso', async () => {
    const c = await cliente(), v = await venta(c.id, 1000);
    await ds.getRepository(Venta).update(v.id, { vendedor: 'Gonzalo (' + c.nombre + ')' });
    await ds.getRepository(Gasto).save({ userId, concepto: 'ingreso', metodoPago: 'debito', moneda: 'PEN', monto: '1000.00',
      fecha: '2026-10-10', tarjeta: 'bcp', saleId: v.id, notas: '__SALE_INCOME__:' + v.productoId + ':' + v.id });
    await ledger.sincronizarIngresosVenta(v.id);
    const r = await fin.crearReembolso({ productoId: v.productoId, motivo: 'No llegó a Eshopex.', fechaIncidencia: '2026-11-02' }, userId);
    await fin.eventoReembolso(r.id, { tipo: 'recibido', fecha: '2026-11-03', monto: 750.19, moneda: 'USD', cuentaId: tarjetaId, idempotencyKey: key() }, userId);
    expect((await saldos.historial(c.id)).disponible).toBe('0.00');
    expect((await saldos.historial(c.id)).saldos).toHaveLength(0);
  });
  it('anular un reclamo antiguo retira el saldo automático sin cobro aunque falte el vínculo en su snapshot', async () => {
    const c = await cliente(), v = await venta(c.id, 1000);
    await ds.getRepository(Venta).update(v.id, { vendedor: 'Gonzalo (' + c.nombre + ')' });
    await ds.getRepository(Gasto).save({ userId, concepto: 'ingreso', metodoPago: 'debito', moneda: 'PEN', monto: '1000.00',
      fecha: '2026-10-10', tarjeta: 'bcp', saleId: v.id, notas: '__SALE_INCOME__:' + v.productoId + ':' + v.id });
    // Reproduce el saldo que generaba la versión anterior a la comprobación de cobros.
    await saldos.generar(v.id, { fecha: '2026-11-01' }, userId);
    await ds.getRepository(Venta).update(v.id, { anuladaAt: new Date(), anulacionMotivo: 'Anulación: pago conservado como saldo a favor del cliente' });
    const r = await fin.crearReembolso({ productoId: v.productoId, motivo: 'No llegó a Eshopex.', fechaIncidencia: '2026-11-02' }, userId);
    expect(r.reversionReclamo?.ventas).toEqual([]);
    await fin.eventoReembolso(r.id, { tipo: 'anulacion', fecha: dia, idempotencyKey: key() }, userId);
    const h = await saldos.historial(c.id);
    expect(h.disponible).toBe('0.00');
    expect(h.saldos).toHaveLength(1);
    expect(h.saldos[0].anulada_at).toBeTruthy();
    expect((await fin.reembolsoConEventos(r.id)).eventos?.some(e => e.nota?.includes('sin cobro confirmado'))).toBe(true);
    expect(await ds.transaction(m => repararSaldosReclamoSinCobro(m, v.productoId))).toEqual([]);
    expect((await ds.getRepository(Producto).findOneByOrFail({ id: v.productoId })).cierreMotivo).toBeNull();
    const nueva = await servicioVentas().create({ productoId: v.productoId, vendedor: 'Gonzalo (' + c.nombre + ')',
      precioVenta: 1200, tipoCambio: 3.4, fechaVenta: dia, operacionKey: key() }, userId, true);
    expect(nueva.id).not.toBe(v.id);
    expect(nueva.anuladaAt).toBeNull();
  });
  it('la reparación de saldos antiguos conserva un saldo respaldado por pago manual', async () => {
    const { c, v } = await conSaldo(1000);
    await ds.getRepository(Venta).update(v.id, { anuladaAt: new Date(), anulacionMotivo: 'Anulación: pago conservado como saldo a favor del cliente' });
    await fin.crearReembolso({ productoId: v.productoId, motivo: 'No llegó a Eshopex.' }, userId);
    expect(await ds.transaction(m => repararSaldosReclamoSinCobro(m, v.productoId))).toEqual([]);
    expect((await saldos.historial(c.id)).disponible).toBe('1000.00');
  });
  it.each(['reclamo_abierto', 'recibido'] as const)('la reparación no reabre automáticamente un producto con reclamo %s', async (estado) => {
    const c = await cliente(), v = await venta(c.id, 1000);
    await ds.getRepository(Venta).update(v.id, { anulacionMotivo: 'Anulación: pago conservado como saldo a favor del cliente' });
    await ds.getRepository(Producto).update(v.productoId, { cierreMotivo: 'no_comercializable' });
    await ds.getRepository(Reembolso).save({ productoId: v.productoId, estado, costoOriginal: '1000.00', montoReclamado: '1000.00' });
    expect(await ds.transaction(m => reabrirProductoConReclamosAnulados(m, v.productoId))).toEqual([]);
    expect((await ds.getRepository(Producto).findOneByOrFail({ id: v.productoId })).cierreMotivo).toBe('no_comercializable');
  });
  it('anula el reclamo sin borrar filas, restaura la venta y permite reclamar de nuevo', async () => {
    const c = await cliente(), v = await venta(c.id, 1000);
    await ds.getRepository(Venta).update(v.id, { vendedor: 'Gonzalo (' + c.nombre + ')' });
    await pago(v, 1000);
    const dto = { productoId: v.productoId, motivo: 'No llegó a Eshopex.', fechaIncidencia: '2026-11-02' };
    const r = await fin.crearReembolso(dto, userId);
    const anulado = await fin.eventoReembolso(r.id, { tipo: 'anulacion', fecha: '2026-11-03', idempotencyKey: key() }, userId);
    expect(anulado.estado).toBe('anulado');
    expect(anulado.resumen.capitalEnReclamo).toBe(0);
    expect(anulado.resumen.irrecuperable).toBe(0);
    const h = await saldos.historial(c.id);
    expect(h.disponible).toBe('0.00');
    expect(h.saldos).toHaveLength(1);
    expect(h.saldos[0].anulada_at).toBeTruthy();
    expect((await ds.getRepository(Venta).findOneByOrFail({ id: v.id })).anuladaAt).toBeNull();
    expect((await ds.getRepository(Producto).findOneByOrFail({ id: v.productoId })).cierreMotivo).toBeNull();
    await fin.crearReembolso(dto, userId);
    expect((await saldos.historial(c.id)).disponible).toBe('1000.00');
    expect((await saldos.historial(c.id)).saldos).toHaveLength(1);
  });
  // Caso MS-455: reembolso recibido, producto habilitado y nueva venta del pedido.
  const reembolsadoYHabilitado = async () => {
    const c = await cliente(), p = await producto();
    const vendedor = 'Gonzalo (' + c.nombre + ')';
    await ds.getRepository(Producto).update(p.id, { vendedor });
    const r = await fin.crearReembolso({ productoId: p.id, motivo: 'No llegó a Eshopex.', fechaIncidencia: '2026-11-01' }, userId);
    await fin.eventoReembolso(r.id, { tipo: 'recibido', fecha: '2026-11-02', monto: 750.19, moneda: 'USD', cuentaId: tarjetaId, idempotencyKey: key() }, userId);
    await fin.cerrarProducto(p.id, 'reabrir');
    const v = await servicioVentas().create({ productoId: p.id, vendedor, precioVenta: 1000, tipoCambio: 3.5,
      fechaVenta: '2026-11-08', operacionKey: key(), incomeBank: 'bcp' }, userId);
    return { c, p, r, v };
  };
  it('MS-455: tras recibir el reembolso y habilitar el producto, la venta nueva no se anula ni pasa a saldo', async () => {
    const { c, p, v } = await reembolsadoYHabilitado();
    const guardada = await ds.getRepository(Venta).findOneByOrFail({ id: v.id });
    expect(guardada.anuladaAt).toBeNull();
    expect(guardada.estadoComercial).not.toBe('cancelada');
    expect((await saldos.historial(c.id)).disponible).toBe('0.00');
    expect((await ds.getRepository(Producto).findOneByOrFail({ id: p.id })).cierreMotivo).toBeNull();
  });
  it('MS-455: quitar un reembolso recibido retira el ingreso de la tarjeta y deja el reclamo anulado', async () => {
    const { p, r, v } = await reembolsadoYHabilitado();
    const antes = await fin.reembolsoConEventos(r.id);
    const gastoId = antes.eventos!.find((e) => e.tipo === 'recibido')!.gastoId!;
    expect(gastoId).toBeTruthy();
    const anulado = await fin.eventoReembolso(r.id, { tipo: 'anulacion', fecha: dia, idempotencyKey: key() }, userId);
    expect(anulado.estado).toBe('anulado');
    expect(anulado.eventos!.some((e) => e.tipo === 'recibido')).toBe(false);
    expect(anulado.eventos!.find((e) => e.tipo === 'recibido_anulado')?.monto).toBe('750.19');
    expect(anulado.resumen.recibido).toBe(0);
    expect(await ds.getRepository(Gasto).findOneBy({ id: gastoId })).toBeNull();
    expect((await ds.getRepository(Venta).findOneByOrFail({ id: v.id })).anuladaAt).toBeNull();
    expect((await ds.getRepository(Producto).findOneByOrFail({ id: p.id })).cierreMotivo).toBeNull();
    await expect(fin.eventoReembolso(r.id, { tipo: 'recibido_anulado', fecha: dia, idempotencyKey: key() } as any, userId)).rejects.toThrow('anula el reclamo');
  });
  it('impide anular el reclamo cuyo saldo ya se usó y conserva toda la operación', async () => {
    const c = await cliente(), v = await venta(c.id, 1000);
    await ds.getRepository(Venta).update(v.id, { vendedor: 'Gonzalo (' + c.nombre + ')' });
    await pago(v, 1000);
    const r = await fin.crearReembolso({ productoId: v.productoId, motivo: 'No llegó a Eshopex.', fechaIncidencia: '2026-11-01' }, userId);
    await aplicar(await venta(c.id, 300), 300);
    await expect(fin.eventoReembolso(r.id, { tipo: 'anulacion', fecha: dia, idempotencyKey: key() }, userId)).rejects.toThrow('ya fue utilizado');
    expect((await saldos.historial(c.id)).disponible).toBe('700.00');
    expect((await fin.reembolsoConEventos(r.id)).estado).toBe('reclamo_abierto');
  });
  it('corrige la fecha del reclamo y del saldo sin permitir fechas incompatibles con pagos o aplicaciones', async () => {
    const c = await cliente(), v = await venta(c.id, 1000);
    await ds.getRepository(Venta).update(v.id, { vendedor: 'Gonzalo (' + c.nombre + ')' });
    await pago(v, 1000);
    const r = await fin.crearReembolso({ productoId: v.productoId, motivo: 'No llegó a Eshopex.', fechaIncidencia: '2026-11-01' }, userId);
    const cambiado = await fin.eventoReembolso(r.id, { tipo: 'fecha_reclamo', fecha: '2026-11-02', idempotencyKey: key() }, userId);
    expect(cambiado.fechaIncidencia).toBe('2026-11-02');
    expect((await saldos.historial(c.id)).saldos[0].fecha).toBe('2026-11-02');
    await expect(fin.eventoReembolso(r.id, { tipo: 'fecha_reclamo', fecha: '2026-10-01', idempotencyKey: key() }, userId)).rejects.toThrow('pagos originales');
    await aplicar(await venta(c.id, 300), 300);
    await expect(fin.eventoReembolso(r.id, { tipo: 'fecha_reclamo', fecha: '2026-12-01', idempotencyKey: key() }, userId)).rejects.toThrow('aplicaciones');
  });
  it('vende un accesorio de otro propietario al cliente con saldo sin cambiar el dueño del stock', async () => {
    const { c } = await conSaldo(1000), p = await producto();
    await ds.getRepository(Producto).update(p.id, { tipo: 'accesorios', vendedor: 'Renato', stockInicial: 3, stockActual: 3 });
    const v = await servicioVentas().create({ productoId: p.id, vendedor: 'Gonzalo (' + c.nombre + ')', precioVenta: 300, cantidad: 1,
      fechaVenta: dia, operacionKey: key(), saldoCliente: { monto: 300, fecha: dia, operacion: key(), pagoAdicional: false } }, userId);
    expect(v.clienteId).toBe(c.id);
    expect((await saldos.historial(c.id)).disponible).toBe('700.00');
    expect((await ds.getRepository(Producto).findOneByOrFail({ id: p.id })).vendedor).toBe('Renato');
    expect((await situacion(v)).saldoPendienteCents).toBe(0);
  });
  it('venta rápida distribuye el saldo entre accesorios y registra solo la diferencia cobrada', async () => {
    const { c } = await conSaldo(1000);
    const servicio = new FinanzasService(ds, ledger, servicioVentas(), saldos);
    const dto = { fecha: dia, vendedor: 'Gonzalo (' + c.nombre + ')', estadoCobro: 'pagado' as const, metodo: 'transferencia' as const,
      idempotencyKey: key(), items: [{ nombre: 'Cable prueba', cantidad: 1, precioUnitario: 400, costoUnitario: 100 },
        { nombre: 'Cargador prueba', cantidad: 1, precioUnitario: 400, costoUnitario: 100 },
        { nombre: 'Hub prueba', cantidad: 1, precioUnitario: 400, costoUnitario: 100 },
        { nombre: 'Mica prueba', cantidad: 1, precioUnitario: 50, costoUnitario: 10 }],
      saldoCliente: { monto: 1000, fecha: dia, operacion: key(), pagoAdicional: true, fechaPago: dia, cuentaId } };
    const res = await servicio.ventaRapida(dto, undefined, userId);
    expect((await saldos.historial(c.id)).disponible).toBe('0.00');
    const pagos = await ds.getRepository(VentaPago).find({ where: res.ventas.map(v => ({ ventaId: v.id })) });
    expect(pagos.filter(p => p.origen === 'saldo_cliente').reduce((n, p) => n + Number(p.montoPen), 0)).toBe(1000);
    expect(pagos.filter(p => p.origen !== 'saldo_cliente').reduce((n, p) => n + Number(p.montoPen), 0)).toBe(250);
    await servicio.ventaRapida(dto, undefined, userId);
    for (const v of res.ventas) expect((await situacion(v)).saldoPendienteCents).toBe(0);
  });
  it('un accesorio agregado a una venta hereda fecha, vendedor y cuenta de cobro, y su ingreso lleva el código ACC', async () => {
    const c = await cliente(), principal = await venta(c.id, 1000);
    await ds.getRepository(Venta).update(principal.id, { vendedor: 'Gonzalo (' + c.nombre + ')', fechaVenta: '2026-10-20' });
    await pago(principal, 1000);
    const servicio = new FinanzasService(ds, ledger, servicioVentas(), saldos);
    const res = await servicio.ventaRapida({ fecha: dia, vendedor: 'Renato', estadoCobro: 'pagado', metodo: 'efectivo',
      ventaRelacionadaId: principal.id, idempotencyKey: key(),
      items: [{ nombre: 'Funda prueba', cantidad: 1, precioUnitario: 80, costoUnitario: 30 }] }, undefined, userId);
    const accesorio = await ds.getRepository(Venta).findOneByOrFail({ id: res.ventas[0].id });
    expect(String(accesorio.fechaVenta).slice(0, 10)).toBe('2026-10-20');
    expect(accesorio.vendedor?.toLowerCase()).toBe(('Gonzalo (' + c.nombre + ')').toLowerCase());
    expect(accesorio.grupoOperacion).toBeTruthy();
    const ingreso = await ds.getRepository(Gasto).findOneByOrFail({ saleId: accesorio.id, concepto: 'ingreso' });
    expect(ingreso.saleSku).toMatch(/^ACC-\d+$/);
    expect(ingreso.tarjeta).toBe('bcp');
  });
  it('el ingreso de una venta en efectivo siempre lleva el código del producto', async () => {
    const servicio = new FinanzasService(ds, ledger, servicioVentas(), saldos);
    const res = await servicio.ventaRapida({ fecha: dia, vendedor: 'Gonzalo', estadoCobro: 'pagado', metodo: 'efectivo',
      idempotencyKey: key(), items: [{ nombre: 'Mica efectivo', cantidad: 1, precioUnitario: 20, costoUnitario: 5 }] }, undefined, userId);
    const ingreso = await ds.getRepository(Gasto).findOneByOrFail({ saleId: res.ventas[0].id, concepto: 'ingreso' });
    expect(ingreso.saleSku).toMatch(/^ACC-\d+$/);
  });
  it('el reembolso recibido en la tarjeta guarda el código del producto', async () => {
    const p = await producto();
    const r = await fin.crearReembolso({ productoId: p.id, motivo: 'No llegó a Eshopex.', fechaIncidencia: '2026-11-01' }, userId);
    const recibido = await fin.eventoReembolso(r.id, { tipo: 'recibido', fecha: '2026-11-02', monto: 750.19, moneda: 'USD', cuentaId: tarjetaId, idempotencyKey: key() }, userId);
    const gasto = await ds.getRepository(Gasto).findOneByOrFail({ id: recibido.eventos!.find((e) => e.tipo === 'recibido')!.gastoId! });
    expect(gasto.saleSku).toBe('MS-' + (p.codigoInventario || p.id));
  });
  it('busca por serie o IMEI también productos vendidos', async () => {
    const c = await cliente(), v = await venta(c.id, 1000);
    await ds.getRepository(Inventario).save({ productoId: v.productoId, serial: 'DMP XK-123ABCD', imei: '35 678901 2345678', accesorios: [] });
    const svc = new InventarioService(ds.getRepository(Inventario), ds.getRepository(Producto), { get: () => '' } as any);
    for (const q of ['dmpxk123abcd', 'DMP-XK123ABCD', 'DMPXKI23ABCD', '356789012345678', '35 678901 2345678']) {
      const [hit] = await svc.buscarPorIdentificador(q);
      expect(hit?.producto.id).toBe(v.productoId);
      expect(hit?.venta?.id).toBe(v.id);
    }
    // Solo coincidencias exactas: nada parecido.
    for (const q of ['dmpxk123', '5678901234', '12', 'DMPXK123ABCE']) expect(await svc.buscarPorIdentificador(q)).toEqual([]);
  });
  it('el historial de cada cliente contiene únicamente sus saldos y aplicaciones', async () => {
    const j = await conSaldo(1000),
      k = await conSaldo(800),
      destino = await venta(j.c.id, 200);
    await aplicar(destino, 200);
    const hj = await saldos.historial(j.c.id),
      hk = await saldos.historial(k.c.id);
    expect(hj.saldos.every((s) => s.cliente_id === j.c.id)).toBe(true);
    expect(hk.saldos.every((s) => s.cliente_id === k.c.id)).toBe(true);
    expect(hj.movimientos).toHaveLength(1);
    expect(hk.movimientos).toHaveLength(0);
  });
  it('anulación y reembolso simultáneos crean un solo saldo y ambos confirman sin duplicar dinero', async () => {
    const c = await cliente(),
      v = await venta(c.id, 1000);
    await ds
      .getRepository(Venta)
      .update(v.id, { vendedor: 'Gonzalo (' + c.nombre + ')' });
    await pago(v, 1000);
    const r = await fin.crearReembolso(
      { productoId: v.productoId, motivo: 'No llegó a Eshopex.' },
      userId,
    );
    await Promise.all([
      servicioVentas().anular(v.id, userId),
      fin.eventoReembolso(
        r.id,
        {
          tipo: 'recibido',
          fecha: '2026-12-12',
          monto: 750.19,
          moneda: 'USD',
          cuentaId: tarjetaId,
          idempotencyKey: key(),
        },
        userId,
      ),
    ]);
    const h = await saldos.historial(c.id);
    expect(h.saldos).toHaveLength(1);
    expect(h.disponible).toBe('1000.00');
  });
  it('una nueva venta con saldo no solicita TC y usa el de la venta anterior aunque el cliente envíe otro',async()=>{
    const {c}=await conSaldo(1000),p=await producto();
    const v=await servicioVentas().create({productoId:p.id,vendedor:'Gonzalo ('+c.nombre+')',fechaVenta:dia,precioVenta:1000,tipoCambio:9.99,operacionKey:key(),saldoCliente:{monto:1000,fecha:dia,operacion:key(),pagoAdicional:false}},userId);
    expect(Number(v.tipoCambio)).toBe(3.4);expect((await ds.getRepository(VentaPago).findOneBy({ventaId:v.id}))?.tipoCambio).toBe('3.4000');
  });
  it('dos orígenes parciales fijan el cambio proporcional de la nueva venta sin TC manual',async()=>{
    const c=await cliente(),a=await venta(c.id,1000),b=await venta(c.id,1000);await ds.getRepository(Venta).update(b.id,{tipoCambio:3.6});
    await pago(a,1000);await pago(b,1000);await generar(a);await generar(b);
    const p=await producto();const v=await servicioVentas().create({productoId:p.id,vendedor:'Gonzalo ('+c.nombre+')',fechaVenta:dia,precioVenta:1500,operacionKey:key(),saldoCliente:{monto:1500,fecha:dia,operacion:key(),pagoAdicional:false}},userId);
    expect(Number(v.tipoCambio)).toBe(3.4642);const h=await saldos.historial(c.id);
    expect(h.movimientos.filter(m=>m.venta_id===v.id).map(m=>[m.monto,m.tipo_cambio])).toEqual([['1000.00','3.4000'],['500.00','3.6000']]);
    expect(h.disponible).toBe('500.00');expect((await situacion(v)).saldoPendienteCents).toBe(0);
  });
  it('el saldo guarda el TC de la venta de origen aunque el pago USD tuviera otra tasa bancaria',async()=>{
    const c=await cliente(),v=await venta(c.id,1000);await ds.getRepository(Venta).update(v.id,{tipoCambio:3.6});
    await ledger.registrarPago({ventaId:v.id,monto:200,moneda:'USD',tipoCambio:3.3,fechaPago:'2026-10-11',metodo:'transferencia',cuentaReceptoraId:cuentaId,idempotencyKey:key()});await generar(v);
    const h=await saldos.historial(c.id);expect(h.saldos[0]).toMatchObject({original:'660.00',tipo_cambio:'3.6000'});
  });

});
