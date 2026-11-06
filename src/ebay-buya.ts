import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';

const BUYA_HOSTS = new Set(['buya.com', 'www.buya.com', 'us.buya.com', 'uk.buya.com']);
export const BUYA_SCAN_SIZE = 20;

const decodeHtml = (value: string) => value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (raw, entity: string) => {
  const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
  if (!entity.startsWith('#')) return named[entity.toLowerCase()] || raw;
  const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : raw;
});

export const buyaPlainText = (html: string) => decodeHtml(String(html || '')
  .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
  .replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

const parseBuyaUrl = (value: string) => {
  let url: URL;
  try { url = new URL(value); } catch { throw new BadRequestException('Pega un enlace válido de Buya.'); }
  if (url.protocol !== 'https:' || !BUYA_HOSTS.has(url.hostname.toLowerCase()) || url.port || url.username || url.password) {
    throw new BadRequestException('El enlace debe ser HTTPS y pertenecer a Buya.');
  }
  url.hash = '';
  return url;
};

export const validateBuyaProductUrl = (value: unknown) => {
  if (typeof value !== 'string' || value.length > 2000) throw new BadRequestException('Pega el enlace del producto de Buya.');
  const url = parseBuyaUrl(value.trim());
  if (!/^\/Item\/Details\/[^/]+\/[a-z0-9-]+\/?$/i.test(url.pathname)) {
    throw new BadRequestException('Usa el enlace de la ficha del producto de Buya (Item/Details).');
  }
  return url.toString();
};

// Validate every redirect, including redirects away from the original product.
// Never fetch a URL copied from the description of an arbitrary seller.
export const fetchBuyaProductPage = async (input: string): Promise<string> => {
  let url = validateBuyaProductUrl(input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    for (let redirects = 0; redirects < 4; redirects += 1) {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get('location');
        await res.body?.cancel();
        if (!location) break;
        url = validateBuyaProductUrl(new URL(location, url).toString());
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new ServiceUnavailableException('Buya no permitió leer esta ficha. Comprueba que el enlace abre el producto e inténtalo de nuevo.');
      }
      const reader = res.body?.getReader();
      if (!reader) break;
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) return Buffer.concat(chunks).toString('utf8');
        size += value.byteLength;
        if (size > 2_000_000) {
          await reader.cancel();
          throw new BadRequestException('La ficha de Buya supera el tamaño permitido.');
        }
        chunks.push(value);
      }
    }
    throw new BadRequestException('Buya no devolvió una ficha de producto válida.');
  } catch (error) {
    if (error instanceof BadRequestException || error instanceof ServiceUnavailableException) throw error;
    throw new ServiceUnavailableException('No se pudo conectar con Buya. Vuelve a intentarlo.');
  } finally { clearTimeout(timeout); }
};

export const extractBuyaProduct = (html: string, url: string) => {
  const text = buyaPlainText(html);
  const labelCode = text.match(/\bInventory\s*(?:#|number|no\.?|code)\s*:?\s*([a-z0-9]+(?:[._\/-][a-z0-9]+)*)/i)?.[1];
  let inventoryCode = labelCode || '';
  if (!inventoryCode) {
    for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const findProduct = (node: any): any => {
          if (Array.isArray(node)) return node.map(findProduct).find(Boolean);
          if (!node || typeof node !== 'object') return null;
          const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
          if (types.includes('Product') && typeof node.sku === 'string') return node;
          return findProduct(node['@graph']);
        };
        inventoryCode = findProduct(JSON.parse(match[1]))?.sku || '';
        if (inventoryCode) break;
      } catch { /* Other scripts are not product data. */ }
    }
  }
  inventoryCode = inventoryCode.trim();
  if (!/^[a-z0-9]+(?:[._\/-][a-z0-9]+)*$/i.test(inventoryCode) || inventoryCode.length < 3 || inventoryCode.length > 80) {
    throw new BadRequestException('No se encontró el código de inventario de Buya en esta ficha. No se usará el modelo de Apple como sustituto.');
  }
  const title = buyaPlainText(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '') || 'Producto de Buya';
  return { url, title, inventoryCode };
};

export const containsExactInventoryCode = (text: string, code: string) => {
  const tokens: string[] = buyaPlainText(text).toUpperCase().match(/[A-Z0-9]+(?:[._\/-][A-Z0-9]+)*/g) || [];
  return tokens.includes(code.toUpperCase());
};

