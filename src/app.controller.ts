import { BadRequestException, Body, Controller, Get, NotFoundException, Post, Query, Res } from '@nestjs/common';
import { AppService } from './app.service';
import { AnalyticsService } from './analytics/analytics.service';
import type { Response } from 'express';
import * as archiver from 'archiver';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const extractLegacyIdFromHtml = (html: string): string | null => {
  const fromUrl =
    html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i)?.[1] ||
    html.match(/<meta\s+property="og:url"\s+content="([^"]+)"/i)?.[1];
  if (fromUrl) {
    const m = fromUrl.match(/\/itm\/(?:[^/]+\/)?(\d+)/);
    if (m) return m[1];
  }
  const m = html.match(/"itemId"\s*:\s*"(\d+)"/i);
  return m ? m[1] : null;
};

const parseAmazonPrice = (raw: string): number | null => {
  const cleaned = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  const match = cleaned.match(/(\d[\d.,]*)/);
  if (!match) return null;
  const numRaw = match[1];
  let normalized = numRaw;
  if (numRaw.includes('.') && numRaw.includes(',')) {
    normalized = numRaw.replace(/,/g, '');
  } else if (!numRaw.includes('.') && numRaw.includes(',')) {
    normalized = numRaw.replace(',', '.');
  }
  const val = Number(normalized);
  return Number.isFinite(val) ? val : null;
};

const parseAmazonHtml = (html: string) => {
  const title =
    html.match(/<span[^>]+id="productTitle"[^>]*>([^<]+)<\/span>/i)?.[1]?.trim() ||
    html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i)?.[1]?.trim() ||
    null;
  const priceToPay =
    html.match(/priceToPay[^}]*?"value"\s*:\s*([0-9.]+)/i)?.[1] ||
    html.match(/"priceAmount"\s*:\s*"([^"]+)"/i)?.[1] ||
    null;
  const priceOffscreen =
    html.match(/class="a-offscreen"[^>]*>\s*([$€£]?\s*[\d.,]+)/i)?.[1] ||
    null;
  const priceWhole = html.match(/<span[^>]+class="a-price-whole"[^>]*>([^<]+)<\/span>/i)?.[1] || '';
  const priceFrac = html.match(/<span[^>]+class="a-price-fraction"[^>]*>([^<]+)<\/span>/i)?.[1] || '';
  const priceCombined = priceWhole ? `${priceWhole}.${priceFrac || '00'}` : '';
  const priceRaw =
    priceToPay ||
    html.match(/<span[^>]+id="priceblock_ourprice"[^>]*>([^<]+)<\/span>/i)?.[1] ||
    html.match(/<span[^>]+id="priceblock_dealprice"[^>]*>([^<]+)<\/span>/i)?.[1] ||
    html.match(/<span[^>]+id="priceblock_saleprice"[^>]*>([^<]+)<\/span>/i)?.[1] ||
    priceCombined ||
    priceOffscreen ||
    html.match(/"price"\s*:\s*"([^"]+)"/i)?.[1] ||
    html.match(/<meta\s+property="product:price:amount"\s+content="([^"]+)"/i)?.[1] ||
    null;
  const priceUSD = parseAmazonPrice(priceRaw || '');
  return { title, priceUSD };
};

const isAmazonHost = (host: string) => {
  const h = host.toLowerCase();
  return h.includes('amazon.');
};

const extractAmazonAsin = (url: string): string | null => {
  const m =
    url.match(/\/dp\/([A-Z0-9]{10})/i) ||
    url.match(/\/gp\/product\/([A-Z0-9]{10})/i);
  return m ? m[1].toUpperCase() : null;
};

type TitleAttrs = {
  tipo?: string;
  gama?: string;
  proc?: string;
  pantalla?: string;
  ram?: string;
  ssd?: string;
};

const normalizeText = (val: string) =>
  val
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeKey = (val: string) => normalizeText(val).replace(/[^a-z0-9]/g, '');

