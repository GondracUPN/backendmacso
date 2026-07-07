import { extensionForPhoto } from './inventario.controller';

describe('extensionForPhoto', () => {
  it('uses the response content type when available', () => {
    expect(extensionForPhoto('https://example.com/portada', 'image/webp')).toBe('webp');
    expect(extensionForPhoto('https://example.com/portada', 'image/png')).toBe('png');
  });

  it('falls back to the url extension or jpg', () => {
    expect(extensionForPhoto('https://example.com/portada.heic?x=1', '')).toBe('heic');
    expect(extensionForPhoto('https://example.com/portada', '')).toBe('jpg');
  });
});
