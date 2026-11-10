import { cambioSaldoHistorico, cambioVentaConSaldo } from './saldo-cambio';
describe('cambio histórico de saldo aplicado', () => {
  it('un origen conserva exactamente su cambio', () =>
    expect(
      cambioSaldoHistorico([{ cents: 50000, tipoCambio: '3.4000' }]).tipoCambio,
    ).toBe(3.4));
  it('combina solo los tramos usados conservando su equivalencia USD', () => {
    expect(
      cambioSaldoHistorico([
        { cents: 100000, tipoCambio: '3.4000' },
        { cents: 50000, tipoCambio: '3.6000' },
      ]),
    ).toEqual({ tipoCambio: 3.4642, equivalenteUsd: 433.006536 });
  });
  it('dos importes iguales en PEN respetan sus dos equivalencias históricas', () =>
    expect(
      cambioSaldoHistorico([
        { cents: 100000, tipoCambio: 3.4 },
        { cents: 100000, tipoCambio: 3.6 },
      ]).tipoCambio,
    ).toBe(3.4971));
  it('rechaza un saldo sin cambio histórico', () =>
    expect(() =>
      cambioSaldoHistorico([{ cents: 100, tipoCambio: null }]),
    ).toThrow('histórico'));
  it('conserva el histórico cuando el saldo supera al adicional', () => {
    expect(cambioVentaConSaldo([{ cents: 95000, tipoCambio: 3.4 }], 35000).tipoCambio).toBe(3.4);
  });
  it.each([[65000, 65000], [35000, 95000]])('combina cada cambio cuando el saldo es igual o menor: %s/%s', (saldo, extra) => {
    const r = cambioVentaConSaldo([{ cents: saldo, tipoCambio: 3.4 }], extra, 3.6);
    expect(r.tipoCambio).toBe(Number(((saldo + extra) / (saldo / 3.4 + extra / 3.6)).toFixed(4)));
    expect(() => cambioVentaConSaldo([{ cents: saldo, tipoCambio: 3.4 }], extra)).toThrow('adicional');
  });
});
