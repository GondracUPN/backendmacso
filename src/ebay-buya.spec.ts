import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import {
  containsExactInventoryCode, discoverBuyaStores, extractBuyaProduct, fetchBuyaProductPage,
  findBuyaEvidence, findBuyaProductOnEbay, normalizeBuyaOffset, validateBuyaProductUrl,
} from './ebay-buya';

const productUrl = 'https://www.buya.com/Item/Details/APPLE-MACBOOK-PRO/0405635a9f7543ddb670399dbd290460';
const productHtml = '<h1>Apple MacBook Pro</h1><ul><li>Model A2780</li><li>Inventory <b>#</b> <span>MAM026588</span></li></ul>';
const item = (itemId: string, seller = 'apple-pawn') => ({ itemId, seller, title: `Apple MacBook Pro ${itemId}`, itemWebUrl: `https://www.ebay.com/itm/${itemId}` });
const dependencies = () => ({
  search: jest.fn().mockResolvedValue({ items: [], nextOffset: 20, hasMore: false, rawCount: 0 }),
  detail: jest.fn().mockResolvedValue({ description: '' }),
  productPage: jest.fn().mockResolvedValue(productHtml),
});

describe('fichas y códigos Buya', () => {
  it('extrae el inventario real separado del código del modelo', () => {
    expect(extractBuyaProduct(productHtml, productUrl)).toEqual({ url: productUrl, title: 'Apple MacBook Pro', inventoryCode: 'MAM026588' });
    expect(extractBuyaProduct('<h1>Apple &amp; Mac</h1>Inventory&nbsp;#: ABC-123.4', productUrl).inventoryCode).toBe('ABC-123.4');
  });
  it('admite SKU estructurado de Product, no SKU de cualquier objeto', () => {
    const json = '<script type="application/ld+json">{"@graph":[{"@type":"Product","sku":"ABC-123"}]}</script>';
    expect(extractBuyaProduct(json, productUrl).inventoryCode).toBe('ABC-123');
    expect(() => extractBuyaProduct('<script type="application/ld+json">{"@type":"Organization","sku":"ABC-123"}</script>', productUrl)).toThrow(BadRequestException);
  });
  it('no sustituye un inventario ausente por el modelo o por el identificador de la URL', () => {
    expect(() => extractBuyaProduct('<h1>Apple A2780 M2</h1>Model A2780', productUrl)).toThrow('No se encontró el código');
  });
  it.each(['MAM0265880', 'XMAM026588', 'MAM026588-X', 'MAM026588.2', 'MAM026588/2', 'MAM-026588'])('descarta un código parecido: %s', (code) => {
    expect(containsExactInventoryCode(`Apple (${code})`, 'MAM026588')).toBe(false);
  });
  it('compara el código completo en títulos y descripciones HTML', () => {
    expect(containsExactInventoryCode('<p>Inventory # <b>mam026588</b>.</p>', 'MAM026588')).toBe(true);
    expect(containsExactInventoryCode('Apple A2780', 'MAM026588')).toBe(false);
  });
  it.each(['http://www.buya.com/Item/Details/a/123', 'https://buya.com.evil.test/Item/Details/a/123', 'https://www.buya.com@127.0.0.1/Item/Details/a/123', 'https://www.buya.com:444/Item/Details/a/123', 'https://www.buya.com/', 'https://localhost/Item/Details/a/123'])('rechaza enlaces ajenos a una ficha HTTPS de Buya: %s', (url) => {
    expect(() => validateBuyaProductUrl(url)).toThrow(BadRequestException);
  });
  it.each([-1, 1, 10000, 'NaN', '1.2'])('valida el cursor: %s', (offset) => expect(() => normalizeBuyaOffset(offset)).toThrow());
});

