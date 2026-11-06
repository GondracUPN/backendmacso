import { cambioSaldoHistorico } from './saldo-cambio';
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
});
