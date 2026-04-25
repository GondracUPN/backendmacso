import { BadRequestException, Body, Controller, Get, NotFoundException, Post, Query, Req, Res } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { AppService } from './app.service';
import { AnalyticsService } from './analytics/analytics.service';
import { EbayPawn } from './ebay-pawn.entity';
import type { Request, Response } from 'express';
import * as archiver from 'archiver';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Repository } from 'typeorm';

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

  if (attrs.tipo === 'macbook' && /\bneo\b/.test(t)) attrs.gama = 'Neo';
  else if (/\bpro max\b/.test(t)) attrs.gama = 'Pro Max';
  else if (/\bpro\b/.test(t)) attrs.gama = 'Pro';
  else if (/\bair\b/.test(t)) attrs.gama = 'Air';
  else if (/\bmini\b/.test(t)) attrs.gama = 'Mini';
  else if (/\bplus\b/.test(t)) attrs.gama = 'Plus';
  else if (/\bultra\b/.test(t)) attrs.gama = 'Ultra';

  const a18Match = t.match(/\b(a18)\s*(pro)\b/);
  const procMatch =
    a18Match ||
    t.match(/\b(m[1-5])\s*(pro|max|ultra)?\b/) ||
    t.match(/\b(i[3579])\b/) ||
    t.match(/\b(ryzen\s*\d)\b/);
  if (procMatch) {
    const base = procMatch[1].toUpperCase();
    const suffix = procMatch[2]
      ? ` ${procMatch[2].charAt(0).toUpperCase()}${procMatch[2].slice(1).toLowerCase()}`
      : '';
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

type EbayStoreEntry = {
  storeUrl: string;
  storeName: string;
  seller: string;
  originalUrl?: string;
};

const DEFAULT_EBAY_STORE_FEED: EbayStoreEntry[] = [
  {
    storeUrl: 'https://www.ebay.com/str/ezpawncorp',
    storeName: 'EZ Pawn Corp',
    seller: 'ezpawncorpnyc',
  },
  {
    storeUrl: 'https://www.ebay.com/str/irvingsuperpawn',
    storeName: 'Irving Super Pawn',
    seller: 'irvingsuperpawn',
  },
  {
    storeUrl: 'https://www.ebay.com/str/silasdeanepawnshop',
    storeName: 'Silas Deane Pawn Shop',
    seller: 'silasdeanepawnshop',
  },
  {
    storeUrl: 'https://www.ebay.com/str/caldwellpawn1',
    storeName: 'Caldwell Pawn 1',
    seller: 'pawn1_caldwell',
  },
];

const APPLE_FAMILY_QUERY_GROUPS = {
  ipad: [
    { key: 'ipad-11-a16', label: 'iPad 11 A16', query: 'apple ipad 11 inch a16' },
    { key: 'ipad-11-m1', label: 'iPad 11 M1', query: 'apple ipad 11 inch m1' },
    { key: 'ipad-11-m2', label: 'iPad 11 M2', query: 'apple ipad 11 inch m2' },
    { key: 'ipad-11-m3', label: 'iPad 11 M3', query: 'apple ipad 11 inch m3' },
    { key: 'ipad-11-m4', label: 'iPad 11 M4', query: 'apple ipad 11 inch m4' },
    { key: 'ipad-11-m5', label: 'iPad 11 M5', query: 'apple ipad 11 inch m5' },
    { key: 'ipad-129-a16', label: 'iPad 12.9 A16', query: 'apple ipad 12.9 inch a16' },
    { key: 'ipad-129-m1', label: 'iPad 12.9 M1', query: 'apple ipad 12.9 inch m1' },
    { key: 'ipad-129-m2', label: 'iPad 12.9 M2', query: 'apple ipad 12.9 inch m2' },
    { key: 'ipad-129-m3', label: 'iPad 12.9 M3', query: 'apple ipad 12.9 inch m3' },
    { key: 'ipad-129-m4', label: 'iPad 12.9 M4', query: 'apple ipad 12.9 inch m4' },
    { key: 'ipad-129-m5', label: 'iPad 12.9 M5', query: 'apple ipad 12.9 inch m5' },
    { key: 'ipad-13-a16', label: 'iPad 13 A16', query: 'apple ipad 13 inch a16' },
    { key: 'ipad-13-m1', label: 'iPad 13 M1', query: 'apple ipad 13 inch m1' },
    { key: 'ipad-13-m2', label: 'iPad 13 M2', query: 'apple ipad 13 inch m2' },
    { key: 'ipad-13-m3', label: 'iPad 13 M3', query: 'apple ipad 13 inch m3' },
    { key: 'ipad-13-m4', label: 'iPad 13 M4', query: 'apple ipad 13 inch m4' },
    { key: 'ipad-13-m5', label: 'iPad 13 M5', query: 'apple ipad 13 inch m5' },
  ],
  iphone: [
    { key: 'iphone-13', label: 'iPhone 13', query: 'apple iphone 13 unlocked' },
    { key: 'iphone-13-pro', label: 'iPhone 13 Pro', query: 'apple iphone 13 pro unlocked' },
    { key: 'iphone-13-pro-max', label: 'iPhone 13 Pro Max', query: 'apple iphone 13 pro max unlocked' },
    { key: 'iphone-14', label: 'iPhone 14', query: 'apple iphone 14 unlocked' },
    { key: 'iphone-14-plus', label: 'iPhone 14 Plus', query: 'apple iphone 14 plus unlocked' },
    { key: 'iphone-14-pro', label: 'iPhone 14 Pro', query: 'apple iphone 14 pro unlocked' },
    { key: 'iphone-14-pro-max', label: 'iPhone 14 Pro Max', query: 'apple iphone 14 pro max unlocked' },
    { key: 'iphone-15', label: 'iPhone 15', query: 'apple iphone 15 unlocked' },
    { key: 'iphone-15-plus', label: 'iPhone 15 Plus', query: 'apple iphone 15 plus unlocked' },
    { key: 'iphone-15-pro', label: 'iPhone 15 Pro', query: 'apple iphone 15 pro unlocked' },
    { key: 'iphone-15-pro-max', label: 'iPhone 15 Pro Max', query: 'apple iphone 15 pro max unlocked' },
    { key: 'iphone-16', label: 'iPhone 16', query: 'apple iphone 16 unlocked' },
    { key: 'iphone-16-e', label: 'iPhone 16 E', query: 'apple iphone 16 e unlocked' },
    { key: 'iphone-16-plus', label: 'iPhone 16 Plus', query: 'apple iphone 16 plus unlocked' },
    { key: 'iphone-16-pro', label: 'iPhone 16 Pro', query: 'apple iphone 16 pro unlocked' },
    { key: 'iphone-16-pro-max', label: 'iPhone 16 Pro Max', query: 'apple iphone 16 pro max unlocked' },
    { key: 'iphone-17', label: 'iPhone 17', query: 'apple iphone 17 unlocked' },
    { key: 'iphone-17-e', label: 'iPhone 17 E', query: 'apple iphone 17 e unlocked' },
    { key: 'iphone-17-pro', label: 'iPhone 17 Pro', query: 'apple iphone 17 pro unlocked' },
    { key: 'iphone-17-pro-max', label: 'iPhone 17 Pro Max', query: 'apple iphone 17 pro max unlocked' },
  ],
  macbook: [
    { key: 'macbook-air-m1', label: 'MacBook Air M1', query: 'apple macbook air m1' },
    { key: 'macbook-air-m2', label: 'MacBook Air M2', query: 'apple macbook air m2' },
    { key: 'macbook-air-m3', label: 'MacBook Air M3', query: 'apple macbook air m3' },
    { key: 'macbook-air-m4', label: 'MacBook Air M4', query: 'apple macbook air m4' },
    { key: 'macbook-air-m5', label: 'MacBook Air M5', query: 'apple macbook air m5' },
    { key: 'macbook-pro-m1', label: 'MacBook Pro M1', query: 'apple macbook pro m1' },
    { key: 'macbook-pro-m2', label: 'MacBook Pro M2', query: 'apple macbook pro m2' },
    { key: 'macbook-pro-m3', label: 'MacBook Pro M3', query: 'apple macbook pro m3' },
    { key: 'macbook-pro-m4', label: 'MacBook Pro M4', query: 'apple macbook pro m4' },
    { key: 'macbook-pro-m5', label: 'MacBook Pro M5', query: 'apple macbook pro m5' },
  ],
} as const;

let ebayTokenCache: { token: string; expiresAt: number } | null = null;
const TM_STORAGE_DIR = join(process.cwd(), 'storage', 'tm');
const TM_TEMPLATE_FILE = join(TM_STORAGE_DIR, 'ebay-template.html');
const TM_TEMPLATE_META_FILE = join(TM_STORAGE_DIR, 'ebay-template.meta.json');
const TM_AMAZON_TEMPLATE_FILE = join(TM_STORAGE_DIR, 'amazon-template.html');
const TM_AMAZON_TEMPLATE_META_FILE = join(TM_STORAGE_DIR, 'amazon-template.meta.json');
const EBAY_STORE_FEED_FILE = join(process.cwd(), 'storage', 'ebay-store-feed.json');

const normalizeEnvToken = (val: string) =>
  val.trim().replace(/^"+|"+$/g, '').replace(/\s+/g, '');

const sanitizeEbayStoreEntry = (entry: any): EbayStoreEntry | null => {
  const storeUrl = String(entry?.storeUrl || '').trim();
  const storeName = String(entry?.storeName || '').trim();
  const seller = String(entry?.seller || '').trim();
  const originalUrl = String(entry?.originalUrl || storeUrl).trim();
  if (!storeUrl || !storeName || !seller) return null;
  return { storeUrl, storeName, seller, originalUrl };
};

const normalizeStoreUrlText = (rawUrl: string) =>
  String(rawUrl || '')
    .replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u2060]/g, '')
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '');

