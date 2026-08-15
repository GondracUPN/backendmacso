import { normalizeIncludedAccessories } from './accessory-rules';

describe('reglas de accesorios incluidos', () => {
  it('deja caja opcional y conserva una sola variante de cubo y cable', () => {
    expect(normalizeIncludedAccessories('macbook', [
      'Cubo original', 'Cubo fake', 'Cable fake', 'Cable original', 'Case',
    ])).toEqual(['Cubo fake', 'Cable original', 'Case']);
    expect(normalizeIncludedAccessories('macbook', [])).toEqual([]);
    expect(normalizeIncludedAccessories('macbook', ['Caja'])).toEqual(['Caja']);
  });

  it('permite un solo teclado para iPad', () => {
    expect(normalizeIncludedAccessories('ipad', [
      'Magic Keyboard', 'Keyboard Logitech', 'Keyboard otros',
    ])).toEqual(['Keyboard otros']);
  });

  it('limita accesorios según la generación de AirPods', () => {
    expect(normalizeIncludedAccessories('airpods', ['Cable', 'Case', 'Eartips'], 'AirPods Pro 3'))
      .toEqual(['Eartips']);
    expect(normalizeIncludedAccessories('airpods', ['Cable', 'Case', 'Eartips'], 'AirPods Pro 2'))
      .toEqual(['Cable', 'Case', 'Eartips']);
  });

  it('no mezcla accesorios incluidos con el stock general', () => {
    expect(normalizeIncludedAccessories('accesorios', ['Caja', 'Cable'])).toEqual([]);
  });

  it('admite cable y correa fake para Apple Watch sin duplicar variantes', () => {
    expect(normalizeIncludedAccessories('watch', ['Cable', 'Cable fake', 'Correa', 'Correa fake']))
      .toEqual(['Cable fake', 'Correa fake']);
  });

  it('normaliza el cargador y cable de iMac como fake', () => {
    expect(normalizeIncludedAccessories('imac', ['Caja', 'Cargador', 'Cable', 'Teclado', 'Mouse']))
      .toEqual(['Caja', 'Cargador fake', 'Cable fake', 'Teclado', 'Mouse']);
  });
});
