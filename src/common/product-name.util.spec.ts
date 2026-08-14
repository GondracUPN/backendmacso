import { formatAppleWatchModel, formatAppleWatchName } from './product-name.util';

describe('Apple Watch product names', () => {
  it.each([
    [{ gama: 'SE', generacion: '3', tamano: '44 mm' }, 'Apple Watch SE 3 44 mm'],
    [{ gama: 'Ultra', generacion: '2', tamano: '49' }, 'Apple Watch Ultra 2 49 mm'],
    [{ gama: 'Series', generacion: '11', tamano: '46 mm' }, 'Apple Watch Series 11 46 mm'],
    [{ gama: 'Series', generacion: 'Series 10', tamano: '46 mm' }, 'Apple Watch Series 10 46 mm'],
    [{ gama: 'Ultra 2', generacion: '2', tamano: '49 mm' }, 'Apple Watch Ultra 2 49 mm'],
  ])('formats the full model, generation and size', (detail, expected) => {
    expect(formatAppleWatchName(detail)).toBe(expected);
  });

  it('returns a complete model for analytics grouping', () => {
    expect(formatAppleWatchModel({ gama: 'Ultra', generacion: '3' })).toBe('Ultra 3');
  });
});
