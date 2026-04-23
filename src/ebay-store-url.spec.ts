import { normalizeEbayStoreUrl } from './app.controller';

describe('normalizeEbayStoreUrl', () => {
  it('accepts a store url with trailing spaces', () => {
    expect(normalizeEbayStoreUrl('  https://www.ebay.com/str/vistapawn1   ')).toBe(
      'https://www.ebay.com/str/vistapawn1',
    );
  });

  it('extracts the ebay url from copied text without gluing extra words', () => {
    expect(normalizeEbayStoreUrl('Tienda https://www.ebay.com/str/vistapawn1   eBay')).toBe(
      'https://www.ebay.com/str/vistapawn1',
    );
  });

  it('accepts relative store paths', () => {
    expect(normalizeEbayStoreUrl('/usr/rcpawn_east   ')).toBe('https://www.ebay.com/usr/rcpawn_east');
  });
});