export const findBuyaEvidence = (html: string) => {
  const decoded = decodeHtml(html);
  for (const match of decoded.matchAll(/(?:https?:)?\/\/(?:www\.|us\.|uk\.)?buya\.com(?:\/[^\s<>"']*)?/gi)) {
    // A suffix such as buya.com.evil.test must never be accepted.
    const end = decoded[match.index! + match[0].length];
    if (end && !/[\s<>"')]/.test(end)) continue;
    try {
      const url = parseBuyaUrl(match[0].replace(/^http:/i, 'https:').replace(/^\/\//, 'https://'));
      return { buyaUrl: url.toString(), evidence: 'Enlace a Buya en la publicación de eBay' };
    } catch { /* Ignore unrelated links. */ }
  }
  if (/\bpowered\s+by\s+buya\b/i.test(buyaPlainText(html))) {
    return { buyaUrl: 'https://www.buya.com/', evidence: 'La publicación indica Powered by Buya' };
  }
  return null;
};

export type BuyaEbayItem = {
  itemId: string; title: string; seller: string; itemWebUrl: string;
  storeName?: string; priceUSD?: number | null; imageUrl?: string; itemOriginDate?: string;
};
export type BuyaSearchParams = {
  query: string; offset: number; limit: number; sort: string; buyingOptions: string; searchInDescription?: boolean;
};
export type BuyaEbayDependencies = {
  search: (params: BuyaSearchParams) => Promise<{ items: BuyaEbayItem[]; nextOffset: number; hasMore: boolean; rawCount: number }>;
  detail: (item: BuyaEbayItem) => Promise<{ description?: string; shortDescription?: string; localizedAspects?: any[] }>;
  productPage?: (url: string) => Promise<string>;
};

export const normalizeBuyaOffset = (value: unknown) => {
  const offset = value == null || value === '' ? 0 : Number(value);
  if (!Number.isInteger(offset) || offset < 0 || offset >= 10000 || offset % BUYA_SCAN_SIZE !== 0) {
    throw new BadRequestException('La página de búsqueda no es válida.');
  }
  return offset;
};

const checkItems = async <T>(items: BuyaEbayItem[], check: (item: BuyaEbayItem) => Promise<T | null>) => {
  const matches: T[] = [];
  let failedChecks = 0;
  for (let index = 0; index < items.length; index += 4) {
    const results = await Promise.allSettled(items.slice(index, index + 4).map(check));
    for (const result of results) {
      if (result.status === 'rejected') failedChecks += 1;
      else if (result.value) matches.push(result.value);
    }
  }
  if (items.length && failedChecks === items.length) throw new ServiceUnavailableException('No se pudieron comprobar las publicaciones en eBay. Vuelve a intentarlo.');
  return { matches, failedChecks };
};

const pageMetadata = (page: { nextOffset: number; hasMore: boolean; rawCount: number }, offset: number) => ({
  offset, nextOffset: page.nextOffset, hasMore: page.hasMore && page.nextOffset < 10000, scanned: page.rawCount,
});

export const discoverBuyaStores = async (rawOffset: unknown, deps: BuyaEbayDependencies, rawPhase: unknown = 'buya') => {
  const offset = normalizeBuyaOffset(rawOffset);
  if (rawPhase !== 'buya' && rawPhase !== 'recent') throw new BadRequestException('La fase de búsqueda no es válida.');
  const phase = rawPhase;
  const page = await deps.search({ query: `(Apple,MacBook,iPhone,iPad,iMac,AirPods)${phase === 'buya' ? ' buya' : ''}`, offset, limit: BUYA_SCAN_SIZE,
    sort: 'newlyListed', buyingOptions: 'FIXED_PRICE|AUCTION|BEST_OFFER', searchInDescription: phase === 'buya' });
  const appleItems = page.items.filter((item) => /\b(?:apple|macbook|iphone|ipad|imac|airpods)\b/i.test(item.title));
  const checked = await checkItems(appleItems, async (item) => {
    const detail = await deps.detail(item);
    const evidence = findBuyaEvidence(`${detail.description || ''} ${detail.shortDescription || ''}`);
    return evidence && item.seller ? { seller: item.seller, storeName: item.storeName || item.seller,
      ebayUrl: `https://www.ebay.com/sch/i.html?_ssn=${encodeURIComponent(item.seller)}`,
      ...evidence, latestItem: item } : null;
  });
  const stores = checked.matches.filter((store, index, all) => all.findIndex((other) => other.seller.toLowerCase() === store.seller.toLowerCase()) === index);
  const metadata = pageMetadata(page, offset);
  const expandSearch = phase === 'buya' && !metadata.hasMore;
  return { ...metadata, phase, nextPhase: expandSearch ? 'recent' : phase,
    nextOffset: expandSearch ? 0 : metadata.nextOffset, hasMore: expandSearch || metadata.hasMore,
    checked: appleItems.length, failedChecks: checked.failedChecks, stores };
};

export const findBuyaProductOnEbay = async (rawUrl: unknown, rawOffset: unknown, deps: BuyaEbayDependencies) => {
  const url = validateBuyaProductUrl(rawUrl);
  const offset = normalizeBuyaOffset(rawOffset);
  const source = extractBuyaProduct(await (deps.productPage || fetchBuyaProductPage)(url), url);
  const page = await deps.search({ query: `"${source.inventoryCode}"`, offset, limit: BUYA_SCAN_SIZE,
    sort: 'newlyListed', buyingOptions: 'FIXED_PRICE|AUCTION|BEST_OFFER', searchInDescription: true });
  const checked = await checkItems(page.items, async (item) => {
    if (containsExactInventoryCode(item.title, source.inventoryCode)) return { ...item, matchedIn: 'title' };
    const detail = await deps.detail(item);
    const text = [detail.description, detail.shortDescription,
      ...(detail.localizedAspects || []).map((aspect) => `${aspect.name}: ${aspect.value}`)].filter(Boolean).join(' ');
    return containsExactInventoryCode(text, source.inventoryCode) ? { ...item, matchedIn: 'description' } : null;
  });
  return { source, ...pageMetadata(page, offset), failedChecks: checked.failedChecks, items: checked.matches };
};
