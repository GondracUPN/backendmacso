import {
  finanzasVenta,
  margenLiberadoEnPeriodo,
  mulDiv,
  PagoCalc,
  penCents,
  resumenReembolso,
  resumenVentaRapida,
  resumirFlujo,
  VentaCalc,
} from './finanzas-calc';

const venta = (over: Partial<VentaCalc> = {}): VentaCalc => ({
  id: 1,
  fechaComercial: '2026-06-10',
  precioCents: 300000,
  gananciaCents: 60000,
  estadoComercial: 'entregada',
  ...over,
});
let seq = 0;
const directo = (
  monto: number,
  fecha: string | null,
  over: Partial<PagoCalc> = {},
): PagoCalc => ({
  id: ++seq,
  montoCents: monto * 100,
  fechaPago: fecha,
  requiereLiquidacion: false,
  comisionEstimadaCents: 0,
  anulado: false,
  verificado: true,
  eventos: [],
  ...over,
});
const tarjeta = (
  monto: number,
  fecha: string,
  eventos: PagoCalc['eventos'] = [],
  over: Partial<PagoCalc> = {},
): PagoCalc =>
  directo(monto, fecha, { requiereLiquidacion: true, eventos, ...over });
const meses = (v: VentaCalc, pagos: PagoCalc[]) => ({
  jun: margenLiberadoEnPeriodo(v, pagos, '2026-06-01', '2026-06-30'),
  jul: margenLiberadoEnPeriodo(v, pagos, '2026-07-01', '2026-07-31'),
  ago: margenLiberadoEnPeriodo(v, pagos, '2026-08-01', '2026-08-31'),
  sep: margenLiberadoEnPeriodo(v, pagos, '2026-09-01', '2026-09-30'),
});