const parseTitleAttrs = (title: string): TitleAttrs => {
  const raw = title || '';
  const t = normalizeText(raw);
  const attrs: TitleAttrs = {};

  if (t.includes('macbook')) attrs.tipo = 'macbook';
  else if (t.includes('iphone')) attrs.tipo = 'iphone';
  else if (t.includes('ipad')) attrs.tipo = 'ipad';
  else if (t.includes('watch')) attrs.tipo = 'watch';

  if (/\bpro max\b/.test(t)) attrs.gama = 'Pro Max';
  else if (/\bpro\b/.test(t)) attrs.gama = 'Pro';
  else if (/\bair\b/.test(t)) attrs.gama = 'Air';
  else if (/\bmini\b/.test(t)) attrs.gama = 'Mini';
  else if (/\bplus\b/.test(t)) attrs.gama = 'Plus';
  else if (/\bultra\b/.test(t)) attrs.gama = 'Ultra';

  const procMatch =
    t.match(/\b(m[1-5])\s*(pro|max|ultra)?\b/) ||
    t.match(/\b(i[3579])\b/) ||
    t.match(/\b(ryzen\s*\d)\b/);
  if (procMatch) {
    const base = procMatch[1].toUpperCase();
    const suffix = procMatch[2] ? ` ${procMatch[2].toUpperCase()}` : '';
    attrs.proc = `${base}${suffix}`.trim();
  }
  else if (t.includes('intel')) attrs.proc = 'Intel';

  const screenMatch = t.match(/\b(10\.2|10\.9|11|12\.9|13\.3|13\.5|13\.6|13|14|15\.3|15|16)\b/);
  if (screenMatch) {
    const rawSize = Number(screenMatch[1]);
    if (!Number.isNaN(rawSize)) {
      if (rawSize >= 13 && rawSize < 14) attrs.pantalla = '13';
      else if (rawSize >= 14 && rawSize < 15) attrs.pantalla = '14';
      else if (rawSize >= 15 && rawSize < 16) attrs.pantalla = '15';
      else if (rawSize >= 16 && rawSize < 17) attrs.pantalla = '16';
      else if (rawSize === 10.2) attrs.pantalla = '10.2';
      else if (rawSize === 10.9) attrs.pantalla = '10.9';
      else if (rawSize === 12.9) attrs.pantalla = '12.9';
      else if (rawSize === 11) attrs.pantalla = '11';
      else attrs.pantalla = String(screenMatch[1]);
    }
  }

  const ramByLabel =
    raw.match(/(\d+)\s*gb[^a-z0-9]{0,6}ram/i) || raw.match(/ram[^a-z0-9]{0,6}(\d+)\s*gb/i);
  if (ramByLabel) {
    const val = Number(ramByLabel[1]);
    if (val >= 8 && val <= 36) attrs.ram = `${val} GB`;
  }

  const storageMatch = raw.match(/(\d+)\s*(gb|tb)[^a-z0-9]{0,8}(ssd|storage|rom)/i);
  if (storageMatch) {
    const val = Number(storageMatch[1]);
    if (storageMatch[2].toLowerCase() === 'tb') {
      if (val <= 1) attrs.ssd = `${val} TB`;
    } else if (val >= 64 && val <= 1024) {
      attrs.ssd = `${val} GB`;
    }
  }

  const ramStoragePair = raw.match(/(\d+)\s*gb\s*[\/\-]\s*(\d+)\s*(gb|tb)/i);
  if (ramStoragePair) {
    const ramVal = Number(ramStoragePair[1]);
    const storVal = Number(ramStoragePair[2]);
    const storUnit = ramStoragePair[3].toUpperCase();
    if (!attrs.ram && ramVal >= 8 && ramVal <= 36) attrs.ram = `${ramVal} GB`;
    if (!attrs.ssd) {
      if (storUnit === 'TB' && storVal <= 1) attrs.ssd = `${storVal} TB`;
      if (storUnit === 'GB' && storVal >= 64 && storVal <= 1024) attrs.ssd = `${storVal} GB`;
    }
  }

  const allGb = Array.from(raw.matchAll(/(\d+)\s*(gb|tb)/gi)).map((m) => ({
    val: `${m[1]} ${m[2].toUpperCase()}`,
    idx: m.index ?? -1,
    num: Number(m[1]),
    unit: m[2].toUpperCase(),
  }));
  if (allGb.length) {
    const withSsd = allGb.find((m) => /ssd|storage|rom/i.test(raw.slice(m.idx, m.idx + 12)));
    if (withSsd && !attrs.ssd) {
      if (withSsd.unit === 'TB' && withSsd.num <= 1) attrs.ssd = `${withSsd.num} TB`;
      if (withSsd.unit === 'GB' && withSsd.num >= 64 && withSsd.num <= 1024) attrs.ssd = `${withSsd.num} GB`;
    }
    if (!attrs.ram) {
      const ramCandidate = allGb.find((m) => m.unit === 'GB' && m.num >= 8 && m.num <= 36);
      if (ramCandidate) attrs.ram = `${ramCandidate.num} GB`;
    }
    if (!attrs.ssd) {
      const storageCandidate = allGb
        .filter((m) => (m.unit === 'GB' && m.num >= 64 && m.num <= 1024) || (m.unit === 'TB' && m.num <= 1))
        .sort((a, b) => b.num - a.num)[0];
      if (storageCandidate) {
        attrs.ssd = `${storageCandidate.num} ${storageCandidate.unit}`;
      }
    }
  }

  return attrs;
};