const compactStoreUrlInput = (value: string) => String(value || '').replace(/\s+/g, '');

const stripTrailingStoreUrlJunk = (value: string) => String(value || '').replace(/[)\],;:!?]+$/g, '');

const sanitizeStoreUrlInput = (rawUrl: string) => compactStoreUrlInput(normalizeStoreUrlText(rawUrl));

const clipForLog = (value: any, max = 240) => {
  const text =
    typeof value === 'string'
      ? value
      : (() => {
          try {
            return JSON.stringify(value);
          } catch {
            return String(value);
          }
        })();
  return text.length > max ? `${text.slice(0, max)}...` : text;
};

const logEbayPawnStore = (stage: string, details?: Record<string, any>) => {
  if (details) {
    console.log(`[eBay][pawn-store] ${stage}`, details);
    return;
  }
  console.log(`[eBay][pawn-store] ${stage}`);
};

const logEbayPawnStoreError = (stage: string, details?: Record<string, any>) => {
  if (details) {
    console.error(`[eBay][pawn-store] ${stage}`, details);
    return;
  }
  console.error(`[eBay][pawn-store] ${stage}`);
};

const titleCaseStoreSlug = (value: string) =>
  String(value || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b([a-z])/g, (_, ch: string) => ch.toUpperCase());

const extractCaptchaReturnUrl = (rawUrl: string): string | null => {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    const pathname = parsed.pathname.replace(/\/+$/, '').toLowerCase();
    if (!pathname.endsWith('/splashui/captcha')) return null;
    const ru = String(parsed.searchParams.get('ru') || '').trim();
    if (!ru) return null;
    return decodeURIComponent(ru);
  } catch {
    return null;
  }
};

const deriveEbayStoreEntryFromUrl = (storeUrl: string, originalUrl?: string): EbayStoreEntry | null => {
  try {
    const parsed = new URL(storeUrl);
    const pathname = parsed.pathname.replace(/\/+$/, '');
    const directMatch = pathname.match(/^\/(str|usr)\/([^/]+)$/i);
    if (!directMatch?.[2]) return null;
    const kind = directMatch[1].toLowerCase();
    const identifier = directMatch[2].toLowerCase();
    return {
      storeUrl: `https://www.ebay.com/${kind}/${identifier}`,
      storeName: titleCaseStoreSlug(identifier) || identifier,
      seller: identifier,
      originalUrl: sanitizeStoreUrlInput(originalUrl || storeUrl),
    };
  } catch {
    return null;
  }
};

const isCaptchaHtml = (html: string) => /captcha|robot check|verify yourself|security measure/i.test(String(html || ''));