describe('descubrimiento desde las publicaciones recientes de eBay', () => {
  it('solo acepta referencias a Buya y conserva la publicación más reciente por vendedor', async () => {
    const deps = dependencies();
    deps.search.mockResolvedValue({ items: [item('1'), item('2', 'APPLE-PAWN'), item('3', 'bravo-only'), item('4', 'fake-buya')], nextOffset: 20, hasMore: true, rawCount: 20 });
    deps.detail.mockImplementation(async (listing) => ({ description: listing.itemId === '3' ? 'Powered by Bravo Store Systems' : listing.itemId === '4' ? '<a href="https://www.buya.com.evil.test/shop">Buya</a>' : '<a href="https://www.buya.com/Shop/test">Our Buya store</a>' }));
    const result = await discoverBuyaStores(undefined, deps);
    expect(deps.search).toHaveBeenCalledWith(expect.objectContaining({ query: '(Apple,MacBook,iPhone,iPad,iMac,AirPods) buya', searchInDescription: true, offset: 0, limit: 20, sort: 'newlyListed' }));
    expect(result.stores).toHaveLength(1);
    expect(result.stores[0].latestItem.itemId).toBe('1');
    expect(result.stores[0].buyaUrl).toBe('https://www.buya.com/Shop/test');
    expect(result).toMatchObject({ nextOffset: 20, hasMore: true, scanned: 20, failedChecks: 0 });
  });
  it('permite continuar y distingue fallos parciales de ausencia de referencias', async () => {
    const deps = dependencies();
    deps.search.mockResolvedValue({ items: [item('1'), item('2')], nextOffset: 40, hasMore: false, rawCount: 2 });
    deps.detail.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce({ description: 'Powered by Buya' });
    const result = await discoverBuyaStores('20', deps);
    expect(deps.search).toHaveBeenCalledWith(expect.objectContaining({ offset: 20 }));
    expect(result).toMatchObject({ failedChecks: 1, hasMore: true, nextPhase: 'recent', nextOffset: 0 });
    expect(result.stores).toHaveLength(1);
    deps.detail.mockRejectedValue(new Error('rate limited'));
    await expect(discoverBuyaStores(20, deps)).rejects.toThrow(ServiceUnavailableException);
  });
  it('no acepta dominios parecidos ni interpreta Bravo como Buya', () => {
    expect(findBuyaEvidence('Bravo Store Systems')).toBeNull();
    expect(findBuyaEvidence('https://buya.com.evil.test/')).toBeNull();
    expect(findBuyaEvidence('https://fakebuya.com/')).toBeNull();
  });

  it('amplía la búsqueda al agotar las menciones indexadas de Buya y permite seguir paginando', async () => {
    const deps = dependencies();
    deps.search.mockResolvedValueOnce({ items: [], nextOffset: 40, hasMore: false, rawCount: 1 })
      .mockResolvedValueOnce({ items: [item('new', 'new-store')], nextOffset: 20, hasMore: true, rawCount: 20 })
      .mockResolvedValueOnce({ items: [], nextOffset: 40, hasMore: false, rawCount: 0 });
    deps.detail.mockResolvedValue({ description: 'Powered by Buya' });
    const lastTargeted = await discoverBuyaStores(20, deps);
    expect(lastTargeted).toMatchObject({ phase: 'buya', nextPhase: 'recent', nextOffset: 0, hasMore: true });
    const expanded = await discoverBuyaStores(lastTargeted.nextOffset, deps, lastTargeted.nextPhase);
    expect(deps.search).toHaveBeenLastCalledWith(expect.objectContaining({ query: '(Apple,MacBook,iPhone,iPad,iMac,AirPods)', offset: 0, searchInDescription: false }));
    expect(expanded.stores[0].seller).toBe('new-store');
    expect(expanded).toMatchObject({ phase: 'recent', nextPhase: 'recent', nextOffset: 20, hasMore: true });
    expect(await discoverBuyaStores(20, deps, 'recent')).toMatchObject({ hasMore: false });
  });

  it('rechaza fases desconocidas antes de consultar eBay', async () => {
    const deps = dependencies();
    await expect(discoverBuyaStores(0, deps, 'unknown')).rejects.toThrow(BadRequestException);
    expect(deps.search).not.toHaveBeenCalled();
  });
});

describe('búsqueda del producto por código en eBay', () => {
  it('busca también en descripciones y devuelve solo códigos completos', async () => {
    const deps = dependencies();
    deps.search.mockResolvedValue({ items: [
      { ...item('1'), title: 'Apple MacBook (MAM026588)' },
      { ...item('2'), title: 'Apple MacBook (MAM026588-X)' },
      item('3'),
    ], nextOffset: 20, rawCount: 3, hasMore: false });
    deps.detail.mockImplementation(async (listing) => ({ description: listing.itemId === '3' ? '<p>Stock # MAM026588</p>' : 'Model A2780, Stock MAM026588-X' }));
    const result = await findBuyaProductOnEbay(productUrl, undefined, deps);
    expect(deps.search).toHaveBeenCalledWith(expect.objectContaining({ query: '"MAM026588"', searchInDescription: true }));
    expect(result.source.inventoryCode).toBe('MAM026588');
    expect(result.items.map((listing) => listing.itemId)).toEqual(['1', '3']);
    expect(result.items.map((listing) => listing.matchedIn)).toEqual(['title', 'description']);
  });
  it('no realiza una búsqueda si Buya no ofrece código de inventario', async () => {
    const deps = dependencies();
    deps.productPage.mockResolvedValue('<h1>Apple A2780</h1>');
    await expect(findBuyaProductOnEbay(productUrl, 0, deps)).rejects.toThrow(BadRequestException);
    expect(deps.search).not.toHaveBeenCalled();
  });
});

describe('lectura de Buya sin redirecciones arbitrarias', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });
  it('rechaza una redirección externa antes de hacer otra petición', async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response('', { status: 302, headers: { location: 'https://127.0.0.1/private' } }));
    global.fetch = fetchMock;
    await expect(fetchBuyaProductPage(productUrl)).rejects.toThrow(BadRequestException);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('lee una ficha tras redirección válida a otra región Buya', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(new Response('', { status: 302, headers: { location: productUrl.replace('www.', 'us.') } }))
      .mockResolvedValueOnce(new Response(productHtml));
    await expect(fetchBuyaProductPage(productUrl)).resolves.toBe(productHtml);
  });
  it('distingue una ficha inaccesible de un producto sin coincidencias', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response('unavailable', { status: 503 }));
    await expect(fetchBuyaProductPage(productUrl)).rejects.toThrow(ServiceUnavailableException);
  });
});