const scoreGroupMatch = (group: any, attrs: TitleAttrs) => {
  if (attrs.tipo && group?.tipo && normalizeKey(group?.tipo || '') !== normalizeKey(attrs.tipo)) return 0;
  let score = 0;
  if (attrs.tipo) score += 3;
  if (attrs.gama && normalizeKey(group?.gama || '') === normalizeKey(attrs.gama)) score += 3;
  if (attrs.proc && normalizeKey(group?.proc || '').includes(normalizeKey(attrs.proc))) score += 2;
  if (attrs.pantalla && String(group?.pantalla || '') === String(attrs.pantalla)) score += 2;

  const normArr = (arr: string[]) => arr.map((x) => normalizeKey(String(x)));
  if (attrs.ram) {
    const ramSet = normArr(Array.isArray(group?.ramDistinct) ? group.ramDistinct : []);
    if (ramSet.includes(normalizeKey(attrs.ram))) score += 1;
  }
  if (attrs.ssd) {
    const ssdSet = normArr(Array.isArray(group?.ssdDistinct) ? group.ssdDistinct : []);
    if (ssdSet.includes(normalizeKey(attrs.ssd))) score += 1;
  }

  return score;
};

const getEbayApiBase = () => {
  const env = String(process.env.EBAY_ENV || 'PROD').toUpperCase();
  return env === 'SANDBOX' ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
};

let ebayTokenCache: { token: string; expiresAt: number } | null = null;
const TM_STORAGE_DIR = join(process.cwd(), 'storage', 'tm');
const TM_TEMPLATE_FILE = join(TM_STORAGE_DIR, 'ebay-template.html');
const TM_TEMPLATE_META_FILE = join(TM_STORAGE_DIR, 'ebay-template.meta.json');

const normalizeEnvToken = (val: string) =>
  val.trim().replace(/^"+|"+$/g, '').replace(/\s+/g, '');