describe('finanzas-calc', () => {
  it('1. venta pagada y disponible el mismo día libera todo el margen ese día', () => {
    const r = finanzasVenta(venta(), [directo(3000, '2026-06-10')], {
      asOf: '2026-06-10',
    });
    expect(r.estadoCobro).toBe('pagado');
    expect(r.saldoPendienteCents).toBe(0);
    expect(r.margenLiberadoCents).toBe(60000);
    expect(r.estadoLiquidacion).toBe('no_requiere');
  });

  it('2. venta de junio cobrada entre junio y septiembre (ejemplo obligatorio)', () => {
    const v = venta();
    const pagos = [
      directo(900, '2026-06-15'),
      directo(1200, '2026-08-05'),
      directo(900, '2026-09-20'),
    ];
    expect(meses(v, pagos)).toEqual({
      jun: 18000,
      jul: 0,
      ago: 24000,
      sep: 18000,
    });
    const final = finanzasVenta(v, pagos, { asOf: '2026-09-30' });
    expect(final.saldoPendienteCents).toBe(0);
    expect(final.margenLiberadoCents).toBe(final.gananciaFinalCents);
    expect(
      finanzasVenta(v, pagos, { asOf: '2026-07-31' }).saldoPendienteCents,
    ).toBe(210000);
  });

  it('3. un adelanto previo a la entrega no libera margen antes de la fecha comercial', () => {
    const v = venta({ fechaComercial: '2026-06-20' });
    const pagos = [
      directo(500, '2026-06-01', { esAdelanto: true }),
      directo(2500, '2026-06-20'),
    ];
    expect(
      finanzasVenta(v, pagos, { asOf: '2026-06-19' }).margenLiberadoCents,
    ).toBe(0);
    expect(
      finanzasVenta(v, pagos, { asOf: '2026-06-20' }).margenLiberadoCents,
    ).toBe(60000);
  });

  it('4-5. tarjeta pagada en junio y liquidada en agosto con comisión retenida', () => {
    const v = venta();
    const pagos = [
      tarjeta(3000, '2026-06-12', [
        {
          tipo: 'liquidacion',
          fecha: '2026-08-20',
          brutoCents: 300000,
          comisionCents: 12000,
          netoCents: 288000,
          cuentaId: 1,
        },
      ]),
    ];
    const junio = finanzasVenta(v, pagos, { asOf: '2026-06-30' });
    expect(junio.estadoCobro).toBe('pagado');
    expect(junio.saldoPendienteCents).toBe(0);
    // Al final de junio se conoce todo el historial, pero el dinero aún no estaba disponible.
    expect(junio.margenLiberadoCents).toBe(0);
    const sinLiquidar = finanzasVenta(v, [tarjeta(3000, '2026-06-12')], {
      asOf: '2026-06-30',
    });
    expect(sinLiquidar.pendienteLiquidacionCents).toBe(300000);
    expect(sinLiquidar.estadoLiquidacion).toBe('pendiente_liquidacion');
    const agosto = finanzasVenta(v, pagos, { asOf: '2026-08-31' });
    expect(agosto.comisionesRealesCents).toBe(12000);
    expect(agosto.gananciaFinalCents).toBe(48000);
    expect(agosto.netoEsperadoCents).toBe(288000);
    expect(agosto.margenLiberadoCents).toBe(48000);
    expect(agosto.estadoLiquidacion).toBe('liquidado');
    expect(meses(v, pagos)).toEqual({ jun: 0, jul: 0, ago: 48000, sep: 0 });
  });

  it('5b. comisión estimada antes de liquidar y liquidación parcial', () => {
    const v = venta();
    const pagos = [
      tarjeta(
        3000,
        '2026-06-12',
        [
          {
            tipo: 'liquidacion',
            fecha: '2026-07-01',
            brutoCents: 150000,
            comisionCents: 6000,
            netoCents: 144000,
            cuentaId: 1,
          },
        ],
        { comisionEstimadaCents: 12000 },
      ),
    ];
    const r = finanzasVenta(v, pagos);
    expect(r.estadoLiquidacion).toBe('parcialmente_liquidado');
    expect(r.comisionesCents).toBe(12000); // 6000 real + 6000 estimada del saldo retenido
    expect(r.margenLiberadoCents).toBe(24000); // 48000 × 144000 / 288000
  });

  it('6. cobro parcial deja saldo por cobrar', () => {
    const r = finanzasVenta(venta(), [directo(1000, '2026-06-10')]);
    expect(r.estadoCobro).toBe('parcialmente_pagado');
    expect(r.saldoPendienteCents).toBe(200000);
    expect(r.margenLiberadoCents).toBe(20000);
    expect(r.margenPendienteCents).toBe(40000);
  });

  it('7. venta cancelada con adelanto devuelto no genera ganancia', () => {
    const pagos = [
      directo(500, '2026-06-01', {
        esAdelanto: true,
        eventos: [
          {
            tipo: 'devolucion',
            fecha: '2026-06-05',
            brutoCents: 50000,
            comisionCents: 0,
            netoCents: 50000,
            cuentaId: 1,
          },
        ],
      }),
    ];
    const r = finanzasVenta(venta({ estadoComercial: 'cancelada' }), pagos);
    expect(r.gananciaComercialCents).toBe(0);
    expect(r.margenLiberadoCents).toBe(0);
    expect(r.cobradoClienteCents).toBe(0);
    expect(r.estadoCobro).toBe('devuelto');
  });

  it('pérdida comercial se distribuye como pérdida, nunca como ganancia', () => {
    const v = venta({ gananciaCents: -30000 });
    const pagos = [directo(1500, '2026-06-10'), directo(1500, '2026-07-10')];
    expect(meses(v, pagos).jun).toBe(-15000);
    expect(meses(v, pagos).jul).toBe(-15000);
  });

  it('11-12. venta rápida con costo desconocido queda con utilidad pendiente', () => {
    expect(
      resumenVentaRapida([
        { cantidad: 2, precioUnitario: 35, costoUnitario: 12.5 },
      ]),
    ).toEqual({
      ingresoCents: 7000,
      costoCents: 2500,
      gananciaCents: 4500,
      margen: 64.29,
    });
    const sinCosto = resumenVentaRapida([
      { cantidad: 1, precioUnitario: 40, costoUnitario: null },
    ]);
    expect(sinCosto.gananciaCents).toBeNull();
    const r = finanzasVenta(venta({ gananciaCents: null }), [
      directo(3000, '2026-06-10'),
    ]);
    expect(r.gananciaFinalCents).toBeNull();
    expect(r.margenLiberadoCents).toBeNull();
  });

  it('16. USD exige tipo de cambio trazable', () => {
    expect(penCents(100, 'USD', 3.75)).toBe(37500);
    expect(() => penCents(100, 'USD')).toThrow();
    expect(penCents('12.345', 'PEN')).toBe(1235);
  });

  it('17. contracargo posterior reduce el cobro y su reversión lo restituye', () => {
    const v = venta();
    const pagos = [
      tarjeta(3000, '2026-06-12', [
        {
          tipo: 'liquidacion',
          fecha: '2026-06-20',
          brutoCents: 300000,
          comisionCents: 0,
          netoCents: 300000,
          cuentaId: 1,
        },
        {
          tipo: 'contracargo',
          fecha: '2026-07-10',
          brutoCents: 300000,
          comisionCents: 0,
          netoCents: 300000,
          cuentaId: 1,
        },
      ]),
    ];
    const r = finanzasVenta(v, pagos);
    expect(r.estadoCobro).toBe('disputado');
    expect(r.cobradoClienteCents).toBe(0);
    expect(r.gananciaFinalCents).toBe(60000 - 300000);
    const revertido = [
      tarjeta(3000, '2026-06-12', [
        ...pagos[0].eventos,
        {
          tipo: 'reversion_contracargo',
          fecha: '2026-08-01',
          brutoCents: 300000,
          comisionCents: 0,
          netoCents: 300000,
          cuentaId: 1,
        },
      ]),
    ];
    const ok = finanzasVenta(v, revertido);
    expect(ok.estadoCobro).toBe('pagado');
    expect(ok.gananciaFinalCents).toBe(60000);
    expect(ok.margenLiberadoCents).toBe(60000);
  });

  it('devolución parcial reduce precio neto y utilidad sin duplicar el descuento', () => {
    const pagos = [
      directo(3000, '2026-06-10', {
        eventos: [
          {
            tipo: 'devolucion',
            fecha: '2026-06-15',
            brutoCents: 50000,
            comisionCents: 0,
            netoCents: 50000,
            cuentaId: 1,
          },
        ],
      }),
    ];
    const r = finanzasVenta(venta(), pagos);
    expect(r.gananciaFinalCents).toBe(10000);
    expect(r.netoEsperadoCents).toBe(250000);
    expect(r.margenLiberadoCents).toBe(10000);
  });

  it('18. pagos históricos sin verificar marcan la cifra como incierta', () => {
    const r = finanzasVenta(venta({ conciliacionHistorica: 'pendiente' }), [
      directo(3000, '2026-06-10', { verificado: false }),
    ]);
    expect(r.incierto).toBe(true);
    const sinHistoricos = finanzasVenta(
      venta({ conciliacionHistorica: 'pendiente' }),
      [directo(3000, '2026-06-10', { verificado: false })],
      { incluirNoVerificados: false },
    );
    expect(sinHistoricos.estadoCobro).toBe('conciliacion_pendiente');
  });

  it('14. transferencia interna no infla el flujo consolidado', () => {
    const cuentas = new Map([
      [1, { id: 1, codigo: 'bcp', tipo: 'banco', disponible: true }],
      [2, { id: 2, codigo: 'efectivo', tipo: 'efectivo', disponible: true }],
      [
        3,
        { id: 3, codigo: 'procesador', tipo: 'procesador', disponible: false },
      ],
    ]);
    const r = resumirFlujo(
      [
        {
          fecha: '2026-06-01',
          cuentaId: 1,
          cents: 100000,
          categoria: 'cobro_cliente',
          ref: 'p1',
        },
        {
          fecha: '2026-06-02',
          cuentaId: 1,
          cents: -40000,
          categoria: 'transferencia',
          ref: 't1',
        },
        {
          fecha: '2026-06-02',
          cuentaId: 2,
          cents: 40000,
          categoria: 'transferencia',
          ref: 't1',
        },
        {
          fecha: '2026-06-03',
          cuentaId: 3,
          cents: 300000,
          categoria: 'cobro_cliente',
          ref: 'p2',
        },
        {
          fecha: '2026-06-04',
          cuentaId: 2,
          cents: -10000,
          categoria: 'gasto',
          ref: 'g1',
        },
      ],
      cuentas,
    );
    expect(r.entradasCents).toBe(100000);
    expect(r.salidasCents).toBe(10000);
    expect(r.netoCents).toBe(90000);
    expect(r.transferenciasInternasCents).toBe(40000);
  });

  it('8-9. reembolso total no es ganancia y el parcial deja pérdida irrecuperable', () => {
    const total = resumenReembolso({
      estado: 'recibido',
      costoOriginalCents: 150000,
      gastosAdicionalesCents: 0,
      reclamadoCents: 150000,
      aprobadoCents: 150000,
      recibidoCents: 150000,
    });
    expect(total.resultadoCierreCents).toBe(0);
    expect(total.irrecuperableCents).toBe(0);
    const abierto = resumenReembolso({
      estado: 'reclamo_abierto',
      costoOriginalCents: 150000,
      gastosAdicionalesCents: 5000,
      reclamadoCents: 150000,
      aprobadoCents: null,
      recibidoCents: 0,
    });
    expect(abierto.porRecuperarCents).toBe(150000);
    expect(abierto.capitalEnReclamoCents).toBe(155000);
    const parcial = resumenReembolso({
      estado: 'perdida_definitiva',
      costoOriginalCents: 150000,
      gastosAdicionalesCents: 5000,
      reclamadoCents: 150000,
      aprobadoCents: 100000,
      recibidoCents: 100000,
    });
    expect(parcial.irrecuperableCents).toBe(55000);
    expect(parcial.porRecuperarCents).toBe(0);
  });

  it('19. la suma de márgenes mensuales cuadra con la utilidad final en cualquier reparto', () => {
    const v = venta({ precioCents: 333333, gananciaCents: 77777 });
    const pagos = [
      directo(1111.11, '2026-06-03'),
      directo(1111.11, '2026-07-03'),
      directo(1111.11, '2026-08-03'),
    ];
    const m = meses(v, pagos);
    expect((m.jun || 0) + (m.jul || 0) + (m.ago || 0) + (m.sep || 0)).toBe(
      77777,
    );
    expect(mulDiv(-5, 1, 2)).toBe(-3);
  });
});