const extractCandidateEbayUrl = (rawUrl: string) => {
  const normalized = normalizeStoreUrlText(rawUrl);
  const directMatch = normalized.match(/https?:\/\/[^\s"'`<>]+/i)?.[0];
  if (directMatch) return stripTrailingStoreUrlJunk(sanitizeStoreUrlInput(directMatch));

  const hostMatch = normalized.match(/(?:www\.)?ebay\.[a-z.]+\/[^\s"'`<>]+/i)?.[0];
  if (hostMatch) {
    const candidate = stripTrailingStoreUrlJunk(sanitizeStoreUrlInput(hostMatch));
    return candidate.startsWith('http') ? candidate : `https://${candidate}`;
  }

  const pathMatch =
    normalized.match(/(?:^|[\s"'`(])((?:\/)?(?:str|usr)\/[^\s/?#"'`<>]+)/i)?.[1] ||
    normalized.match(/^\/(?:str|usr)\/[^/]+$/i)?.[0];
  if (pathMatch) {
    const normalizedPath = stripTrailingStoreUrlJunk(sanitizeStoreUrlInput(pathMatch)).replace(/^\/?/, '/');
    return `https://www.ebay.com${normalizedPath}`;
  }

  const sanitized = sanitizeStoreUrlInput(rawUrl);
  const compactDirectMatch = sanitized.match(/https?:\/\/[^\s"'`<>]+/i)?.[0];
  if (compactDirectMatch) return stripTrailingStoreUrlJunk(compactDirectMatch);

  const compactHostMatch = sanitized.match(/(?:www\.)?ebay\.[a-z.]+\/[^\s"'`<>]+/i)?.[0];
  if (compactHostMatch) {
    const candidate = stripTrailingStoreUrlJunk(compactHostMatch);
    return candidate.startsWith('http') ? candidate : `https://${candidate}`;
  }

  return stripTrailingStoreUrlJunk(sanitized);
};

const normalizeStoreIdentity = (value: string) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');

const isSameEbayStoreEntry = (left?: EbayStoreEntry | null, right?: EbayStoreEntry | null) => {
  if (!left || !right) return false;
  return (
    normalizeStoreIdentity(left.storeUrl) === normalizeStoreIdentity(right.storeUrl) ||
    normalizeStoreIdentity(left.storeName) === normalizeStoreIdentity(right.storeName) ||
    normalizeStoreIdentity(left.seller) === normalizeStoreIdentity(right.seller)
  );
};

const loadEbayStoreFeedSeed = async () => {
  try {
    const raw = await readFile(EBAY_STORE_FEED_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed)
      ? parsed.map((entry) => sanitizeEbayStoreEntry(entry)).filter((entry): entry is EbayStoreEntry => !!entry)
      : [];
    if (entries.length > 0) {
      return entries;
    }
  } catch {}
  return DEFAULT_EBAY_STORE_FEED.map((entry) => sanitizeEbayStoreEntry(entry)).filter((entry): entry is EbayStoreEntry => !!entry);
};

const dedupeEbayStoreEntries = (entries: EbayStoreEntry[]) => {
  const seen = new Set<string>();
  const out: EbayStoreEntry[] = [];
  for (const entry of entries) {
    const normalized = sanitizeEbayStoreEntry(entry);
    if (!normalized) continue;
    const key =
      normalizeStoreIdentity(normalized.seller) ||
      normalizeStoreIdentity(normalized.storeUrl) ||
      normalizeStoreIdentity(normalized.storeName);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
};

export const normalizeEbayStoreUrl = (rawUrl: string) => {
  const normalizedText = normalizeStoreUrlText(rawUrl);
  const compactInput = sanitizeStoreUrlInput(rawUrl);
  const sanitizedUrl = extractCandidateEbayUrl(rawUrl);
  logEbayPawnStore('normalize:start', {
    rawUrl: clipForLog(rawUrl),
    normalizedText: clipForLog(normalizedText),
    compactInput: clipForLog(compactInput),
    extractedCandidate: clipForLog(sanitizedUrl),
  });
  let parsed: URL;
  try {
    parsed = new URL(sanitizedUrl);
  } catch {
    logEbayPawnStoreError('normalize:invalid-url', {
      rawUrl: clipForLog(rawUrl),
      normalizedText: clipForLog(normalizedText),
      compactInput: clipForLog(compactInput),
      sanitizedUrl: clipForLog(sanitizedUrl),
    });
    throw new BadRequestException('URL de pawn invalida');
  }
  const host = (parsed.hostname || '').toLowerCase();
  if (!host.includes('ebay.')) {
    logEbayPawnStoreError('normalize:invalid-host', {
      rawUrl: clipForLog(rawUrl),
      sanitizedUrl: clipForLog(sanitizedUrl),
      host,
    });
    throw new BadRequestException('La URL debe ser de eBay');
  }

  const pathname = parsed.pathname.replace(/\/+$/, '');
  const captchaReturnUrl = extractCaptchaReturnUrl(parsed.toString());
  if (captchaReturnUrl && captchaReturnUrl !== parsed.toString()) {
    logEbayPawnStore('normalize:resolved-captcha-return', {
      rawUrl: clipForLog(rawUrl),
      captchaUrl: clipForLog(parsed.toString()),
      captchaReturnUrl: clipForLog(captchaReturnUrl),
    });
    return normalizeEbayStoreUrl(captchaReturnUrl);
  }

  const directMatch = pathname.match(/^\/(str|usr)\/([^/]+)$/i);
  if (directMatch) {
    const normalizedUrl = `https://www.ebay.com/${directMatch[1].toLowerCase()}/${directMatch[2].toLowerCase()}`;
    logEbayPawnStore('normalize:resolved-direct', {
      rawUrl: clipForLog(rawUrl),
      pathname,
      normalizedUrl,
    });
    return normalizedUrl;
  }

  const sellerFromQuery =
    String(
      parsed.searchParams.get('_ssn') ||
      parsed.searchParams.get('seller') ||
      parsed.searchParams.get('username') ||
      '',
    ).trim();
  if (sellerFromQuery) {
    const normalizedUrl = `https://www.ebay.com/usr/${sellerFromQuery.toLowerCase()}`;
    logEbayPawnStore('normalize:resolved-query-seller', {
      rawUrl: clipForLog(rawUrl),
      sellerFromQuery,
      normalizedUrl,
      search: parsed.search,
    });
    return normalizedUrl;
  }

  const smeMatch = pathname.match(/^\/sme\/([^/]+)(?:\/.*)?$/i);
  if (smeMatch?.[1]) {
    const normalizedUrl = `https://www.ebay.com/usr/${smeMatch[1].toLowerCase()}`;
    logEbayPawnStore('normalize:resolved-sme', {
      rawUrl: clipForLog(rawUrl),
      pathname,
      normalizedUrl,
    });
    return normalizedUrl;
  }

  const feedbackMatch = pathname.match(/^\/fdbk\/feedback_profile\/([^/]+)$/i);
  if (feedbackMatch?.[1]) {
    const normalizedUrl = `https://www.ebay.com/usr/${feedbackMatch[1].toLowerCase()}`;
    logEbayPawnStore('normalize:resolved-feedback', {
      rawUrl: clipForLog(rawUrl),
      pathname,
      normalizedUrl,
    });
    return normalizedUrl;
  }

  if (!/^\/(str|usr)\/[^/]+$/i.test(pathname)) {
    logEbayPawnStoreError('normalize:invalid-pathname', {
      rawUrl: clipForLog(rawUrl),
      normalizedText: clipForLog(normalizedText),
      compactInput: clipForLog(compactInput),
      sanitizedUrl: clipForLog(sanitizedUrl),
      host,
      pathname,
      search: parsed.search,
    });
    throw new BadRequestException('La URL debe apuntar a una tienda o perfil de eBay (/str/... o /usr/...)');
  }
  const normalizedUrl = `https://www.ebay.com${pathname.toLowerCase()}`;
  logEbayPawnStore('normalize:resolved-fallback', {
    rawUrl: clipForLog(rawUrl),
    pathname,
    normalizedUrl,
  });
  return normalizedUrl;
};

const parseStoredUrlsPayload = (payload: any): string[] => {
  if (Array.isArray(payload?.urls)) {
    return payload.urls.map((value: any) => String(value || '').trim()).filter(Boolean);
  }
  if (typeof payload?.url === 'string' && payload.url.trim()) {
    return [payload.url.trim()];
  }
  if (typeof payload?.text === 'string' && payload.text.trim()) {
    return payload.text
      .split(/[\r\n,;]+/)
      .map((value) => value.trim())
      .filter(Boolean);
  }
  return [];
};

const resolveEbayStoreEntry = async (rawUrl: string): Promise<EbayStoreEntry> => {
  logEbayPawnStore('resolve:start', { rawUrl: clipForLog(rawUrl) });
  const storeUrl = normalizeEbayStoreUrl(rawUrl);
  logEbayPawnStore('resolve:fetching', { rawUrl: clipForLog(rawUrl), storeUrl });
  const res = await fetch(storeUrl, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  logEbayPawnStore('resolve:fetched', {
    requestedUrl: storeUrl,
    responseUrl: clipForLog(res.url || storeUrl),
    status: res.status,
    ok: res.ok,
    redirected: res.redirected,
  });
  if (!res.ok) {
    logEbayPawnStoreError('resolve:fetch-failed', {
      rawUrl: clipForLog(rawUrl),
      storeUrl,
      responseUrl: clipForLog(res.url || storeUrl),
      status: res.status,
    });
    throw new BadRequestException(`No se pudo abrir la tienda (${res.status})`);
  }

  const html = await res.text().catch(() => '');
  const finalUrl = normalizeEbayStoreUrl(res.url || storeUrl);
  const fallbackEntry = deriveEbayStoreEntryFromUrl(finalUrl, rawUrl);
  const seller =
    decodeURIComponent(html.match(/entity_id=%7E([A-Za-z0-9_.-]+)/i)?.[1] || '') ||
    html.match(/"entityId"\s*:\s*"~([^"]+)"/i)?.[1] ||
    html.match(/"storeOwnerUsername"\s*:\s*"([^"]+)"/i)?.[1] ||
    '';
  const storeNameRaw =
    html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i)?.[1] ||
    html.match(/<title>([^<]+)<\/title>/i)?.[1] ||
    '';
  const storeName = String(storeNameRaw || '')
    .replace(/\|\s*eBay Stores?$/i, '')
    .replace(/\|\s*eBay$/i, '')
    .trim();

  logEbayPawnStore('resolve:parsed', {
    rawUrl: clipForLog(rawUrl),
    requestedUrl: storeUrl,
    finalUrl,
    seller: clipForLog(seller),
    storeName: clipForLog(storeName),
    htmlLength: html.length,
    usedFallbackCandidate: Boolean(fallbackEntry),
  });

  if ((!seller || !storeName) && (res.redirected || isCaptchaHtml(html)) && fallbackEntry) {
    logEbayPawnStore('resolve:captcha-fallback', {
      rawUrl: clipForLog(rawUrl),
      requestedUrl: storeUrl,
      responseUrl: clipForLog(res.url || storeUrl),
      finalUrl,
      redirected: res.redirected,
      htmlLength: html.length,
      fallbackEntry,
    });
    return fallbackEntry;
  }

  if (!seller) {
    logEbayPawnStoreError('resolve:missing-seller', {
      rawUrl: clipForLog(rawUrl),
      requestedUrl: storeUrl,
      finalUrl,
      storeName: clipForLog(storeName),
      htmlLength: html.length,
    });
    throw new BadRequestException('No se pudo resolver el seller real de esa tienda');
  }
  if (!storeName) {
    logEbayPawnStoreError('resolve:missing-store-name', {
      rawUrl: clipForLog(rawUrl),
      requestedUrl: storeUrl,
      finalUrl,
      seller: clipForLog(seller),
      htmlLength: html.length,
    });
    throw new BadRequestException('No se pudo resolver el nombre de esa tienda');
  }

  return {
    storeUrl: finalUrl,
    storeName,
    seller: String(seller).trim(),
    originalUrl: sanitizeStoreUrlInput(rawUrl),
  };
};

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

const buildEbayConditionFilter = (rawCondition?: string) => {
  const condition = String(rawCondition || '').trim().toLowerCase();
  if (!condition) return '';
  if (condition === 'used') return 'conditions:{USED}';
  if (condition === 'new') return 'conditionIds:{1000}';
  if (condition === 'open_box') return 'conditionIds:{1500}';
  if (condition === 'for_parts') return 'conditionIds:{7000}';
  if (condition === 'auction_normal') return 'conditionIds:{1000|1500|2000|2010|2020|2030|2500|2750|2990|3000|3010|4000|5000|6000}';
  if (condition === 'auction_for_parts') return 'conditionIds:{7000}';
  return '';
};

const buildEbayBuyingOptionsFilter = (rawBuyingOptions?: string) => {
  const buyingOptions = String(rawBuyingOptions || '').trim().toUpperCase();
  if (!buyingOptions) return '';
  return `buyingOptions:{${buyingOptions}}`;
};

const normalizeLookupText = (val: string) =>
  String(val || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9.+\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const APPLE_ACCESSORY_KEYWORDS = [
  'sleeve',
  'keyboard',
  'magic keyboard',
  'folio',
  'smart folio',
  'case',
  'cover',
  'bag',
  'shell',
  'skin',
  'pencil',
  'charger',
  'cable',
  'adapter',
  'protector',
  'screen protector',
  'stylus',
  'pen',
  'replacement',
  'housing',
  'digitizer',
  'lcd',
  'glass',
  'bundle only',
];

const APPLE_ACCESSORY_PRIMARY_PATTERNS = [
  /^(?:apple\s+)?(?:(?:laptop|tablet|phone|cell\s+phone|smartphone)\s+)?(?:case|sleeve|cover|folio|keyboard|magic keyboard|smart folio|screen protector|protector|pencil|charger|adapter|cable|bag|shell|skin|housing|digitizer|lcd|glass)\b/,
  /\bcompatible with\b/,
  /\bdesigned for\b/,
  /\bfits?\s+(?:the\s+)?(?:apple\s+)?(?:macbook|ipad|iphone|watch)\b/,
  /\bfor\s+(?:the\s+)?(?:apple\s+)?(?:macbook|ipad|iphone|watch)\b/,
  /\breplacement\b/,
];

const APPLE_DEVICE_SIGNAL_PATTERNS = [
  /\bm[1-5](?:\s+(?:pro|max))?\b/,
  /\b\d+(?:gb|tb)\b/,
  /\b\d+gb\s+ram\b/,
  /\b(?:wifi|cellular|gps|unlocked|ssd|ram|cycles)\b/,
  /\ba\d{4}\b/,
  /\b[a-z0-9]{3,}ll\/a\b/,
];

const hasAppleAccessoryKeyword = (normalized: string) =>
  APPLE_ACCESSORY_KEYWORDS.some((keyword) => normalized.includes(keyword));

const hasAppleDeviceSignals = (normalized: string) =>
  APPLE_DEVICE_SIGNAL_PATTERNS.some((pattern) => pattern.test(normalized));

const isAccessoryPrimaryForFamily = (
  normalized: string,
  family: 'ipad' | 'iphone' | 'macbook',
) => {
  if (family === 'ipad') {
    return /\bipad(?:\s+(?:pro|air|mini|\d+(?:\.\d+)?))?(?:\s+\w+){0,2}\s+(?:case|sleeve|cover|folio|keyboard|magic keyboard|smart folio|screen protector|protector|pencil)\b/.test(normalized);
  }
  if (family === 'iphone') {
    return /\biphone(?:\s+\d{2})?(?:\s+(?:pro|max|plus|mini|e)){0,2}(?:\s+\w+){0,1}\s+(?:case|cover|screen protector|protector|charger|cable)\b/.test(normalized);
  }
  return /\bmacbook(?:\s+(?:air|pro))?(?:\s+\w+){0,2}\s+(?:case|sleeve|cover|bag|shell)\b/.test(normalized);
};

const isAccessoryTitle = (
  title: string,
  family?: 'ipad' | 'iphone' | 'macbook',
) => {
  const normalized = normalizeLookupText(title);
  if (!hasAppleAccessoryKeyword(normalized)) return false;
  if (APPLE_ACCESSORY_PRIMARY_PATTERNS.some((pattern) => pattern.test(normalized))) return true;
  if (family && isAccessoryPrimaryForFamily(normalized, family)) return true;
  if (!hasAppleDeviceSignals(normalized)) return true;
  return false;
};

const isLikelyAppleDeviceTitle = (title: string, family: 'ipad' | 'iphone' | 'macbook') => {
  const normalized = normalizeLookupText(title);
  if (isAccessoryTitle(normalized, family)) return false;
  if (family === 'ipad') return normalized.includes('ipad');
  if (family === 'iphone') return normalized.includes('iphone');
  return normalized.includes('macbook');
};

const matchesAppleFamilyEntry = (
  title: string,
  entry: { family: 'ipad' | 'iphone' | 'macbook'; key: string },
) => {
  const normalized = normalizeLookupText(title);
  if (!isLikelyAppleDeviceTitle(normalized, entry.family)) return false;

  if (entry.family === 'iphone') {
    const key = String(entry.key || '').toLowerCase();
    const numberMatch = key.match(/iphone-(13|14|15|16|17)/);
    if (!numberMatch) return false;
    const requiredNumber = numberMatch[1];
    if (!normalized.includes(`iphone ${requiredNumber}`) && !normalized.includes(`iphone${requiredNumber}`)) {
      return false;
    }

    if (key.includes('-pro-max')) {
      return normalized.includes('pro max');
    }
    if (key.includes('-pro')) {
      return normalized.includes('pro') && !normalized.includes('pro max') ? true : normalized.includes('pro');
    }
    if (key.includes('-plus')) {
      return normalized.includes('plus');
    }
    if (key.includes('-e')) {
      return normalized.includes(`${requiredNumber}e`) || normalized.includes(`${requiredNumber} e`);
    }

    return !normalized.includes('plus') && !normalized.includes('pro') && !normalized.includes('max');
  }

  return true;
};

const normalizeEbayBrowseItems = (params: {
  items: any[];
  storeEntries?: ReadonlyArray<EbayStoreEntry>;
}) => {
  const storeBySeller = new Map(
    (params.storeEntries || []).map((entry) => [entry.seller.toLowerCase(), entry]),
  );

  return (Array.isArray(params.items) ? params.items : [])
    .map((item: any) => {
      const seller = String(item?.seller?.username || item?.seller?.userId || '').trim();
      const storeMeta = storeBySeller.get(seller.toLowerCase()) || null;
      return {
        itemId: String(item?.itemId || item?.legacyItemId || ''),
        legacyItemId: String(item?.legacyItemId || ''),
        title: String(item?.title || '').trim(),
        priceUSD: parsePriceValue(item?.price),
        currentBidPriceUSD: parsePriceValue(item?.currentBidPrice),
        currency: String(item?.price?.currency || 'USD').trim() || 'USD',
        itemWebUrl: String(item?.itemWebUrl || '').trim(),
        imageUrl: String(item?.image?.imageUrl || item?.thumbnailImages?.[0]?.imageUrl || '').trim(),
        seller,
        sellerFeedbackPercentage: parsePriceValue(item?.seller?.feedbackPercentage),
        sellerFeedbackScore: parsePriceValue(item?.seller?.feedbackScore),
        storeName: storeMeta?.storeName || seller,
        storeUrl: storeMeta?.storeUrl || '',
        itemCreationDate: String(item?.itemCreationDate || item?.itemOriginDate || '').trim(),
        itemOriginDate: String(item?.itemOriginDate || item?.itemCreationDate || '').trim(),
        itemEndDate: String(item?.itemEndDate || '').trim(),
        condition: String(item?.condition || '').trim(),
        conditionId: String(item?.conditionId || '').trim(),
        buyingOptions: Array.isArray(item?.buyingOptions) ? item.buyingOptions : [],
      };
    })
    .filter((item: any) => item.title && item.itemWebUrl)
    .sort((a: any, b: any) => {
      const timeA = Date.parse(a.itemOriginDate || a.itemCreationDate || '') || 0;
      const timeB = Date.parse(b.itemOriginDate || b.itemCreationDate || '') || 0;
      return timeB - timeA;
    });
};

const searchEbayItems = async (params?: {
  query?: string;
  limit?: number;
  offset?: number;
  condition?: string;
  buyingOptions?: string;
  sort?: string;
  storeEntries?: ReadonlyArray<EbayStoreEntry>;
}) => {
  const token = await getEbayAccessToken();
  const base = getEbayApiBase();
  const query = String(params?.query || 'apple').trim() || 'apple';
  const limitRaw = Number(params?.limit || 140);
  const offsetRaw = Number(params?.offset || 0);
  const limit = Math.min(200, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 140));
  const offset = Math.max(0, Number.isFinite(offsetRaw) ? offsetRaw : 0);
  const sort = String(params?.sort || 'newlyListed').trim() || 'newlyListed';
  const url = new URL(`${base}/buy/browse/v1/item_summary/search`);
  url.searchParams.set('q', query);
  const filters: string[] = [];
  if (Array.isArray(params?.storeEntries) && params.storeEntries.length > 0) {
    const sellerFilter = params.storeEntries.map((entry) => entry.seller).join('|');
    filters.push(`sellers:{${sellerFilter}}`);
  }
  const conditionFilter = buildEbayConditionFilter(params?.condition);
  if (conditionFilter) filters.push(conditionFilter);
  const buyingOptionsFilter = buildEbayBuyingOptionsFilter(params?.buyingOptions);
  if (buyingOptionsFilter) filters.push(buyingOptionsFilter);
  if (filters.length > 0) {
    url.searchParams.set('filter', filters.join(','));
  }
  url.searchParams.set('sort', sort);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
    },
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.log('[eBay] browse store feed status', { status: res.status, body: errText.slice(0, 400) });
    throw new BadRequestException(`No se pudo obtener items eBay (${res.status})`);
  }

  const data = await res.json();
  const items = normalizeEbayBrowseItems({
    items: Array.isArray(data?.itemSummaries) ? data.itemSummaries : [],
    storeEntries: params?.storeEntries,
  });

  return {
    query,
    sort,
    limit,
    offset,
    total: Number(data?.total || items.length || 0),
    sellers: params?.storeEntries || [],
    items,
  };
};

const fetchEbayStoreFeed = async (params?: {
  query?: string;
  limit?: number;
  offset?: number;
  condition?: string;
  buyingOptions?: string;
  storeEntries?: ReadonlyArray<EbayStoreEntry>;
}) => {
  return searchEbayItems({
    query: params?.query,
    limit: params?.limit,
    offset: params?.offset,
    condition: params?.condition,
    buyingOptions: params?.buyingOptions,
    storeEntries: params?.storeEntries || [],
  });
};

const fetchEbayAppleCollection = async (params?: {
  limit?: number;
  offset?: number;
  family?: 'all' | 'ipad' | 'iphone' | 'macbook';
  condition?: string;
  buyingOptions?: string;
  sort?: string;
}) => {
  const targetLimitRaw = Number(params?.limit || 140);
  const targetOffsetRaw = Number(params?.offset || 0);
  const targetLimit = Math.min(200, Math.max(1, Number.isFinite(targetLimitRaw) ? targetLimitRaw : 140));
  const targetOffset = Math.max(0, Number.isFinite(targetOffsetRaw) ? targetOffsetRaw : 0);
  const requestedFamily = String(params?.family || 'all').trim().toLowerCase();
  const familyKeys = requestedFamily && requestedFamily !== 'all'
    ? ([requestedFamily] as Array<'ipad' | 'iphone' | 'macbook'>)
    : (['ipad', 'iphone', 'macbook'] as Array<'ipad' | 'iphone' | 'macbook'>);

  const queryEntries = familyKeys.flatMap((familyKey) =>
    APPLE_FAMILY_QUERY_GROUPS[familyKey].map((entry) => ({
      ...entry,
      family: familyKey,
    })),
  );

  const desiredWindow = targetOffset + targetLimit;
  const perQueryLimit = Math.min(
    200,
    Math.max(24, Math.ceil((desiredWindow / Math.max(1, queryEntries.length)) * 3)),
  );

  const results = await Promise.all(
    queryEntries.map(async (entry) => {
      const data = await searchEbayItems({
        query: entry.query,
        limit: perQueryLimit,
        offset: 0,
        condition: params?.condition,
        buyingOptions: params?.buyingOptions,
        sort: params?.sort,
      });
      return {
        ...entry,
        total: Number(data?.total || 0),
        items: Array.isArray(data?.items) ? data.items : [],
      };
    }),
  );

  const seen = new Set<string>();
  const merged = results
    .flatMap((entry) =>
      entry.items.map((item: any) => ({
        ...item,
        family: entry.family,
        familyLabel: entry.family === 'ipad' ? 'iPad' : entry.family === 'iphone' ? 'iPhone' : 'MacBook',
        familyEntryKey: entry.key,
      })),
    )
    .filter((item: any) => matchesAppleFamilyEntry(item?.title || '', {
      family: item?.family,
      key: item?.familyEntryKey || '',
    }))
    .filter((item: any) => {
      const key = String(item?.itemId || item?.legacyItemId || item?.itemWebUrl || '');
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a: any, b: any) => {
      if (params?.sort === 'endingSoonest') {
        const timeA = Date.parse(a.itemEndDate || '') || Number.MAX_SAFE_INTEGER;
        const timeB = Date.parse(b.itemEndDate || '') || Number.MAX_SAFE_INTEGER;
        return timeA - timeB;
      }
      const timeA = Date.parse(a.itemOriginDate || a.itemCreationDate || '') || 0;
      const timeB = Date.parse(b.itemOriginDate || b.itemCreationDate || '') || 0;
      return timeB - timeA;
    })
    .slice(targetOffset, targetOffset + targetLimit);

  return {
    query: requestedFamily === 'all' ? 'Apple collection' : `Apple ${requestedFamily}`,
    sort: params?.sort || 'newlyListed',
    buyingOptions: params?.buyingOptions || '',
    condition: params?.condition || '',
    limit: targetLimit,
    offset: targetOffset,
    family: requestedFamily || 'all',
    total: results.reduce((sum, entry) => sum + Number(entry.total || 0), 0),
    groups: familyKeys.map((familyKey) => ({
      key: familyKey,
      label: familyKey === 'ipad' ? 'iPad' : familyKey === 'iphone' ? 'iPhone' : 'MacBook',
      total: results
        .filter((entry) => entry.family === familyKey)
        .reduce((sum, entry) => sum + Number(entry.total || 0), 0),
    })),
    items: merged,
  };
};

const fetchEbayAppleAuctions = async (params?: {
  limit?: number;
  offset?: number;
  family?: 'all' | 'ipad' | 'iphone' | 'macbook';
  condition?: string;
}) => {
  return fetchEbayAppleCollection({
    limit: params?.limit,
    offset: params?.offset,
    family: params?.family,
    condition: params?.condition,
    buyingOptions: 'AUCTION',
    sort: 'endingSoonest',
  });
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
    @InjectRepository(EbayPawn)
    private readonly ebayPawnsRepo: Repository<EbayPawn>,
  ) {}

  private mapEbayPawnEntity(entity: EbayPawn): EbayStoreEntry {
    return {
      storeUrl: String(entity?.storeUrl || '').trim(),
      storeName: String(entity?.storeName || '').trim(),
      seller: String(entity?.seller || '').trim(),
      originalUrl: String(entity?.originalUrl || entity?.storeUrl || '').trim(),
    };
  }

  private async ensureEbayPawnSeed(): Promise<EbayStoreEntry[]> {
    const existing = await this.ebayPawnsRepo.find({ order: { id: 'ASC' } });
    if (existing.length > 0) {
      return dedupeEbayStoreEntries(existing.map((entry) => this.mapEbayPawnEntity(entry)));
    }

    const seedEntries = await loadEbayStoreFeedSeed();
    if (!seedEntries.length) return [];

    const created = seedEntries.map((entry) =>
      this.ebayPawnsRepo.create({
        storeUrl: entry.storeUrl,
        storeName: entry.storeName,
        seller: entry.seller,
        originalUrl: entry.originalUrl || entry.storeUrl,
      }),
    );
    await this.ebayPawnsRepo.save(created);
    return dedupeEbayStoreEntries(created.map((entry) => this.mapEbayPawnEntity(entry)));
  }

  private async loadEbayStoreFeedFromDb(): Promise<EbayStoreEntry[]> {
    return this.ensureEbayPawnSeed();
  }

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

  @Get('tm/amazon-template')
  async getTmAmazonTemplate(@Res() res: Response) {
    try {
      const [html, fileStats] = await Promise.all([
        readFile(TM_AMAZON_TEMPLATE_FILE, 'utf8'),
        stat(TM_AMAZON_TEMPLATE_FILE),
      ]);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.setHeader('X-TM-Template-Updated-At', fileStats.mtime.toISOString());
      res.send(html);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw new NotFoundException('Aun no hay plantilla Amazon publicada');
      }
      throw e;
    }
  }

  @Get('tm/amazon-template/meta')
  async getTmAmazonTemplateMeta() {
    try {
      const raw = await readFile(TM_AMAZON_TEMPLATE_META_FILE, 'utf8');
      const meta = JSON.parse(raw);
      return { ok: true, ...meta };
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw new NotFoundException('Aun no hay metadatos de plantilla Amazon');
      }
      throw e;
    }
  }

  @Post('tm/amazon-template')
  async saveTmAmazonTemplate(@Req() req: Request, @Query('source') source?: string) {
    const normalizedHtml = String(req.body || '').trim();
    if (!normalizedHtml) {
      throw new BadRequestException('El body con HTML es obligatorio');
    }
    if (normalizedHtml.length > 3_000_000) {
      throw new BadRequestException('El HTML Amazon excede el tamano maximo permitido');
    }

    const updatedAt = new Date().toISOString();
    const meta = {
      updatedAt,
      size: normalizedHtml.length,
      source: String(source || 'unknown'),
    };

    await mkdir(TM_STORAGE_DIR, { recursive: true });
    await Promise.all([
      writeFile(TM_AMAZON_TEMPLATE_FILE, normalizedHtml, 'utf8'),
      writeFile(TM_AMAZON_TEMPLATE_META_FILE, JSON.stringify(meta, null, 2), 'utf8'),
    ]);

    return { ok: true, ...meta };
  }

  @Get('utils/image-proxy')
  async proxyImage(@Query('url') url: string, @Res() res: Response) {
    if (!url) {
      throw new BadRequestException('URL requerida');
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BadRequestException('URL invalida');
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new BadRequestException('Solo se permite http o https');
    }

    const upstream = await fetch(parsed.toString(), {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
    });

    if (!upstream.ok) {
      throw new BadRequestException('No se pudo descargar la imagen');
    }

    const contentType = String(upstream.headers.get('content-type') || '').toLowerCase();
    if (!contentType.startsWith('image/')) {
      throw new BadRequestException('La URL no devolvio una imagen');
    }

    const body = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(body);
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

  @Get('utils/ebay/store-feed')
  async getEbayStoreFeed(
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('condition') condition?: string,
    @Query('buyingOptions') buyingOptions?: string,
  ) {
    const storeEntries = await this.loadEbayStoreFeedFromDb();
    return fetchEbayStoreFeed({
      query: q,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      condition,
      buyingOptions,
      storeEntries,
    });
  }

  @Get('utils/ebay/pawns')
  async getSavedEbayPawns() {
    const stores = await this.loadEbayStoreFeedFromDb();
    return {
      total: stores.length,
      stores,
    };
  }

  @Post('utils/ebay/pawns')
  async addSavedEbayPawn(@Body() body: any) {
    logEbayPawnStore('add-single:start', {
      body: clipForLog(body, 500),
    });
    try {
      const urls = parseStoredUrlsPayload(body);
      logEbayPawnStore('add-single:parsed-payload', {
        urlsCount: urls.length,
        urlsPreview: urls.map((value) => clipForLog(value)),
      });
      if (urls.length !== 1) {
        throw new BadRequestException('Debes enviar una sola URL de tienda');
      }

      const existing = await this.loadEbayStoreFeedFromDb();
      logEbayPawnStore('add-single:existing-loaded', {
        existingCount: existing.length,
      });
      const resolved = await resolveEbayStoreEntry(urls[0]);
      logEbayPawnStore('add-single:resolved', {
        rawUrl: clipForLog(urls[0]),
        resolved,
      });
      const duplicateIndex = existing.findIndex((entry) => isSameEbayStoreEntry(entry, resolved));
      if (duplicateIndex >= 0) {
        const duplicate = existing[duplicateIndex];
        let saved = duplicate;
        if ((duplicate.originalUrl || duplicate.storeUrl) === duplicate.storeUrl && resolved.originalUrl && resolved.originalUrl !== duplicate.storeUrl) {
          const duplicateEntity = await this.ebayPawnsRepo.findOne({
            where: [
              { seller: duplicate.seller },
              { storeUrl: duplicate.storeUrl },
            ],
            order: { id: 'ASC' },
          });
          if (duplicateEntity) {
            duplicateEntity.originalUrl = resolved.originalUrl;
            await this.ebayPawnsRepo.save(duplicateEntity);
            saved = this.mapEbayPawnEntity(duplicateEntity);
          }
        }
        const stores = await this.loadEbayStoreFeedFromDb();
        logEbayPawnStore('add-single:duplicate', {
          rawUrl: clipForLog(urls[0]),
          duplicateAt: duplicateIndex,
          saved,
          total: stores.length,
        });
        return {
          duplicate: true,
          saved,
          total: stores.length,
          stores,
        };
      }

      const created = this.ebayPawnsRepo.create({
        storeUrl: resolved.storeUrl,
        storeName: resolved.storeName,
        seller: resolved.seller,
        originalUrl: resolved.originalUrl || resolved.storeUrl,
      });
      await this.ebayPawnsRepo.save(created);
      const stores = await this.loadEbayStoreFeedFromDb();
      const saved = this.mapEbayPawnEntity(created);
      logEbayPawnStore('add-single:created', {
        rawUrl: clipForLog(urls[0]),
        saved,
        total: stores.length,
      });
      return {
        duplicate: false,
        saved,
        total: stores.length,
        stores,
      };
    } catch (err: any) {
      logEbayPawnStoreError('add-single:error', {
        body: clipForLog(body, 500),
        message: String(err?.message || err),
        stack: clipForLog(err?.stack || '', 1200),
      });
      throw err;
    }
  }

  @Post('utils/ebay/pawns/bulk')
  async addSavedEbayPawnsBulk(@Body() body: any) {
    logEbayPawnStore('add-bulk:start', {
      body: clipForLog(body, 500),
    });
    try {
      const urls = parseStoredUrlsPayload(body);
      logEbayPawnStore('add-bulk:parsed-payload', {
        urlsCount: urls.length,
        urlsPreview: urls.slice(0, 10).map((value) => clipForLog(value)),
      });
      if (!urls.length) {
        throw new BadRequestException('Debes enviar URLs de tiendas');
      }

      const current = await this.loadEbayStoreFeedFromDb();
      const merged = [...current];
      const added: EbayStoreEntry[] = [];
      const skipped: string[] = [];
      logEbayPawnStore('add-bulk:existing-loaded', {
        existingCount: current.length,
      });

      for (const rawUrl of urls) {
        try {
          logEbayPawnStore('add-bulk:item-start', { rawUrl: clipForLog(rawUrl) });
          const resolved = await resolveEbayStoreEntry(rawUrl);
          const existingIndex = merged.findIndex((entry) => isSameEbayStoreEntry(entry, resolved));
          if (existingIndex >= 0) {
            const existingEntry = merged[existingIndex];
            if ((existingEntry.originalUrl || existingEntry.storeUrl) === existingEntry.storeUrl && resolved.originalUrl && resolved.originalUrl !== existingEntry.storeUrl) {
              const duplicateEntity = await this.ebayPawnsRepo.findOne({
                where: [
                  { seller: existingEntry.seller },
                  { storeUrl: existingEntry.storeUrl },
                ],
                order: { id: 'ASC' },
              });
              if (duplicateEntity) {
                duplicateEntity.originalUrl = resolved.originalUrl;
                await this.ebayPawnsRepo.save(duplicateEntity);
                merged[existingIndex] = this.mapEbayPawnEntity(duplicateEntity);
              }
            }
            skipped.push(rawUrl);
            logEbayPawnStore('add-bulk:item-duplicate', {
              rawUrl: clipForLog(rawUrl),
              existingIndex,
            });
            continue;
          }

          const created = this.ebayPawnsRepo.create({
            storeUrl: resolved.storeUrl,
            storeName: resolved.storeName,
            seller: resolved.seller,
            originalUrl: resolved.originalUrl || resolved.storeUrl,
          });
          await this.ebayPawnsRepo.save(created);
          const saved = this.mapEbayPawnEntity(created);
          merged.push(saved);
          added.push(saved);
          logEbayPawnStore('add-bulk:item-created', {
            rawUrl: clipForLog(rawUrl),
            saved,
          });
        } catch (err: any) {
          skipped.push(`${rawUrl} :: ${String(err?.message || 'error')}`);
          logEbayPawnStoreError('add-bulk:item-error', {
            rawUrl: clipForLog(rawUrl),
            message: String(err?.message || err),
            stack: clipForLog(err?.stack || '', 1200),
          });
        }
      }

      const stores = await this.loadEbayStoreFeedFromDb();
      logEbayPawnStore('add-bulk:complete', {
        addedCount: added.length,
        skippedCount: skipped.length,
        total: stores.length,
      });
      return {
        added,
        skipped,
        total: stores.length,
        stores,
      };
    } catch (err: any) {
      logEbayPawnStoreError('add-bulk:error', {
        body: clipForLog(body, 500),
        message: String(err?.message || err),
        stack: clipForLog(err?.stack || '', 1200),
      });
      throw err;
    }
  }

  @Get('utils/ebay/search')
  async searchEbayCatalog(
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('condition') condition?: string,
    @Query('buyingOptions') buyingOptions?: string,
  ) {
    return searchEbayItems({
      query: q,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      condition,
      buyingOptions,
    });
  }

  @Get('utils/ebay/apple-collection')
  async getEbayAppleCollection(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('family') family?: 'all' | 'ipad' | 'iphone' | 'macbook',
    @Query('condition') condition?: string,
    @Query('buyingOptions') buyingOptions?: string,
  ) {
    return fetchEbayAppleCollection({
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      family,
      condition,
      buyingOptions,
      sort: 'newlyListed',
    });
  }

  @Get('utils/ebay/apple-auctions')
  async getEbayAppleAuctions(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('family') family?: 'all' | 'ipad' | 'iphone' | 'macbook',
    @Query('condition') condition?: string,
  ) {
    return fetchEbayAppleAuctions({
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      family,
      condition,
    });
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