const requestEbayToken = async (params: {
  grantType: 'refresh_token' | 'client_credentials';
  refreshToken?: string;
  scope?: string;
}): Promise<{ access_token: string; expires_in: number }> => {
  const clientId = normalizeEnvToken(process.env.EBAY_CLIENT_ID || '');
  const clientSecret = normalizeEnvToken(process.env.EBAY_CLIENT_SECRET || '');
  if (!clientId || !clientSecret) {
    throw new BadRequestException('Faltan credenciales eBay (client id/secret)');
  }
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: params.grantType,
  });
  if (params.grantType === 'refresh_token') {
    body.set('refresh_token', params.refreshToken || '');
  }
  const scopeVal = params.scope || '';
  if (scopeVal) {
    body.set('scope', scopeVal);
  }
  const res = await fetch(`${getEbayApiBase()}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.log('[eBay] token error', { status: res.status, body: errText.slice(0, 400) });
    throw new BadRequestException(`No se pudo obtener token eBay (${res.status})`);
  }
  return (await res.json()) as { access_token: string; expires_in: number };
};

const getEbayAccessToken = async (): Promise<string> => {
  const now = Date.now();
  if (ebayTokenCache && now < ebayTokenCache.expiresAt - 60_000) {
    return ebayTokenCache.token;
  }

  const clientId = normalizeEnvToken(process.env.EBAY_CLIENT_ID || '');
  const clientSecret = normalizeEnvToken(process.env.EBAY_CLIENT_SECRET || '');
  const refreshToken = normalizeEnvToken(process.env.EBAY_REFRESH_TOKEN || '');
  const scopeEnv = normalizeEnvToken(process.env.EBAY_SCOPE || '');
  const defaultScope = scopeEnv || 'https://api.ebay.com/oauth/api_scope';

  if (clientId && clientSecret && refreshToken) {
    try {
      const data = await requestEbayToken({
        grantType: 'refresh_token',
        refreshToken,
        scope: scopeEnv || undefined,
      });
      ebayTokenCache = {
        token: data.access_token,
        expiresAt: now + Number(data.expires_in || 0) * 1000,
      };
      return ebayTokenCache.token;
    } catch (err) {
      console.log('[eBay] refresh token failed, trying client_credentials', {
        reason: (err as any)?.message || err,
      });
    }
  }

  if (clientId && clientSecret) {
    const data = await requestEbayToken({
      grantType: 'client_credentials',
      scope: defaultScope,
    });
    ebayTokenCache = {
      token: data.access_token,
      expiresAt: now + Number(data.expires_in || 0) * 1000,
    };
    return ebayTokenCache.token;
  }

  const fallback = normalizeEnvToken(process.env.EBAY_ACCESS_TOKEN || '');
  if (!fallback) {
    throw new BadRequestException('Faltan credenciales eBay (refresh o access token)');
  }
  console.log('[eBay] access token len', { len: fallback.length, tail: fallback.slice(-6) });
  return fallback;
};

const parsePriceValue = (obj: any): number | null => {
  const val = Number(obj?.value ?? obj);
  return Number.isFinite(val) ? val : null;
};

const fetchEbayItem = async (legacyId: string, zip: string) => {
  const token = await getEbayAccessToken();
  const base = getEbayApiBase();
  console.log('[eBay] api base', { base });
  const url = `${base}/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=${legacyId}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      'X-EBAY-C-ENDUSERCTX': `contextualLocation=country=US,zip=${zip}`,
    },
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.log('[eBay] browse status', { status: res.status, body: errText.slice(0, 400) });
    throw new BadRequestException(`No se pudo obtener item (${res.status})`);
  }
  return res.json();
};

