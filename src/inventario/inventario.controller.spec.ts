import sharp = require('sharp');
import { watermarkInventoryPhoto } from './inventario.controller';

describe('watermarkInventoryPhoto', () => {
  it('centers the same watermark at a faint 20 percent opacity', async () => {
    const photo = await sharp({
      create: { width: 100, height: 100, channels: 3, background: '#ffffff' },
    }).jpeg().toBuffer();
    const watermark = await sharp({
      create: { width: 20, height: 20, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
    }).png().toBuffer();

    const result = await watermarkInventoryPhoto(photo, watermark);
    const { data, info } = await sharp(result).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => data[((y * info.width) + x) * info.channels];

    expect(pixel(5, 5)).toBeGreaterThan(245);
    expect(pixel(50, 50)).toBeGreaterThan(185);
    expect(pixel(50, 50)).toBeLessThan(225);
  });
});
