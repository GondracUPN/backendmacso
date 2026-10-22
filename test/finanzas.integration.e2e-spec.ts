/**
 * Pruebas de integración del sistema financiero contra PostgreSQL real.
 *
 * Requiere una base de PRUEBAS (nunca producción) con el esquema migrado:
 *   FINANZAS_IT_DB_URL=postgres://postgres@localhost:55432/finanzas_it npm run test:e2e -- finanzas
 * La suite vacía las tablas de esa base al empezar. Se omite si la variable no existe.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { join } from 'path';
import { AuthModule } from '../src/auth/auth.module';
import { FinanzasModule } from '../src/finanzas/finanzas.module';
import { VentaService } from '../src/venta/venta.service';
import { FinanzasLedgerService } from '../src/finanzas/finanzas-ledger.service';
import { FinanzasService } from '../src/finanzas/finanzas.service';
import { FinanzasAnalisisService } from '../src/finanzas/finanzas-analisis.service';
import { SistemaFinanciero1760832000000 } from '../src/migrations/1760832000000-SistemaFinanciero';
import { Producto } from '../src/producto/producto.entity';
import { User } from '../src/auth/entities/user.entity';
import { Gasto } from '../src/gastos/entities/gasto.entity';
import { VentaPago } from '../src/finanzas/entities/venta-pago.entity';
import { Venta } from '../src/venta/venta.entity';
import { VentaAdelanto } from '../src/venta/venta-adelanto.entity';
import { InventarioService } from '../src/inventario/inventario.service';
import { Inventario } from '../src/inventario/inventario.entity';
import { ProductoService } from '../src/producto/producto.service';
import { IntegridadOperaciones1792537200000 } from '../src/migrations/1792537200000-IntegridadOperaciones';
import { DestinoIngresoVenta1792537300000 } from '../src/migrations/1792537300000-DestinoIngresoVenta';
import { DevolucionesComerciales1792537400000 } from '../src/migrations/1792537400000-DevolucionesComerciales';
import { CostosPendientes1792537500000 } from '../src/migrations/1792537500000-CostosPendientes';
import { ProgramacionesIdempotentes1792537600000 } from '../src/migrations/1792537600000-ProgramacionesIdempotentes';
import { SchedulesService } from '../src/schedules/schedules.service';
import { ScheduledCharge } from '../src/schedules/scheduled-charge.entity';
import { VentaDevolucion } from '../src/venta/venta-devolucion.entity';

const DB_URL = process.env.FINANZAS_IT_DB_URL;
// La suite vacía tablas: solo se permite contra una base local.
if (DB_URL && !/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(DB_URL)) {
  throw new Error('FINANZAS_IT_DB_URL debe apuntar a una base local de pruebas.');
}
const suite = DB_URL ? describe : describe.skip;
jest.setTimeout(120_000);

suite('Sistema financiero (integración PostgreSQL)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ventas: VentaService;
  let ledger: FinanzasLedgerService;
  let finanzas: FinanzasService;
  let analisis: FinanzasAnalisisService;
  let adminToken: string;
  let userToken: string;
  let adminId: number;
  let cuentas: Record<string, number>;
  let seq = 0;
  const key = (label: string) => `it-${label}-${Date.now()}-${++seq}`;

  const http = () => request(app.getHttpServer());
  const post = (url: string, body: any) =>
    http().post(url).set('Authorization', `Bearer ${adminToken}`).send(body);
  const resumen = async (
    from: string,
    to: string,
    extra: Record<string, any> = {},
  ) => (await analisis.analisis({ from, to, ...extra })) as any;

  const crearProducto = async (
    over: {
      tipo?: string;
      usd?: number;
      stock?: number;
      costoTotal?: number;
      nombre?: string;
    } = {},
  ) => {
    const repo = ds.getRepository(Producto);
    const producto = repo.create({
      tipo: over.tipo || 'macbook',
      estado: 'usado',
      accesorios: [],
      stockInicial: over.stock || 1,
      stockActual: over.stock || 1,
      detalle: { gama: over.nombre || 'Pro', modelosCompatibles: [] } as any,
      valor: {
        valorProducto: over.usd ?? 640,
        valorDec: 0,
        peso: 1,
        fechaCompra: new Date('2026-01-01T12:00:00Z'),
        monedaCompra: 'USD',
        valorSoles: over.costoTotal ?? null,
        costoEnvio: 0,
        costoTotal: over.costoTotal ?? null,
      } as any,
      tracking: [],
    });
    return repo.save(producto);
  };

  const crearVenta = async (
    fecha: string,
    parts: Array<{ type: 'direct' | 'card' | 'debt' | 'cash'; amount: number }>,
    precio = 3000,
  ) => {
    const producto = await crearProducto();
    return ventas.create({
      productoId: producto.id,
      tipoCambio: 3.75,
      fechaVenta: fecha,
      precioVenta: precio,
      vendedor: 'Gonzalo',
      incomeParts: parts,
      incomeBank: 'bcp',
    } as any);
  };

  beforeAll(async () => {
    process.env.JWT_SECRET = 'it-secret';
    process.env.SEED_ADMIN = 'false';
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        TypeOrmModule.forRoot({
          type: 'postgres',
          url: DB_URL,
          autoLoadEntities: true,
          entities: [join(__dirname, '../src/**/*.entity.ts')],
          synchronize: false,
          logging: false,
        }),
        AuthModule,
        FinanzasModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
    ds = app.get(DataSource);
    ventas = app.get(VentaService);
    ledger = app.get(FinanzasLedgerService);
    finanzas = app.get(FinanzasService);
    analisis = app.get(FinanzasAnalisisService);

    await ds.query(`TRUNCATE reembolso_eventos, reembolsos, movimientos_financieros, pago_liquidaciones, venta_pagos,
      cuentas_financieras, venta_adelanto, venta, gastos, scheduled_charges, tracking, producto, producto_detalle, producto_valor, users RESTART IDENTITY CASCADE`);
    // Reaplica la migración: debe ser idempotente y sembrar las cuentas base.
    const qr = ds.createQueryRunner();
    await new SistemaFinanciero1760832000000().up(qr);
    await qr.release();

    const users = ds.getRepository(User);
    const admin = await users.save(
      users.create({ username: 'gonzalo', passwordHash: 'x', role: 'admin' }),
    );
    const user = await users.save(
      users.create({ username: 'renato', passwordHash: 'x', role: 'user' }),
    );
    adminId = admin.id;
    const jwt = app.get(JwtService);
    adminToken = jwt.sign(
      { sub: admin.id, username: 'gonzalo', role: 'admin' },
      { secret: 'it-secret' },
    );
    userToken = jwt.sign(
      { sub: user.id, username: 'renato', role: 'user' },
      { secret: 'it-secret' },
    );
    const rows: Array<{ id: number; codigo: string }> = await ds.query(
      'SELECT id, codigo FROM cuentas_financieras',
    );
    cuentas = Object.fromEntries(rows.map((r) => [r.codigo, Number(r.id)]));
  });

  afterAll(async () => {
    await app?.close();
  });

  it('reparación: dos ventas simultáneas del mismo equipo solo crean una', async () => {
    const p = await crearProducto();
    const dto = { productoId: p.id, tipoCambio: 3.75, precioVenta: 3000, fechaVenta: '2047-01-10', vendedor: 'Gonzalo' };
    const results = await Promise.all([ventas.create(dto), ventas.create(dto)]);
    expect(results[0].id).toBe(results[1].id);
    expect(await ds.getRepository(Venta).count({ where: { productoId: p.id } })).toBe(1);
    expect(await ds.getRepository(Gasto).count({ where: { saleId: results[0].id } })).toBe(1);
  });

  it('reparación: último accesorio concurrente, dos solicitudes y una sola salida', async () => {
    const p = await crearProducto({ tipo: 'accesorios', stock: 1, costoTotal: 70 });
    const dto = { productoId: p.id, tipoCambio: 1, precioVenta: 80, cantidad: 1, fechaVenta: '2047-02-10', vendedor: 'Gonzalo' };
    const results = await Promise.allSettled([ventas.create(dto), ventas.create(dto)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await ds.getRepository(Producto).findOneByOrFail({ id: p.id })).stockActual).toBe(0);
    expect(await ds.getRepository(Venta).count({ where: { productoId: p.id } })).toBe(1);
  });

  it('reparación: reintento con la misma clave devuelve la venta y payload distinto da conflicto', async () => {
    const p = await crearProducto({ tipo: 'accesorios', stock: 2, costoTotal: 70 });
    const dto = { productoId: p.id, tipoCambio: 1, precioVenta: 80, cantidad: 1, fechaVenta: '2047-03-10', vendedor: 'Gonzalo', operacionKey: key('venta') };
    const [a, b] = await Promise.all([ventas.create(dto), ventas.create(dto)]);
    expect(a.id).toBe(b.id);
    await expect(ventas.create({ ...dto, precioVenta: 90 })).rejects.toThrow('otros datos');
    expect((await ds.getRepository(Producto).findOneByOrFail({ id: p.id })).stockActual).toBe(1);
  });

  it('reparación: un fallo del ingreso revierte venta, costo y stock en PostgreSQL', async () => {
    const p = await crearProducto({ tipo: 'accesorios', stock: 1, costoTotal: 70 });
    await ds.query(`CREATE FUNCTION repair_reject_income() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.fecha = DATE '2047-04-10' THEN RAISE EXCEPTION 'fallo de ingreso inyectado'; END IF; RETURN NEW; END $$`);
    await ds.query(`CREATE TRIGGER repair_reject_income BEFORE INSERT ON gastos FOR EACH ROW EXECUTE FUNCTION repair_reject_income()`);
    try {
      await expect(ventas.create({ productoId: p.id, tipoCambio: 1, precioVenta: 80, cantidad: 1,
        fechaVenta: '2047-04-10', vendedor: 'Gonzalo' })).rejects.toThrow('fallo de ingreso');
      expect(await ds.getRepository(Venta).count({ where: { productoId: p.id } })).toBe(0);
      expect((await ds.getRepository(Producto).findOneByOrFail({ id: p.id })).stockActual).toBe(1);
    } finally {
      await ds.query('DROP TRIGGER repair_reject_income ON gastos');
      await ds.query('DROP FUNCTION repair_reject_income()');
    }
  });

  it('reparación: carrito con segundo artículo sin stock revierte también el primero', async () => {
    const a = await crearProducto({ tipo: 'accesorios', stock: 1, costoTotal: 70 });
    const b = await crearProducto({ tipo: 'accesorios', stock: 1, costoTotal: 70 });
    await ds.getRepository(Producto).update(b.id, { stockActual: 0 });
    await expect(finanzas.ventaRapida({ idempotencyKey: key('carrito'), fecha: '2047-05-10', tipoCambio: 1,
      vendedor: 'Gonzalo', metodo: 'efectivo', estadoCobro: 'pagado', items: [
        { productoId: a.id, cantidad: 1, precioUnitario: 80 }, { productoId: b.id, cantidad: 1, precioUnitario: 80 },
      ] })).rejects.toThrow('Stock insuficiente');
    expect(await ds.getRepository(Venta).count({ where: { productoId: a.id } })).toBe(0);
    expect((await ds.getRepository(Producto).findOneByOrFail({ id: a.id })).stockActual).toBe(1);
  });

  it('reparación: compra PEN, edición y cobro conservan moneda y costo histórico', async () => {
    const p = await crearProducto({ usd: 1000 });
    p.valor.monedaCompra = 'PEN';
    await ds.getRepository(Producto).save(p);
    const v = await ventas.create({ productoId: p.id, tipoCambio: 3.7, precioVenta: 1500,
      fechaVenta: '2048-01-10', vendedor: 'Gonzalo', incomeBank: 'interbank' });
    expect(Number(v.ganancia)).toBe(500);
    await ventas.update(v.id, { fechaVenta: '2048-01-11' });
    const rows = await ds.getRepository(Gasto).find({ where: { saleId: v.id } });
    expect(rows).toHaveLength(1); expect(rows[0].tarjeta).toBe('interbank');
    expect(Number((await ds.getRepository(Venta).findOneByOrFail({ id: v.id })).ganancia)).toBe(500);
  });

  it('reparación: venta rápida a cuenta nueva conserva ID, Yape e ingreso único', async () => {
    const cuenta = await finanzas.crearCuenta({ codigo: 'yape_nuevo', nombre: 'Yape nuevo', tipo: 'billetera', moneda: 'PEN' });
    const result = await finanzas.ventaRapida({ idempotencyKey: key('yape-nuevo'), fecha: '2048-02-10',
      tipoCambio: 1, vendedor: 'Gonzalo', metodo: 'yape', estadoCobro: 'pagado', cuentaReceptoraId: cuenta.id,
      items: [{ nombre: 'Mica de prueba Yape', cantidad: 1, precioUnitario: 80, costoUnitario: 50 }] });
    const v = result.ventas[0];
    const pagos = await ds.getRepository(VentaPago).find({ where: { ventaId: v.id } });
    expect(pagos).toHaveLength(1);
    expect(pagos[0]).toMatchObject({ cuentaReceptoraId: cuenta.id, metodo: 'yape', montoPen: '80.00' });
    const ingresos = await ds.getRepository(Gasto).find({ where: { saleId: v.id } });
    expect(ingresos).toHaveLength(1);
    expect(ingresos[0]).toMatchObject({ tarjeta: 'yape_nuevo', saleCuentaId: cuenta.id, saleMetodo: 'yape' });
  });

  it('reparación: reserva cancelada libera inventario y permite volver a reservar', async () => {
    const p = await crearProducto();
    await ds.query(`INSERT INTO tracking ("productoId", estado, "fechaRecogido") VALUES ($1, 'recogido', '2049-01-01')`, [p.id]);
    const inventario = new InventarioService(ds.getRepository(Inventario), ds.getRepository(Producto), { get: () => '' } as any);
    const productos = new ProductoService(ds.getRepository(Producto), {} as any, {} as any, {} as any,
      ds.getRepository(Venta), {} as any, {} as any, { del: async () => {} } as any);
    const antes = await productos.stats(); const resumenAntes = await productos.resumen();
    const a = await ventas.createAdelanto({ productoId: p.id, montoAdelanto: 100, montoVenta: 3000, fechaAdelanto: '2049-01-02' });
    expect((await productos.stats()).disponibles).toBe(antes.disponibles - 1);
    expect((await productos.resumen()).disponible).toBe(resumenAntes.disponible - 1);
    expect((await inventario.findDisponibles()).some((row) => row.producto.id === p.id)).toBe(false);
    await ventas.cancelAdelanto(a.id, { fechaDevolucion: '2049-01-03', cuentaId: cuentas.bcp });
    expect((await inventario.findDisponibles()).some((row) => row.producto.id === p.id)).toBe(true);
    expect((await productos.stats()).disponibles).toBe(antes.disponibles);
    expect((await productos.resumen()).disponible).toBe(resumenAntes.disponible);
    const b = await ventas.createAdelanto({ productoId: p.id, montoAdelanto: 100, montoVenta: 3000, fechaAdelanto: '2049-01-04' });
    expect(b.id).not.toBe(a.id);
  });

  it('reparación: devolver una de tres unidades restituye solo una y conserva el historial', async () => {
    const p = await crearProducto({ tipo: 'accesorios', stock: 3, costoTotal: 210 });
    const v = await ventas.create({ productoId: p.id, tipoCambio: 1, cantidad: 3, precioVenta: 240,
      fechaVenta: '2049-02-01', vendedor: 'Gonzalo', incomeParts: [{ type: 'direct', amount: 240 }], incomeBank: 'bcp' });
    await expect(ventas.remove(v.id, 'Intento de borrar')).rejects.toThrow('devolución');
    const dto = { operacionKey: key('devolver'), cantidad: 1, monto: 80, destino: 'disponible' as const,
      fecha: '2049-02-02', motivo: 'Devolución parcial de prueba', cuentaId: cuentas.bcp };
    const d = await ventas.devolver(v.id, dto, adminId);
    expect((await ventas.devolver(v.id, dto, adminId)).id).toBe(d.id);
    expect((await ds.getRepository(Producto).findOneByOrFail({ id: p.id })).stockActual).toBe(1);
    expect(await ds.getRepository(Venta).count({ where: { id: v.id } })).toBe(1);
    expect(await ds.getRepository(VentaDevolucion).count({ where: { ventaId: v.id } })).toBe(1);
    const salida = await ds.getRepository(Gasto).find({ where: { saleId: v.id, concepto: 'devolucion_venta' } });
    expect(salida).toHaveLength(1); expect(salida[0].monto).toBe('80.00');
    const detail = await finanzas.detalleVenta(v.id);
    expect(detail.finanzas).toMatchObject({ cobradoCliente: 160, saldoPendiente: 0, gananciaFinal: 20 });
    const productos = new ProductoService(ds.getRepository(Producto), {} as any, {} as any, {} as any,
      ds.getRepository(Venta), {} as any, {} as any, { del: async () => {} } as any);
    await expect(productos.remove(p.id)).rejects.toThrow('historial');
    await expect(ventas.update(v.id, { precioVenta: 200 })).rejects.toThrow('devoluciones');
  });

  it('reparación: devolución parcial de una venta a crédito reduce la deuda sin inventar un reembolso', async () => {
    const p = await crearProducto({ tipo: 'accesorios', stock: 3, costoTotal: 210 });
    const v = await ventas.create({ productoId: p.id, tipoCambio: 1, cantidad: 3, precioVenta: 240,
      fechaVenta: '2049-03-01', vendedor: 'Gonzalo', incomeParts: [{ type: 'card', amount: 240 }], incomeBank: 'bcp' });
    await ventas.devolver(v.id, { operacionKey: key('dev-credito'), cantidad: 1, monto: 0, destino: 'disponible',
      fecha: '2049-03-02', motivo: 'Devuelve unidad sin haberla pagado' }, adminId);
    expect((await finanzas.detalleVenta(v.id)).finanzas).toMatchObject({ cobradoCliente: 0, saldoPendiente: 160, gananciaFinal: 20 });
  });

  it('reparación: completar costo pendiente deja trazabilidad y las mismas ganancias en ambos cuadros', async () => {
    const r = await finanzas.ventaRapida({ idempotencyKey: key('costo-pendiente'), fecha: '2049-04-01',
      vendedor: 'Gonzalo', tipoCambio: 1, metodo: 'efectivo', estadoCobro: 'pagado',
      items: [{ nombre: 'Accesorio sin costo inicial', cantidad: 1, precioUnitario: 80 }] });
    const id = r.ventas[0].id;
    const antes = await ventas.findAll({ productoId: r.ventas[0].productoId });
    expect(antes[0].costoPendiente).toBe(true); expect(antes[0].ganancia).toBeNull();
    const updated = await finanzas.completarCosto(id, 50, 'Factura de prueba C-10', adminId);
    expect(updated).toMatchObject({ costoPendiente: false, costoCompletadoPor: adminId, costoDocumento: 'Factura de prueba C-10', ganancia: 30 });
    expect(updated.costoCompletadoAt).toBeInstanceOf(Date);
    expect((await finanzas.detalleVenta(id)).finanzas.gananciaFinal).toBe(30);
    expect(Number((await ventas.findAll({ productoId: r.ventas[0].productoId }))[0].ganancia)).toBe(30);
    await expect(finanzas.completarCosto(id, 51, 'Otra factura', adminId)).rejects.toThrow('ya está confirmado');
  });

  it('20. los endpoints financieros exigen autenticación y rol administrador', async () => {
    await http().get('/finanzas/analisis').expect(401);
    await http()
      .get('/finanzas/analisis')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(403);
    await http()
      .get('/finanzas/analisis?from=2030-01-01&to=2030-01-31')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    await http()
      .post('/finanzas/pagos')
      .set('Authorization', `Bearer ${userToken}`)
      .send({})
      .expect(403);
  });

  it('1. venta pagada y disponible el mismo día: se cuenta una sola vez', async () => {
    const venta = await crearVenta('2031-01-10', [
      { type: 'direct', amount: 3000 },
    ]);
    expect(Number(venta.ganancia)).toBe(600);
    const pagos = await ds
      .getRepository(VentaPago)
      .find({ where: { ventaId: venta.id } });
    expect(pagos).toHaveLength(1);
    expect(pagos[0]).toMatchObject({
      estado: 'disponible',
      verificado: true,
      origen: 'ingreso_venta',
      fechaPago: '2031-01-10',
    });
    const r = await resumen('2031-01-01', '2031-01-31');
    expect(r.resumen).toMatchObject({
      ventas: 1,
      ingresosComerciales: 3000,
      gananciaComercial: 600,
      margenCobrado: 600,
      cajaEntradas: 3000,
      porCobrar: 0,
    });
  });

  it('2 y 6. venta de junio cobrada entre junio y septiembre, sin crear ventas nuevas', async () => {
    const venta = await crearVenta('2032-06-10', [
      { type: 'card', amount: 3000 },
    ]);
    const ventasAntes = await ds.getRepository(Venta).count();
    for (const [monto, fecha] of [
      [900, '2032-06-15'],
      [1200, '2032-08-05'],
      [900, '2032-09-20'],
    ] as const) {
      await post('/finanzas/pagos', {
        ventaId: venta.id,
        monto,
        fechaPago: fecha,
        metodo: 'transferencia',
        cuentaReceptoraId: cuentas.bcp,
        idempotencyKey: key('p'),
      }).expect(201);
    }
    expect(await ds.getRepository(Venta).count()).toBe(ventasAntes);
    // El ingreso por cobrar existente en Gastos queda al día y no se duplica al resincronizar.
    const [ingreso] = await ds
      .getRepository(Gasto)
      .find({ where: { saleId: venta.id, salePaymentType: 'card' } });
    expect(Number(ingreso.saleReceivedAmount)).toBe(3000);
    expect(ingreso.salePaymentHistory?.every((h) => h.pagoId)).toBe(true);
    await ledger.sincronizarIngresosVenta(venta.id);
    const pagos = await ds
      .getRepository(VentaPago)
      .find({ where: { ventaId: venta.id } });
    expect(pagos.filter((p) => !p.anuladoAt)).toHaveLength(3);

    const jun = await resumen('2032-06-01', '2032-06-30');
    const jul = await resumen('2032-07-01', '2032-07-31');
    const ago = await resumen('2032-08-01', '2032-08-31');
    const sep = await resumen('2032-09-01', '2032-09-30');
    expect(
      [jun, jul, ago, sep].map((m) => m.resumen.gananciaComercial),
    ).toEqual([600, 0, 0, 0]);
    expect([jun, jul, ago, sep].map((m) => m.resumen.margenCobrado)).toEqual([
      180, 0, 240, 180,
    ]);
    const soloEsta = { productoId: venta.productoId };
    expect(
      (await resumen('2032-07-01', '2032-07-31', soloEsta)).resumen.porCobrar,
    ).toBe(2100); // 6. cobro parcial
    expect(
      (await resumen('2032-09-01', '2032-09-30', soloEsta)).resumen.porCobrar,
    ).toBe(0);
    expect(ago.cobros.cobrosVentasAnteriores).toMatchObject({
      monto: 1200,
      ventas: 1,
      margen: 240,
    });
    // 19. Pagos + saldo = precio; las entradas de caja de la venta suman su precio.
    const total = await resumen('2032-06-01', '2032-09-30');
    expect(total.flujo.porCategoria.cobro_cliente).toBe(3000);
    expect(total.resumen.margenCobrado).toBe(600);
  });

  it('3. adelanto previo a la entrega: margen recién en la fecha comercial y con historial', async () => {
    const producto = await crearProducto();
    const adelanto = await ventas.createAdelanto({
      productoId: producto.id,
      montoAdelanto: 500,
      fechaAdelanto: '2033-06-01',
      montoVenta: 3000,
      incomeBank: 'bcp',
    } as any);
    await ventas.addAdelantoCuota(adelanto.id, {
      montoCuota: 300,
      fechaCuota: '2033-06-05',
      incomeBank: 'bcp',
    } as any);
    expect(
      await ds
        .getRepository(VentaPago)
        .count({ where: { adelantoId: adelanto.id } }),
    ).toBe(2);
    const antes = await resumen('2033-06-01', '2033-06-19');
    expect(antes.resumen).toMatchObject({
      gananciaComercial: 0,
      margenCobrado: 0,
      cajaEntradas: 800,
    });
    const venta = await ventas.completeAdelanto(adelanto.id, {
      fechaVenta: '2033-06-20',
      tipoCambio: 3.75,
      incomeBank: 'bcp',
      incomeParts: [{ type: 'direct', amount: 2200 }],
    } as any);
    expect(venta.fechaReserva).toBe('2033-06-01');
    const pagos = await ds
      .getRepository(VentaPago)
      .find({ where: { ventaId: venta.id } });
    expect(
      pagos
        .filter((p) => !p.anuladoAt)
        .reduce((a, p) => a + Number(p.montoPen), 0),
    ).toBe(3000);
    expect(pagos.filter((p) => p.esAdelanto)).toHaveLength(2);
    const junio = await resumen('2033-06-01', '2033-06-30');
    expect(junio.resumen).toMatchObject({
      ventas: 1,
      gananciaComercial: 600,
      margenCobrado: 600,
      cajaEntradas: 3000,
    });
  });

  it('4, 5 y 19. tarjeta pagada en junio, liquidada en agosto con comisión', async () => {
    const venta = await crearVenta('2034-06-12', [
      { type: 'card', amount: 3000 },
    ]);
    const pago = (
      await post('/finanzas/pagos', {
        ventaId: venta.id,
        monto: 3000,
        fechaPago: '2034-06-12',
        metodo: 'tarjeta',
        comisionEstimada: 120,
        fechaLiquidacionEstimada: '2034-08-15',
        idempotencyKey: key('t'),
      }).expect(201)
    ).body;
    expect(pago).toMatchObject({
      estado: 'pendiente_liquidacion',
      requiereLiquidacion: true,
      cuentaReceptoraId: cuentas.procesador,
    });
    const junio = await resumen('2034-06-01', '2034-06-30');
    expect(junio.resumen).toMatchObject({
      retenidoIntermediarios: 3000,
      cajaEntradas: 0,
      margenCobrado: 0,
      gananciaComercial: 600,
    });
    expect(
      (
        await resumen('2034-06-01', '2034-06-30', {
          productoId: venta.productoId,
        })
      ).resumen.porCobrar,
    ).toBe(0);
    expect(junio.cobros.porLiquidar[0]).toMatchObject({
      pendiente: 3000,
      comisionEstimada: 120,
    });

    await post(`/finanzas/pagos/${pago.id}/eventos`, {
      tipo: 'liquidacion',
      fecha: '2034-08-20',
      montoBruto: 3000,
      comision: 120,
      cuentaId: cuentas.bcp,
      idempotencyKey: key('l'),
    }).expect(201);
    const agosto = await resumen('2034-08-01', '2034-08-31');
    expect(agosto.resumen).toMatchObject({
      cajaEntradas: 2880,
      margenCobrado: 480,
      retenidoIntermediarios: 0,
      gananciaComercial: 0,
    });
    const detalle = await finanzas.detalleVenta(venta.id);
    expect(detalle.finanzas).toMatchObject({
      estadoCobro: 'pagado',
      estadoLiquidacion: 'liquidado',
      comisionesReales: 120,
      gananciaFinal: 480,
      disponible: 2880,
    });
    // 19. retenido + liquidado neto + comisión = lo que pagó el cliente
    expect(
      detalle.finanzas.disponible +
        detalle.finanzas.comisionesReales +
        detalle.finanzas.pendienteLiquidacion,
    ).toBe(3000);
    const anual = await resumen('2034-01-01', '2034-12-31');
    expect(anual.rentabilidad.totales).toMatchObject({
      gananciaComercial: 600,
      comisiones: 120,
      gananciaFinalVentas: 480,
    });
  });

  it('7. reserva cancelada con devolución: se conserva el historial y no hay venta', async () => {
    const producto = await crearProducto();
    const adelanto = await ventas.createAdelanto({
      productoId: producto.id,
      montoAdelanto: 400,
      fechaAdelanto: '2035-03-01',
      montoVenta: 2500,
      incomeBank: 'bcp',
    } as any);
    await ventas.cancelAdelanto(adelanto.id, {
      fechaDevolucion: '2035-03-10',
      motivo: 'Cliente desistió',
    });
    const guardado = await ds
      .getRepository(VentaAdelanto)
      .findOne({ where: { id: adelanto.id } });
    expect(guardado).toMatchObject({
      fechaDevolucion: '2035-03-10',
      motivoCancelacion: 'Cliente desistió',
    });
    expect(guardado?.canceladoAt).toBeTruthy();
    const [pago] = await ds
      .getRepository(VentaPago)
      .find({
        where: { adelantoId: adelanto.id },
        relations: ['liquidaciones'],
      });
    expect(pago.estado).toBe('devuelto');
    expect(pago.liquidaciones?.[0]).toMatchObject({
      tipo: 'devolucion',
      fecha: '2035-03-10',
    });
    const marzo = await resumen('2035-03-01', '2035-03-31');
    expect(marzo.resumen).toMatchObject({
      ventas: 0,
      gananciaComercial: 0,
      cajaEntradas: 400,
      cajaSalidas: 400,
      flujoNeto: 0,
    });
    // Ya no aparece como reserva activa y el producto puede reservarse de nuevo.
    expect(
      (await ventas.findLatestAdelantosByProductos([producto.id])).length,
    ).toBe(0);
  });

  it('8. producto comprado y reembolsado dos meses después: recupera capital, no es venta', async () => {
    const producto = await crearProducto({ tipo: 'iphone', costoTotal: 1500 });
    const r = await finanzas.crearReembolso({
      productoId: producto.id,
      fechaIncidencia: '2036-07-05',
      motivo: 'Nunca llegó',
    } as any);
    const abierto = await resumen('2036-07-01', '2036-07-31');
    expect(abierto.capital.enReclamacion).toBeGreaterThanOrEqual(1500);
    expect(abierto.resumen.reembolsosPendientes).toBeGreaterThanOrEqual(1500);
    await finanzas.eventoReembolso(
      r.id,
      {
        tipo: 'aprobado',
        fecha: '2036-07-20',
        monto: 1500,
        idempotencyKey: key('a'),
      } as any,
      adminId,
    );
    const fin = await finanzas.eventoReembolso(
      r.id,
      {
        tipo: 'recibido',
        fecha: '2036-08-10',
        monto: 1500,
        cuentaId: cuentas.bcp,
        idempotencyKey: key('r'),
      } as any,
      adminId,
    );
    expect(fin.estado).toBe('recibido');
    expect(fin.resumen).toMatchObject({ irrecuperable: 0, porRecuperar: 0 });
    const agosto = await resumen('2036-08-01', '2036-08-31');
    expect(agosto.resumen).toMatchObject({
      ventas: 0,
      gananciaComercial: 0,
      ingresosComerciales: 0,
    });
    expect(agosto.flujo.recuperacionesReembolso).toBe(1500);
    expect(agosto.flujo.porCategoria.reembolso_recibido).toBe(1500);
    expect(agosto.rentabilidad.totales.perdidas).toBe(0);
    expect(
      (await ds.getRepository(Producto).findOne({ where: { id: producto.id } }))
        ?.cierreMotivo,
    ).toBe('perdido');
  });

  it('9. reembolso parcial y pérdida irrecuperable reconocida una sola vez', async () => {
    const producto = await crearProducto({ tipo: 'iphone', costoTotal: 1500 });
    const r = await finanzas.crearReembolso({
      productoId: producto.id,
      fechaIncidencia: '2037-02-01',
    } as any);
    await finanzas.eventoReembolso(
      r.id,
      {
        tipo: 'gasto_adicional',
        fecha: '2037-02-02',
        monto: 50,
        idempotencyKey: key('g'),
      } as any,
      adminId,
    );
    const parcial = await finanzas.eventoReembolso(
      r.id,
      {
        tipo: 'recibido',
        fecha: '2037-03-01',
        monto: 1000,
        cuentaId: cuentas.bcp,
        idempotencyKey: key('r'),
      } as any,
      adminId,
    );
    expect(parcial.estado).toBe('reembolso_parcial');
    const cerrado = await finanzas.eventoReembolso(
      r.id,
      { tipo: 'perdida', fecha: '2037-04-01', idempotencyKey: key('p') } as any,
      adminId,
    );
    expect(cerrado.resumen).toMatchObject({
      irrecuperable: 550,
      cerrado: true,
    });
    expect(
      (await resumen('2037-04-01', '2037-04-30')).rentabilidad.totales
        .perdidasReembolsos,
    ).toBe(550);
    expect(
      (await resumen('2037-03-01', '2037-03-31')).rentabilidad.totales
        .perdidasReembolsos,
    ).toBe(0);
  });

  it('10. reembolso a tarjeta de crédito reduce su deuda, no es depósito bancario', async () => {
    const producto = await crearProducto({ tipo: 'ipad', costoTotal: 800 });
    const r = await finanzas.crearReembolso({
      productoId: producto.id,
      fechaIncidencia: '2038-05-01',
    } as any);
    await finanzas.eventoReembolso(
      r.id,
      {
        tipo: 'recibido',
        fecha: '2038-05-15',
        monto: 800,
        cuentaId: cuentas.tc_interbank,
        idempotencyKey: key('r'),
      } as any,
      adminId,
    );
    const gastos = await ds.query(
      `SELECT metodo_pago, concepto, tarjeta, monto FROM gastos WHERE notas LIKE $1`,
      [`__REFUND__:${r.id}:%`],
    );
    expect(gastos).toEqual([
      {
        metodo_pago: 'credito',
        concepto: 'ingreso',
        tarjeta: 'interbank',
        monto: '800.00',
      },
    ]);
    const mayo = await resumen('2038-05-01', '2038-05-31');
    expect(mayo.flujo.reembolsosATarjeta).toBe(800);
    expect(mayo.resumen.cajaEntradas).toBe(0);
  });

  it('11 y 12. venta rápida de accesorios, con y sin costo conocido, idempotente', async () => {
    const cubo = await crearProducto({
      tipo: 'accesorios',
      stock: 10,
      costoTotal: 100,
      usd: 0,
      nombre: 'Cubo 20W',
    });
    const body = {
      fecha: '2039-01-15',
      metodo: 'efectivo',
      estadoCobro: 'pagado',
      vendedor: 'Gonzalo',
      idempotencyKey: key('vr'),
      items: [
        { productoId: cubo.id, cantidad: 2, precioUnitario: 35 },
        { nombre: 'Mica', cantidad: 1, precioUnitario: 15, costoUnitario: 3 },
        { nombre: 'Cable genérico', cantidad: 1, precioUnitario: 20 },
      ],
    };
    const res = (await post('/finanzas/ventas-rapidas', body).expect(201)).body;
    expect(res.ventas).toHaveLength(3);
    expect(new Set(res.ventas.map((v: any) => v.grupoOperacion)).size).toBe(1);
    const repetida = (await post('/finanzas/ventas-rapidas', body).expect(201))
      .body;
    expect(repetida.repetida).toBe(true);
    expect(
      await ds
        .getRepository(Venta)
        .count({ where: { grupoOperacion: res.grupoOperacion } }),
    ).toBe(3);
    expect(
      (await ds.getRepository(Producto).findOne({ where: { id: cubo.id } }))
        ?.stockActual,
    ).toBe(8);
    const [cuboVenta, mica, cable] = res.ventas;
    expect(Number(cuboVenta.ganancia)).toBe(50);
    expect(Number(mica.ganancia)).toBe(12);
    expect(cable).toMatchObject({ costoPendiente: true });
    expect(
      cable.distribucionStock.every((d: any) => d.costoUnitario === undefined),
    ).toBe(true);
    const enero = await resumen('2039-01-01', '2039-01-31');
    expect(enero.resumen).toMatchObject({
      ventas: 3,
      ingresosComerciales: 105,
      gananciaComercial: 62,
      ventasSinCosto: 1,
      cajaEntradas: 105,
    });
    expect(enero.rentabilidad.totales.gananciaNetaEstimada).toBeNull();
    const pagos = await ds
      .getRepository(VentaPago)
      .find({ where: { ventaId: cuboVenta.id } });
    expect(pagos[0]).toMatchObject({
      metodo: 'efectivo',
      cuentaReceptoraId: cuentas.efectivo,
    });
  });

  it('13. compra con tarjeta y pago posterior de la deuda: el costo no se duplica', async () => {
    const gastos = ds.getRepository(Gasto);
    await gastos.save(
      gastos.create({
        userId: adminId,
        concepto: 'inversion',
        metodoPago: 'credito',
        tarjeta: 'interbank',
        moneda: 'PEN',
        monto: '1000.00',
        fecha: '2040-06-05',
        clasificacionFinanciera: 'costo_inventario',
      }),
    );
    await gastos.save(
      gastos.create({
        userId: adminId,
        concepto: 'pago_tarjeta',
        metodoPago: 'debito',
        tarjeta: 'bcp',
        tarjetaPago: 'interbank',
        moneda: 'PEN',
        monto: '1000.00',
        fecha: '2040-07-10',
        clasificacionFinanciera: 'movimiento_deuda',
      }),
    );
    const junio = await resumen('2040-06-01', '2040-06-30');
    expect(junio.resumen.cajaSalidas).toBe(0);
    expect(junio.flujo.comprasConTarjeta).toBe(1000);
    expect(junio.rentabilidad.totales.gastosOperativos).toBe(0);
    const julio = await resumen('2040-07-01', '2040-07-31');
    expect(julio.resumen.cajaSalidas).toBe(1000);
    expect(julio.flujo.pagosTarjeta).toBe(1000);
    expect(julio.rentabilidad.totales.gastosOperativos).toBe(0);
    expect(julio.rentabilidad.totales.gananciaNetaParcial).toBe(0);
  });

  it('14. transferencia entre cuentas propias no infla el flujo consolidado', async () => {
    await post('/finanzas/movimientos', {
      tipo: 'transferencia',
      fecha: '2041-02-02',
      cuentaOrigenId: cuentas.bcp,
      cuentaDestinoId: cuentas.efectivo,
      monto: 500,
      idempotencyKey: key('m'),
    }).expect(201);
    const feb = await resumen('2041-02-01', '2041-02-28');
    expect(feb.resumen).toMatchObject({
      cajaEntradas: 0,
      cajaSalidas: 0,
      flujoNeto: 0,
      transferenciasInternas: 500,
    });
    await post('/finanzas/movimientos', {
      tipo: 'transferencia',
      fecha: '2041-02-03',
      cuentaOrigenId: cuentas.bcp,
      cuentaDestinoId: cuentas.tc_bcp_visa,
      monto: 100,
      idempotencyKey: key('m'),
    }).expect(400);
  });

  it('15. pagos, liquidaciones y movimientos repetidos se registran una sola vez (también en paralelo)', async () => {
    const venta = await crearVenta('2042-03-01', [
      { type: 'card', amount: 3000 },
    ]);
    const k = key('dup');
    const body = {
      ventaId: venta.id,
      monto: 1000,
      fechaPago: '2042-03-02',
      metodo: 'tarjeta',
      idempotencyKey: k,
    };
    const results = await Promise.all([
      post('/finanzas/pagos', body),
      post('/finanzas/pagos', body),
      post('/finanzas/pagos', body),
    ]);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(
      await ds.getRepository(VentaPago).count({ where: { idempotencyKey: k } }),
    ).toBe(1);
    const pagoId = results[0].body.id;
    const lk = key('liq');
    const liq = {
      tipo: 'liquidacion',
      fecha: '2042-03-05',
      montoBruto: 1000,
      comision: 30,
      cuentaId: cuentas.bcp,
      idempotencyKey: lk,
    };
    const liqs = await Promise.all([
      post(`/finanzas/pagos/${pagoId}/eventos`, liq),
      post(`/finanzas/pagos/${pagoId}/eventos`, liq),
    ]);
    expect(new Set(liqs.map((r) => r.body.id)).size).toBe(1);
    // Una segunda liquidación distinta no puede superar lo pendiente.
    await post(`/finanzas/pagos/${pagoId}/eventos`, {
      ...liq,
      idempotencyKey: key('liq2'),
    }).expect(400);
    // Un pago que supera el saldo se rechaza.
    await post('/finanzas/pagos', {
      ...body,
      monto: 2500,
      idempotencyKey: key('over'),
    }).expect(400);
  });

  it('16. pagos en USD y PEN con conversión trazable', async () => {
    const venta = await crearVenta('2043-04-01', [
      { type: 'card', amount: 3000 },
    ]);
    const usd = (
      await post('/finanzas/pagos', {
        ventaId: venta.id,
        monto: 100,
        moneda: 'USD',
        tipoCambio: 3.8,
        fechaPago: '2043-04-02',
        metodo: 'transferencia',
        cuentaReceptoraId: cuentas.bcp,
        idempotencyKey: key('usd'),
      }).expect(201)
    ).body;
    expect(usd).toMatchObject({
      moneda: 'USD',
      monto: '100.00',
      tipoCambio: '3.8000',
      montoPen: '380.00',
    });
    await post('/finanzas/pagos', {
      ventaId: venta.id,
      monto: 100,
      moneda: 'USD',
      fechaPago: '2043-04-02',
      metodo: 'transferencia',
      cuentaReceptoraId: cuentas.bcp,
      idempotencyKey: key('usd'),
    }).expect(400);
    const detalle = await finanzas.detalleVenta(venta.id);
    expect(detalle.finanzas.saldoPendiente).toBe(2620);
  });

  it('17. correcciones y contracargos posteriores', async () => {
    const venta = await crearVenta('2044-05-01', [
      { type: 'card', amount: 3000 },
    ]);
    const pago = (
      await post('/finanzas/pagos', {
        ventaId: venta.id,
        monto: 3000,
        fechaPago: '2044-05-01',
        metodo: 'tarjeta',
        idempotencyKey: key('t'),
      })
    ).body;
    await post(`/finanzas/pagos/${pago.id}/eventos`, {
      tipo: 'liquidacion',
      fecha: '2044-05-03',
      montoBruto: 3000,
      comision: 0,
      cuentaId: cuentas.bcp,
      idempotencyKey: key('l'),
    }).expect(201);
    await post(`/finanzas/pagos/${pago.id}/eventos`, {
      tipo: 'contracargo',
      fecha: '2044-06-10',
      montoBruto: 3000,
      cuentaId: cuentas.bcp,
      idempotencyKey: key('c'),
    }).expect(201);
    let d = await finanzas.detalleVenta(venta.id);
    expect(d.finanzas).toMatchObject({
      estadoCobro: 'disputado',
      cobradoCliente: 0,
      gananciaFinal: -2400,
    });
    expect(
      (await resumen('2044-06-01', '2044-06-30')).resumen.cajaSalidas,
    ).toBe(3000);
    await post(`/finanzas/pagos/${pago.id}/eventos`, {
      tipo: 'reversion_contracargo',
      fecha: '2044-07-01',
      montoBruto: 3000,
      cuentaId: cuentas.bcp,
      idempotencyKey: key('rv'),
    }).expect(201);
    d = await finanzas.detalleVenta(venta.id);
    expect(d.finanzas).toMatchObject({
      estadoCobro: 'pagado',
      gananciaFinal: 600,
      margenLiberado: 600,
    });

    // Corrección: un pago manual registrado por error se anula y deja de contar en Gastos.
    const otra = await crearVenta('2044-08-01', [
      { type: 'card', amount: 3000 },
    ]);
    const malo = (
      await post('/finanzas/pagos', {
        ventaId: otra.id,
        monto: 500,
        fechaPago: '2044-08-02',
        metodo: 'transferencia',
        cuentaReceptoraId: cuentas.bcp,
        idempotencyKey: key('x'),
      })
    ).body;
    await post(`/finanzas/pagos/${malo.id}/anular`, {
      motivo: 'Registrado dos veces',
    }).expect(201);
    const [ingreso] = await ds
      .getRepository(Gasto)
      .find({ where: { saleId: otra.id, salePaymentType: 'card' } });
    expect(Number(ingreso.saleReceivedAmount)).toBe(0);
    expect((await finanzas.detalleVenta(otra.id)).finanzas.saldoPendiente).toBe(
      3000,
    );
  });

  it('18. migración de ventas históricas: no inventa pagos y exige conciliación', async () => {
    const porCobrarAntes = (await resumen('2045-01-01', '2045-01-31')).resumen
      .porCobrar;
    const producto = await crearProducto();
    const [venta] = await ds.query(
      `
      INSERT INTO venta ("productoId", "tipoCambio", "fechaVenta", "precioVenta", ganancia, "porcentajeGanancia", vendedor, "conciliacionHistorica")
      VALUES ($1, 3.75, '2045-01-20', 3000, 600, 25, 'Gonzalo', 'pendiente') RETURNING id`,
      [producto.id],
    );
    const sinRegistro = await crearProducto();
    await ds.query(
      `
      INSERT INTO venta ("productoId", "tipoCambio", "fechaVenta", "precioVenta", ganancia, "porcentajeGanancia", vendedor, "conciliacionHistorica")
      VALUES ($1, 3.75, '2045-01-25', 2000, 300, 17.6, 'Gonzalo', 'pendiente')`,
      [sinRegistro.id],
    );
    await ds.getRepository(Gasto).save(
      ds.getRepository(Gasto).create({
        userId: adminId,
        concepto: 'ingreso',
        metodoPago: 'debito',
        tarjeta: 'bcp',
        moneda: 'PEN',
        monto: '3000.00',
        fecha: '2045-01-20',
        saleId: venta.id,
        notas: `__SALE_INCOME__:${producto.id}:${venta.id}`,
      }),
    );
    const antes = await ds.getRepository(VentaPago).count();
    const simulacion = await finanzas.backfillHistorico(true);
    expect(simulacion.pagosCreados).toBeGreaterThanOrEqual(1);
    expect(await ds.getRepository(VentaPago).count()).toBe(antes); // simulación sin escribir
    await finanzas.backfillHistorico(false);
    await finanzas.backfillHistorico(false); // idempotente
    const pagos = await ds
      .getRepository(VentaPago)
      .find({ where: { ventaId: venta.id } });
    expect(pagos).toHaveLength(1);
    expect(pagos[0]).toMatchObject({
      verificado: false,
      fechaPago: '2045-01-20',
      montoPen: '3000.00',
    });
    let enero = await resumen('2045-01-01', '2045-01-31');
    expect(enero.resumen.gananciaComercial).toBe(900); // la fecha comercial y la ganancia se conservan
    expect(enero.resumen.cajaEntradas).toBe(0); // no se toma como caja hasta verificarlo
    expect(enero.resumen.porCobrar).toBe(porCobrarAntes); // ni se inventa una deuda
    expect(enero.resumen.historicosPendientes.ventas).toBe(2);
    expect(enero.advertencias.join(' ')).toMatch(/sin conciliar/);
    await post(`/finanzas/conciliacion/${venta.id}`, {
      modo: 'confirmar_registros',
    }).expect(201);
    enero = await resumen('2045-01-01', '2045-01-31');
    expect(enero.resumen.cajaEntradas).toBe(3000);
    expect(enero.resumen.historicosPendientes.ventas).toBe(1);
    const otra = (
      await ds.query(`SELECT id FROM venta WHERE "productoId" = $1`, [
        sinRegistro.id,
      ])
    )[0].id;
    await post(`/finanzas/conciliacion/${otra}`, { modo: 'sin_fecha' }).expect(
      201,
    );
    const conf = await finanzas.detalleVenta(otra);
    expect(conf.venta.conciliacionHistorica).toBe('confirmada_sin_fecha');
    expect(conf.finanzas.saldoPendiente).toBe(0);
    enero = await resumen('2045-01-01', '2045-01-31');
    expect(enero.resumen.cajaEntradas).toBe(3000); // sin fecha: no entra a ningún mes
    // Cobrada sin fecha: tampoco figura como saldo por cobrar en el análisis del periodo.
    const soloOtra = await resumen('2045-01-01', '2045-01-31', {
      productoId: sinRegistro.id,
    });
    expect(soloOtra.resumen.porCobrar).toBe(0);
    expect(soloOtra.cobros.ventasConSaldo).toHaveLength(0);
    expect(soloOtra.cobros.antiguedad['0-30'].monto).toBe(0);

    // Ingreso suelto ya registrado en Gastos: se vincula a la venta sin contarlo dos veces.
    const suelto = await crearProducto();
    const [vs] = await ds.query(
      `
      INSERT INTO venta ("productoId", "tipoCambio", "fechaVenta", "precioVenta", ganancia, "porcentajeGanancia", vendedor, "conciliacionHistorica")
      VALUES ($1, 3.75, '2045-02-10', 1800, 200, 12.5, 'Gonzalo', 'pendiente') RETURNING id`,
      [suelto.id],
    );
    const ingreso = await ds.getRepository(Gasto).save(
      ds.getRepository(Gasto).create({
        userId: adminId,
        concepto: 'ingreso',
        metodoPago: 'debito',
        tarjeta: 'bcp',
        moneda: 'PEN',
        monto: '1800.00',
        fecha: '2045-02-12',
        notas: 'venta mac',
      }),
    );
    const febAntes = await resumen('2045-02-01', '2045-02-28');
    expect(febAntes.resumen.cajaEntradas).toBe(1800); // ya contaba como "otros ingresos"
    const pendientes = (
      await http()
        .get('/finanzas/conciliacion')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)
    ).body;
    expect(
      pendientes.items
        .find((x: any) => x.id === vs.id)
        .sugerencias.map((x: any) => x.id),
    ).toContain(ingreso.id);
    // Registrar un cobro nuevo se bloquea mientras exista ese ingreso suelto (evita doble conteo).
    await post(`/finanzas/conciliacion/${vs.id}`, {
      modo: 'con_fecha',
      fecha: '2045-02-12',
    }).expect(400);
    await post(`/finanzas/conciliacion/${vs.id}`, {
      modo: 'vincular_ingresos',
      gastoIds: [ingreso.id],
    }).expect(201);
    const febDespues = await resumen('2045-02-01', '2045-02-28');
    expect(febDespues.resumen.cajaEntradas).toBe(1800); // misma caja, ahora como cobro de la venta
    expect(febDespues.flujo.porCategoria.cobro_cliente).toBe(1800);
    expect(febDespues.flujo.porCategoria.otros_ingresos).toBeUndefined();
    expect((await finanzas.detalleVenta(vs.id)).finanzas).toMatchObject({
      saldoPendiente: 0,
      estadoCobro: 'pagado',
    });
  });

  it('gastos: clasificación y costo directo vinculado a la venta sin duplicarlo', async () => {
    const venta = await crearVenta('2046-02-10', [
      { type: 'direct', amount: 3000 },
    ]);
    const gasto = await ds.getRepository(Gasto).save(
      ds.getRepository(Gasto).create({
        userId: adminId,
        concepto: 'transporte',
        metodoPago: 'debito',
        tarjeta: 'bcp',
        moneda: 'PEN',
        monto: '20.00',
        fecha: '2046-02-11',
      }),
    );
    await http()
      .patch(`/finanzas/gastos/${gasto.id}/clasificacion`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        clasificacionFinanciera: 'costo_directo',
        ventaVinculadaId: venta.id,
      })
      .expect(200);
    const feb = await resumen('2046-02-01', '2046-02-28');
    expect(feb.rentabilidad.totales).toMatchObject({
      gananciaComercial: 600,
      costosDirectos: 20,
      gananciaFinalVentas: 580,
      gastosOperativos: 0,
    });
    expect(feb.resumen.cajaSalidas).toBe(20); // la salida de caja se cuenta una vez, como gasto
  });
  it('programaciones concurrentes: un cargo por período, día ancla y banco conservados', async () => {
    const repo = ds.getRepository(ScheduledCharge);
    const svc = new SchedulesService(repo, ds.getRepository(Gasto));
    const sc = await svc.create(adminId, { metodoPago: 'debito', tipo: 'recurrente', concepto: 'internet',
      moneda: 'PEN', monto: 10, nextDate: '2026-01-31', tarjeta: 'bcp', anchorDay: 31 });
    await Promise.all([svc.processDue(adminId, '2026-03-31'), svc.processDue(adminId, '2026-03-31')]);
    await svc.processDue(adminId, '2026-03-31');
    const rows = await ds.getRepository(Gasto).find({ where: { scheduledChargeId: sc.id }, order: { fecha: 'ASC' } });
    expect(rows.map(g => g.fecha)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
    expect(rows.every(g => g.tarjeta === 'bcp' && g.tarjetaPago === null)).toBe(true);
    expect((await repo.findOneByOrFail({ id: sc.id })).nextDate).toBe('2026-04-30');
    await repo.update(sc.id, { active: false });
  });

  it('programación: si falla el avance de fecha también se revierte el gasto; cuotas terminan una sola vez', async () => {
    const repo = ds.getRepository(ScheduledCharge);
    const svc = new SchedulesService(repo, ds.getRepository(Gasto));
    const sc = await svc.create(adminId, { metodoPago: 'debito', tipo: 'cuotas', concepto: 'internet',
      moneda: 'PEN', monto: 10, nextDate: '2026-01-31', tarjeta: 'bcp', anchorDay: 31, remaining: 2 });
    await ds.query(`CREATE OR REPLACE FUNCTION test_schedule_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = ${sc.id} THEN RAISE EXCEPTION 'fallo avance'; END IF; RETURN NEW; END $$`);
    await ds.query('CREATE TRIGGER test_schedule_failure BEFORE UPDATE ON scheduled_charges FOR EACH ROW EXECUTE FUNCTION test_schedule_failure()');
    try {
      await expect(svc.processDue(adminId, '2026-03-31')).rejects.toThrow('fallo avance');
      expect(await ds.getRepository(Gasto).countBy({ scheduledChargeId: sc.id })).toBe(0);
      expect((await repo.findOneByOrFail({ id: sc.id })).nextDate).toBe('2026-01-31');
    } finally {
      await ds.query('DROP TRIGGER test_schedule_failure ON scheduled_charges');
      await ds.query('DROP FUNCTION test_schedule_failure()');
    }
    await svc.processDue(adminId, '2026-03-31');
    await svc.processDue(adminId, '2026-03-31');
    expect(await ds.getRepository(Gasto).countBy({ scheduledChargeId: sc.id })).toBe(2);
    expect(await repo.findOneByOrFail({ id: sc.id })).toMatchObject({ active: false, remaining: 0, nextDate: '2026-03-31' });
  });

  it('dos ventas legítimas iguales tienen claves, ingresos y unidades separados', async () => {
    const p = await crearProducto({ tipo: 'accesorios', stock: 2, costoTotal: 70 });
    const dto = { productoId: p.id, tipoCambio: 1, precioVenta: 80, cantidad: 1,
      fechaVenta: '2047-03-10', vendedor: 'Gonzalo', incomeBank: 'bcp' as const };
    const a = await ventas.create({ ...dto, operacionKey: key('legitima-a') });
    const b = await ventas.create({ ...dto, operacionKey: key('legitima-b') });
    expect(a.id).not.toBe(b.id);
    expect(await ds.getRepository(Gasto).countBy({ saleId: a.id })).toBe(1);
    expect(await ds.getRepository(Gasto).countBy({ saleId: b.id })).toBe(1);
    expect((await ds.getRepository(Producto).findOneByOrFail({ id: p.id })).stockActual).toBe(0);
  });

  it('las cinco migraciones nuevas suben, revierten y suben en un esquema separado', async () => {
    const schema = 'repair_migration_check';
    const migrationDs = new DataSource({ type: 'postgres', url: DB_URL, schema });
    await migrationDs.initialize();
    const qr = migrationDs.createQueryRunner();
    const migrations = [new IntegridadOperaciones1792537200000(), new DestinoIngresoVenta1792537300000(),
      new DevolucionesComerciales1792537400000(), new CostosPendientes1792537500000(), new ProgramacionesIdempotentes1792537600000()];
    await qr.query('CREATE SCHEMA repair_migration_check');
    try {
      await qr.query('CREATE TABLE repair_migration_check.producto (id serial PRIMARY KEY)');
      await qr.query('CREATE TABLE repair_migration_check.venta (id serial PRIMARY KEY, "productoId" integer REFERENCES repair_migration_check.producto(id) ON DELETE CASCADE)');
      await qr.query('CREATE TABLE repair_migration_check.gastos (id serial PRIMARY KEY)');
      await qr.query('CREATE TABLE repair_migration_check.scheduled_charges (id serial PRIMARY KEY)');
      for (const migration of migrations) await migration.up(qr);
      expect((await qr.getTable(schema + '.venta'))!.foreignKeys.find(f => f.columnNames[0] === 'productoId')!.onDelete).toBe('RESTRICT');
      expect(await qr.hasColumn(schema + '.gastos', 'scheduled_period')).toBe(true);
      for (const migration of [...migrations].reverse()) await migration.down(qr);
      expect(await qr.hasColumn(schema + '.venta', 'operacionHash')).toBe(false);
      expect(await qr.hasTable(schema + '.venta_devoluciones')).toBe(false);
      expect((await qr.getTable(schema + '.venta'))!.foreignKeys.find(f => f.columnNames[0] === 'productoId')!.onDelete).toBe('CASCADE');
      for (const migration of migrations) await migration.up(qr);
      expect(await qr.hasColumn(schema + '.venta', 'costoDocumento')).toBe(true);
    } finally {
      await qr.query('DROP SCHEMA repair_migration_check CASCADE');
      await qr.release(); await migrationDs.destroy();
    }
  });

  it('lotes del mismo accesorio elegidos en paralelo se bloquean en orden y ambas ventas válidas terminan', async () => {
    const a = await crearProducto({ tipo: 'accesorios', stock: 1, costoTotal: 70 });
    const b = await crearProducto({ tipo: 'accesorios', stock: 1, costoTotal: 70 });
    await ds.getRepository(Producto).update([a.id, b.id], { codigoInventario: a.id });
    const dto = { tipoCambio: 1, precioVenta: 80, cantidad: 1, fechaVenta: '2047-03-10', vendedor: 'Gonzalo' };
    const results = await Promise.all([
      ventas.create({ ...dto, productoId: a.id, loteInicialId: a.id, operacionKey: key('lote-a') }),
      ventas.create({ ...dto, productoId: b.id, loteInicialId: b.id, operacionKey: key('lote-b') }),
    ]);
    expect(results[0].id).not.toBe(results[1].id);
    expect((await ds.getRepository(Producto).findOneByOrFail({ id: a.id })).stockActual).toBe(0);
    expect((await ds.getRepository(Producto).findOneByOrFail({ id: b.id })).stockActual).toBe(0);
  });

});