const resolveLegacyId = async (rawUrl: string): Promise<string | null> => {
  try {
    let url = new URL(rawUrl);
    const directMatch = url.toString().match(/\/itm\/(?:[^/]+\/)?(\d+)/);
    if (directMatch) return directMatch[1];

    const res = await fetch(url.toString(), {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    });
    if (res.url) {
      url = new URL(res.url);
    }
    const m = url.toString().match(/\/itm\/(?:[^/]+\/)?(\d+)/);
    if (m) return m[1];

    const html = await res.text().catch(() => '');
    const fromHtml = extractLegacyIdFromHtml(html);
    if (fromHtml) return fromHtml;
  } catch {
    // ignore
  }
  return null;
};

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly analyticsService: AnalyticsService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('tm/ebay-template')
  async getTmEbayTemplate(@Res() res: Response) {
    try {
      const [html, fileStats] = await Promise.all([
        readFile(TM_TEMPLATE_FILE, 'utf8'),
        stat(TM_TEMPLATE_FILE),
      ]);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.setHeader('X-TM-Template-Updated-At', fileStats.mtime.toISOString());
      res.send(html);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw new NotFoundException('Aun no hay plantilla publicada');
      }
      throw e;
    }
  }

  @Get('tm/ebay-template/meta')
  async getTmEbayTemplateMeta() {
    try {
      const raw = await readFile(TM_TEMPLATE_META_FILE, 'utf8');
      const meta = JSON.parse(raw);
      return { ok: true, ...meta };
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw new NotFoundException('Aun no hay metadatos de plantilla');
      }
      throw e;
    }
  }

  @Post('tm/ebay-template')
  async saveTmEbayTemplate(@Body('html') html: string, @Body('source') source?: string) {
    const normalizedHtml = String(html || '').trim();
    if (!normalizedHtml) {
      throw new BadRequestException('El campo "html" es obligatorio');
    }
    if (normalizedHtml.length > 500_000) {
      throw new BadRequestException('El HTML excede el tamano maximo permitido');
    }

    const updatedAt = new Date().toISOString();
    const meta = {
      updatedAt,
      size: normalizedHtml.length,
      source: String(source || 'unknown'),
    };

    await mkdir(TM_STORAGE_DIR, { recursive: true });
    await Promise.all([
      writeFile(TM_TEMPLATE_FILE, normalizedHtml, 'utf8'),
      writeFile(TM_TEMPLATE_META_FILE, JSON.stringify(meta, null, 2), 'utf8'),
    ]);

    return { ok: true, ...meta };
  }

  @Get('utils/ebay')
  async parseEbay(@Query('url') url: string) {
    console.log('[eBay] parseEbay start', { url });
    if (!url) throw new BadRequestException('URL requerida');
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BadRequestException('URL invalida');
    }
    const host = (parsed.hostname || '').toLowerCase();
    if (!host.includes('ebay.') && !host.includes('ebay.us') && !isAmazonHost(host)) {
      throw new BadRequestException('Solo se permite URL de eBay o Amazon');
    }
    if (isAmazonHost(host)) {
      const headers = {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9,es;q=0.8',
      };
      const res = await fetch(parsed.toString(), {
        method: 'GET',
        redirect: 'follow',
        headers,
      });
      if (!res.ok) {
        throw new BadRequestException('No se pudo obtener pagina de Amazon');
      }
      const html = await res.text().catch(() => '');
      let { title, priceUSD } = parseAmazonHtml(html);
      if (!priceUSD) {
        const asin = extractAmazonAsin(parsed.toString());
        if (asin) {
          const altUrl = `https://www.amazon.com/dp/${asin}?th=1&psc=1&language=en_US`;
          const altRes = await fetch(altUrl, { method: 'GET', redirect: 'follow', headers });
          if (altRes.ok) {
            const altHtml = await altRes.text().catch(() => '');
            const altParsed = parseAmazonHtml(altHtml);
            title = title || altParsed.title;
            priceUSD = altParsed.priceUSD || priceUSD;
          }
        }
      }
      return {
        url: parsed.toString(),
        title,
        titleParsed: null,
        priceUSD,
        shippingUSD: null,
        condition: 'new',
        source: 'amazon',
        images: [],
        analysisMatches: [],
      };
    }
    const legacyId = await resolveLegacyId(parsed.toString());
    if (!legacyId) {
      throw new BadRequestException('No se pudo obtener el itemId desde la URL');
    }
    console.log('[eBay] legacyId', { legacyId });
    try {
      const item = await fetchEbayItem(legacyId, '33192');
      const shippingUSD = parsePriceValue(item?.shippingOptions?.[0]?.shippingCost);
      const priceUSD = parsePriceValue(item?.price);
      const condition = item?.condition || null;
      const images = [
        item?.image?.imageUrl,
        ...(Array.isArray(item?.additionalImages) ? item.additionalImages.map((i: any) => i?.imageUrl) : []),
      ].filter(Boolean);
      const title = item?.title || null;
      const parsedTitleAttrs = title ? parseTitleAttrs(title) : null;
      let analysisMatches: any[] = [];
      if (title) {
        try {
          const summary = await this.analyticsService.summaryCached({});
          const groups = Array.isArray(summary?.productGroups) ? summary.productGroups : [];
          const attrs = parsedTitleAttrs || {};
          analysisMatches = groups
            .map((g: any) => ({
              label: g?.label || '',
              tipo: g?.tipo || '',
              gama: g?.gama || '',
              proc: g?.proc || '',
              pantalla: g?.pantalla || '',
              ramDistinct: g?.ramDistinct || [],
              ssdDistinct: g?.ssdDistinct || [],
              ventas: g?.ventas || null,
              compras: g?.compras || null,
              score: scoreGroupMatch(g, attrs),
            }))
            .filter((g: any) => g.score > 0)
            .sort((a: any, b: any) => b.score - a.score)
            .slice(0, 5);
        } catch (err) {
          console.log('[eBay] analysis match error', (err as any)?.message || err);
        }
      }
      console.log('[eBay] browse summary', { priceUSD, images: images.length, shippingUSD });
      return {
        url: parsed.toString(),
        title,
        titleParsed: parsedTitleAttrs,
        priceUSD,
        shippingUSD,
        condition,
        source: 'ebay',
        images,
        analysisMatches,
      };
    } catch (err) {
      console.log('[eBay] browse error', (err as any)?.message || err);
      throw new BadRequestException('No se pudo obtener item desde eBay');
    }
  }

  @Get('utils/ebay/image')
  async proxyEbayImage(
    @Query('url') url: string,
    @Query('name') name: string,
    @Res() res: Response,
  ) {
    if (!url) throw new BadRequestException('URL requerida');
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BadRequestException('URL invalida');
    }
    const host = (parsed.hostname || '').toLowerCase();
    if (!host.includes('ebayimg.com')) {
      throw new BadRequestException('Solo imagenes de eBay');
    }
    const imgRes = await fetch(parsed.toString(), {
      headers: { 'User-Agent': UA },
    });
    if (!imgRes.ok) {
      throw new BadRequestException(`No se pudo acceder a la imagen (${imgRes.status})`);
    }
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const ct = imgRes.headers.get('content-type') || 'image/jpeg';
    const safeName = String(name || 'foto')
      .replace(/[^a-z0-9._-]+/gi, '_')
      .replace(/_+/g, '_')
      .slice(0, 140);
    const ext = ct.includes('png') ? 'png' : 'jpg';
    res.setHeader('Content-Type', ct);
    res.setHeader('Content-Disposition', `attachment; filename="${safeName || 'foto'}.${ext}"`);
    res.send(buf);
  }

  @Post('utils/ebay/images-zip')
  async downloadEbayImagesZip(@Body('urls') urls: string[], @Res() res: Response) {
    if (!Array.isArray(urls) || urls.length === 0) {
      throw new BadRequestException('Lista de URLs requerida');
    }
    if (urls.length > 30) {
      throw new BadRequestException('Maximo 30 imagenes');
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="ebay-fotos.zip"');

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => {
      throw new BadRequestException(`Error al crear ZIP: ${String(err?.message || err)}`);
    });
    archive.pipe(res);

    let added = 0;
    for (let i = 0; i < urls.length; i += 1) {
      const rawUrl = String(urls[i] || '').trim();
      if (!rawUrl) continue;
      let parsed: URL;
      try {
        parsed = new URL(rawUrl);
      } catch {
        continue;
      }
      const host = (parsed.hostname || '').toLowerCase();
      if (!host.includes('ebayimg.com')) continue;

      const imgRes = await fetch(parsed.toString(), { headers: { 'User-Agent': UA } });
      if (!imgRes.ok) continue;
      const buf = Buffer.from(await imgRes.arrayBuffer());
      const ext = (imgRes.headers.get('content-type') || '').includes('png') ? 'png' : 'jpg';
      archive.append(buf, { name: `foto-${i + 1}.${ext}` });
      added += 1;
    }

    if (added === 0) {
      archive.abort();
      throw new BadRequestException('No se pudieron descargar imagenes');
    }

    await archive.finalize();
  }
}
