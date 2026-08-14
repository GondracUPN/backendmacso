import { normalizeIncludedAccessories } from './accessory-rules';

describe('reglas de accesorios incluidos', () => {
  it('fuerza caja y conserva una sola variante de cubo y cable', () => {
    expect(normalizeIncludedAccessories('macbook', [
      'Cubo original', 'Cubo fake', 'Cable fake', 'Cable original', 'Case',
    ])).toEqual(['Caja', 'Cubo fake', 'Cable original', 'Case']);
  });

  it('permite un solo teclado para iPad', () => {
    expect(normalizeIncludedAccessories('ipad', [
      'Magic Keyboard', 'Keyboard Logitech', 'Keyboard otros',
    ])).toEqual(['Caja', 'Keyboard otros']);
  });

  it('limita accesorios según la generación de AirPods', () => {
    expect(normalizeIncludedAccessories('airpods', ['Cable', 'Case', 'Eartips'], 'AirPods Pro 3'))
      .toEqual(['Caja', 'Eartips']);
    expect(normalizeIncludedAccessories('airpods', ['Cable', 'Case', 'Eartips'], 'AirPods Pro 2'))
      .toEqual(['Caja', 'Cable', 'Case', 'Eartips']);
  });

  it('no mezcla accesorios incluidos con el stock general', () => {
    expect(normalizeIncludedAccessories('accesorios', ['Caja', 'Cable'])).toEqual([]);
  });
});
