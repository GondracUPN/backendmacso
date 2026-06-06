import { BadRequestException, Body, Controller, Get, NotFoundException, Post, Query, Req, Res } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { AppService } from './app.service';
import { AnalyticsService } from './analytics/analytics.service';
import { EbayPawn } from './ebay-pawn.entity';
import { EbaySearchItem } from './ebay-search-item.entity';
import { EbaySearchState } from './ebay-search-state.entity';
import { EbayViewedItem } from './ebay-viewed-item.entity';
import type { Request, Response } from 'express';
import * as archiver from 'archiver';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { In, Repository } from 'typeorm';

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

const getEbayApiRoot = () => {
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
    { key: 'iphone-13-mini', label: 'iPhone 13 Mini', query: 'apple iphone 13 mini unlocked' },
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

const PAWN_APPLE_PRODUCT_QUERIES = [
  { key: 'apple', label: 'Apple', query: 'apple' },
  { key: 'iphone', label: 'iPhone', query: 'iphone' },
  { key: 'ipad', label: 'iPad', query: 'ipad' },
  { key: 'macbook', label: 'MacBook', query: 'macbook' },
  { key: 'apple-watch', label: 'Apple Watch', query: 'apple watch' },
  { key: 'imac', label: 'iMac', query: 'imac' },
  { key: 'airpods', label: 'AirPods', query: 'airpods' },
  { key: 'airtag', label: 'AirTag', query: 'airtag' },
] as const;

const EXTENDED_APPLE_ALL_QUERY_GROUPS = [
  { key: 'airpods', label: 'AirPods', query: 'apple airpods', family: 'airpods' },
  { key: 'apple-watch', label: 'Apple Watch', query: 'apple watch', family: 'apple-watch' },
  { key: 'imac', label: 'iMac', query: 'apple imac', family: 'imac' },
  { key: 'mac-mini', label: 'Mac mini', query: 'apple mac mini', family: 'mac-mini' },
] as const;

const MACBOOK_AUCTION_QUERY_GROUPS = [
  { key: 'macbook-air-m1', label: 'MacBook Air M1', query: 'apple macbook air m1' },
  { key: 'macbook-air-m2', label: 'MacBook Air M2', query: 'apple macbook air m2' },
  { key: 'macbook-air-m3', label: 'MacBook Air M3', query: 'apple macbook air m3' },
  { key: 'macbook-air-m4', label: 'MacBook Air M4', query: 'apple macbook air m4' },
  { key: 'macbook-air-m5', label: 'MacBook Air M5', query: 'apple macbook air m5' },
  { key: 'macbook-pro-m1', label: 'MacBook Pro M1', query: 'apple macbook pro m1' },
  { key: 'macbook-pro-m1-pro', label: 'MacBook Pro M1 Pro', query: 'apple macbook m1 pro' },
  { key: 'macbook-pro-m1-max', label: 'MacBook Pro M1 Max', query: 'apple macbook m1 max' },
  { key: 'macbook-pro-m1-ultra', label: 'MacBook Pro M1 Ultra', query: 'apple macbook m1 ultra' },
  { key: 'macbook-pro-m2', label: 'MacBook Pro M2', query: 'apple macbook pro m2' },
  { key: 'macbook-pro-m2-pro', label: 'MacBook Pro M2 Pro', query: 'apple macbook m2 pro' },
  { key: 'macbook-pro-m2-max', label: 'MacBook Pro M2 Max', query: 'apple macbook m2 max' },
  { key: 'macbook-pro-m2-ultra', label: 'MacBook Pro M2 Ultra', query: 'apple macbook m2 ultra' },
  { key: 'macbook-pro-m3', label: 'MacBook Pro M3', query: 'apple macbook pro m3' },
  { key: 'macbook-pro-m3-pro', label: 'MacBook Pro M3 Pro', query: 'apple macbook m3 pro' },
  { key: 'macbook-pro-m3-max', label: 'MacBook Pro M3 Max', query: 'apple macbook m3 max' },
  { key: 'macbook-pro-m3-ultra', label: 'MacBook Pro M3 Ultra', query: 'apple macbook m3 ultra' },
  { key: 'macbook-pro-m4', label: 'MacBook Pro M4', query: 'apple macbook pro m4' },
  { key: 'macbook-pro-m4-pro', label: 'MacBook Pro M4 Pro', query: 'apple macbook m4 pro' },
  { key: 'macbook-pro-m4-max', label: 'MacBook Pro M4 Max', query: 'apple macbook m4 max' },
  { key: 'macbook-pro-m4-ultra', label: 'MacBook Pro M4 Ultra', query: 'apple macbook m4 ultra' },
  { key: 'macbook-pro-m5', label: 'MacBook Pro M5', query: 'apple macbook pro m5' },
  { key: 'macbook-pro-m5-pro', label: 'MacBook Pro M5 Pro', query: 'apple macbook m5 pro' },
  { key: 'macbook-pro-m5-max', label: 'MacBook Pro M5 Max', query: 'apple macbook m5 max' },
  { key: 'macbook-pro-m5-ultra', label: 'MacBook Pro M5 Ultra', query: 'apple macbook m5 ultra' },
  { key: 'macbook-neo-a18-pro', label: 'MacBook Neo A18 Pro', query: 'apple macbook neo a18 pro' },
  { key: 'macbook-model-a2336', label: 'MacBook A2336', query: 'apple macbook a2336' },
  { key: 'macbook-model-a2337', label: 'MacBook A2337', query: 'apple macbook a2337' },
  { key: 'macbook-model-a2338', label: 'MacBook A2338', query: 'apple macbook a2338' },
  { key: 'macbook-model-a2442', label: 'MacBook A2442', query: 'apple macbook a2442' },
  { key: 'macbook-model-a2485', label: 'MacBook A2485', query: 'apple macbook a2485' },
  { key: 'macbook-model-a2681', label: 'MacBook A2681', query: 'apple macbook a2681' },
  { key: 'macbook-model-a2779', label: 'MacBook A2779', query: 'apple macbook a2779' },
  { key: 'macbook-model-a2918', label: 'MacBook A2918', query: 'apple macbook a2918' },
  { key: 'macbook-model-a2941', label: 'MacBook A2941', query: 'apple macbook a2941' },
  { key: 'macbook-model-a2991', label: 'MacBook A2991', query: 'apple macbook a2991' },
  { key: 'macbook-model-a2992', label: 'MacBook A2992', query: 'apple macbook a2992' },
  { key: 'macbook-model-a3113', label: 'MacBook A3113', query: 'apple macbook a3113' },
  { key: 'macbook-order-ll-a', label: 'MacBook LL/A', query: 'apple macbook ll/a' },
] as const;

const WATCH_ULTRA_AUCTION_QUERY_GROUPS = [
  { key: 'apple-watch-ultra', label: 'Apple Watch Ultra', query: 'apple watch ultra' },
  { key: 'apple-watch-ultra-3', label: 'Apple Watch Ultra 3', query: 'apple watch ultra 3' },
  { key: 'apple-watch-ultra-2', label: 'Apple Watch Ultra 2', query: 'apple watch ultra 2' },
  { key: 'apple-watch-ultra-model-a2622', label: 'Apple Watch Ultra A2622', query: 'apple watch a2622' },
  { key: 'apple-watch-ultra-model-a2684', label: 'Apple Watch Ultra A2684', query: 'apple watch a2684' },
  { key: 'apple-watch-ultra-model-a2859', label: 'Apple Watch Ultra A2859', query: 'apple watch a2859' },
  { key: 'apple-watch-ultra-model-a2986', label: 'Apple Watch Ultra 2 A2986', query: 'apple watch a2986' },
  { key: 'apple-watch-ultra-model-a2987', label: 'Apple Watch Ultra 2 A2987', query: 'apple watch a2987' },
  { key: 'apple-watch-ultra-model-a3281', label: 'Apple Watch Ultra 3 A3281', query: 'apple watch a3281' },
  { key: 'apple-watch-ultra-model-a3282', label: 'Apple Watch Ultra 3 A3282', query: 'apple watch a3282' },
] as const;

const DESKTOP_AUCTION_QUERY_GROUPS = [
  { key: 'imac-m1', label: 'iMac M1', query: 'apple imac m1', family: 'imac' },
  { key: 'imac-m3', label: 'iMac M3', query: 'apple imac m3', family: 'imac' },
  { key: 'imac-m4', label: 'iMac M4', query: 'apple imac m4', family: 'imac' },
  { key: 'mac-mini-m1', label: 'Mac mini M1', query: 'apple mac mini m1', family: 'mac-mini' },
  { key: 'mac-mini-m2', label: 'Mac mini M2', query: 'apple mac mini m2', family: 'mac-mini' },
  { key: 'mac-mini-m4', label: 'Mac mini M4', query: 'apple mac mini m4', family: 'mac-mini' },
] as const;

const IPHONE_AUCTION_QUERY_GROUPS = [
  { key: 'iphone-13-auctions', label: 'iPhone 13', query: 'apple iphone 13' },
  { key: 'iphone-13-mini-auctions', label: 'iPhone 13 Mini', query: 'apple iphone 13 mini' },
  { key: 'iphone-13-pro-auctions', label: 'iPhone 13 Pro', query: 'apple iphone 13 pro' },
  { key: 'iphone-13-pro-max-auctions', label: 'iPhone 13 Pro Max', query: 'apple iphone 13 pro max' },
  { key: 'iphone-14-auctions', label: 'iPhone 14', query: 'apple iphone 14' },
  { key: 'iphone-14-plus-auctions', label: 'iPhone 14 Plus', query: 'apple iphone 14 plus' },
  { key: 'iphone-14-pro-auctions', label: 'iPhone 14 Pro', query: 'apple iphone 14 pro' },
  { key: 'iphone-14-pro-max-auctions', label: 'iPhone 14 Pro Max', query: 'apple iphone 14 pro max' },
  { key: 'iphone-15-auctions', label: 'iPhone 15', query: 'apple iphone 15' },
  { key: 'iphone-15-plus-auctions', label: 'iPhone 15 Plus', query: 'apple iphone 15 plus' },
  { key: 'iphone-15-pro-auctions', label: 'iPhone 15 Pro', query: 'apple iphone 15 pro' },
  { key: 'iphone-15-pro-max-auctions', label: 'iPhone 15 Pro Max', query: 'apple iphone 15 pro max' },
  { key: 'iphone-16-auctions', label: 'iPhone 16', query: 'apple iphone 16' },
  { key: 'iphone-16-plus-auctions', label: 'iPhone 16 Plus', query: 'apple iphone 16 plus' },
  { key: 'iphone-16-pro-auctions', label: 'iPhone 16 Pro', query: 'apple iphone 16 pro' },
  { key: 'iphone-16-pro-max-auctions', label: 'iPhone 16 Pro Max', query: 'apple iphone 16 pro max' },
  { key: 'iphone-16e-auctions', label: 'iPhone 16e', query: 'apple iphone 16e' },
  { key: 'iphone-16-e-auctions', label: 'iPhone 16 e', query: 'apple iphone 16 e' },
  { key: 'iphone-17-auctions', label: 'iPhone 17', query: 'apple iphone 17' },
  { key: 'iphone-17-pro-auctions', label: 'iPhone 17 Pro', query: 'apple iphone 17 pro' },
  { key: 'iphone-17-pro-max-auctions', label: 'iPhone 17 Pro Max', query: 'apple iphone 17 pro max' },
  { key: 'iphone-17e-auctions', label: 'iPhone 17e', query: 'apple iphone 17e' },
  { key: 'iphone-17-e-auctions', label: 'iPhone 17 e', query: 'apple iphone 17 e' },
  { key: 'iphone-air-auctions', label: 'iPhone Air', query: 'apple iphone air' },
] as const;

const QUICK_AUCTION_QUERY_GROUPS = {
  ipad: [
    { key: 'ipad-target-auctions', label: 'iPad objetivo', query: 'apple ipad' },
  ],
  macbook: [
    { key: 'macbook-target-auctions', label: 'MacBook Apple Silicon', query: 'apple macbook' },
    { key: 'macbook-m1-auctions', label: 'MacBook M1', query: 'apple macbook m1' },
    { key: 'macbook-m2-auctions', label: 'MacBook M2', query: 'apple macbook m2' },
    { key: 'macbook-m3-auctions', label: 'MacBook M3', query: 'apple macbook m3' },
    { key: 'macbook-m4-auctions', label: 'MacBook M4', query: 'apple macbook m4' },
    { key: 'macbook-m5-auctions', label: 'MacBook M5', query: 'apple macbook m5' },
    { key: 'macbook-a2337-auctions', label: 'MacBook A2337', query: 'apple a2337' },
    { key: 'macbook-a2338-auctions', label: 'MacBook A2338', query: 'apple a2338' },
    { key: 'macbook-a2681-auctions', label: 'MacBook A2681', query: 'apple a2681' },
    { key: 'macbook-a2941-auctions', label: 'MacBook A2941', query: 'apple a2941' },
    { key: 'macbook-a2442-auctions', label: 'MacBook A2442', query: 'apple a2442' },
    { key: 'macbook-a2485-auctions', label: 'MacBook A2485', query: 'apple a2485' },
    { key: 'macbook-a2779-auctions', label: 'MacBook A2779', query: 'apple a2779' },
    { key: 'macbook-a2780-auctions', label: 'MacBook A2780', query: 'apple a2780' },
    { key: 'macbook-a2918-auctions', label: 'MacBook A2918', query: 'apple a2918' },
    { key: 'macbook-a2991-auctions', label: 'MacBook A2991', query: 'apple a2991' },
    { key: 'macbook-a2992-auctions', label: 'MacBook A2992', query: 'apple a2992' },
    { key: 'macbook-a3112-auctions', label: 'MacBook A3112', query: 'apple a3112' },
    { key: 'macbook-a3113-auctions', label: 'MacBook A3113', query: 'apple a3113' },
    { key: 'macbook-a3114-auctions', label: 'MacBook A3114', query: 'apple a3114' },
    { key: 'macbook-a3185-auctions', label: 'MacBook A3185', query: 'apple a3185' },
    { key: 'macbook-a3186-auctions', label: 'MacBook A3186', query: 'apple a3186' },
    { key: 'macbook-a3240-auctions', label: 'MacBook A3240', query: 'apple a3240' },
    { key: 'macbook-a3241-auctions', label: 'MacBook A3241', query: 'apple a3241' },
    { key: 'macbook-a3401-auctions', label: 'MacBook A3401', query: 'apple a3401' },
    { key: 'macbook-a3403-auctions', label: 'MacBook A3403', query: 'apple a3403' },
    { key: 'macbook-a3426-auctions', label: 'MacBook A3426', query: 'apple a3426' },
    { key: 'macbook-a3427-auctions', label: 'MacBook A3427', query: 'apple a3427' },
    { key: 'macbook-a3428-auctions', label: 'MacBook A3428', query: 'apple a3428' },
    { key: 'macbook-a3429-auctions', label: 'MacBook A3429', query: 'apple a3429' },
    { key: 'macbook-a3434-auctions', label: 'MacBook A3434', query: 'apple a3434' },
    { key: 'macbook-a3448-auctions', label: 'MacBook A3448', query: 'apple a3448' },
    { key: 'macbook-a3449-auctions', label: 'MacBook A3449', query: 'apple a3449' },
  ],
  'apple-watch-ultra': [
    { key: 'apple-watch-ultra-auctions', label: 'Apple Watch Ultra', query: 'apple watch ultra' },
  ],
} as const;

const QUICK_DESKTOP_AUCTION_QUERY_GROUPS = [
  { key: 'imac-target-auctions', label: 'iMac Apple Silicon', query: 'apple imac', family: 'imac' },
  { key: 'mac-mini-target-auctions', label: 'Mac mini Apple Silicon', query: 'apple mac mini', family: 'mac-mini' },
] as const;

const QUICK_WATCH_AUCTION_QUERY_GROUPS = [
  { key: 'apple-watch-series-11-auctions', label: 'Apple Watch Series 11', query: 'apple watch series 11', family: 'apple-watch' },
  { key: 'apple-watch-se-3-auctions', label: 'Apple Watch SE 3', query: 'apple watch se 3', family: 'apple-watch' },
] as const;

let ebayTokenCache: { token: string; expiresAt: number; source: 'refresh_token' | 'client_credentials' | 'static' } | null = null;
let ebayTokenRequestPromise: Promise<string> | null = null;
let ebayRefreshTokenCooldown: { key: string; retryAfter: number; reason: string } | null = null;
let ebayBrowseRequestQueue: Promise<void> = Promise.resolve();
let ebayBrowseCooldownUntil = 0;
let ebayBrowseRateLimitLoggedUntil = 0;
let ebayAppleAuctionsCache = new Map<string, { expiresAt: number; data: any }>();
let ebayTrustedStoreItemCache = new Map<string, { expiresAt: number; matched: boolean }>();
let ebayTrustedStoreSellerCache = new Map<string, { expiresAt: number; matched: boolean }>();
const TM_STORAGE_DIR = join(process.cwd(), 'storage', 'tm');
const TM_TEMPLATE_FILE = join(TM_STORAGE_DIR, 'ebay-template.html');
const TM_TEMPLATE_META_FILE = join(TM_STORAGE_DIR, 'ebay-template.meta.json');
const TM_AMAZON_TEMPLATE_FILE = join(TM_STORAGE_DIR, 'amazon-template.html');
const TM_AMAZON_TEMPLATE_META_FILE = join(TM_STORAGE_DIR, 'amazon-template.meta.json');
const EBAY_STORE_FEED_FILE = join(process.cwd(), 'storage', 'ebay-store-feed.json');
const TRUSTED_STORE_SYSTEM_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const TRUSTED_STORE_SYSTEM_FETCH_TIMEOUT_MS = 4500;

const normalizeEnvToken = (val: string) =>
  val.trim().replace(/^"+|"+$/g, '').replace(/\s+/g, '');

const isTruthyEnvFlag = (value?: string) =>
  ['1', 'true', 'yes', 'si', 'sí', 'on'].includes(
    String(value || '').trim().toLowerCase(),
  );

const getRefreshTokenCooldownKey = (clientId: string, refreshToken: string) =>
  `${clientId}:${refreshToken.length}:${refreshToken.slice(-12)}`;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchWithTimeout = async (url: string, init: RequestInit = {}, timeoutMs = 5000) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
};

const getEbayBrowseMinIntervalMs = () => {
  const raw = Number(process.env.EBAY_BROWSE_MIN_INTERVAL_MS || 650);
  return Math.max(0, Number.isFinite(raw) ? raw : 650);
};

const getEbayAppleAuctionsCacheTtlMs = () => {
  const raw = Number(process.env.EBAY_APPLE_AUCTIONS_CACHE_TTL_MS || 60_000);
  return Math.max(0, Number.isFinite(raw) ? raw : 60_000);
};

class EbayTokenRequestError extends Error {
  status: number;
  body: string;
  errorCode: string;

  constructor(status: number, body: string) {
    super(`No se pudo obtener token eBay (${status})`);
    this.status = status;
    this.body = body;
    this.errorCode = (() => {
      try {
        return String(JSON.parse(body)?.error || '');
      } catch {
        return '';
      }
    })();
  }
}

class EbayBrowseRateLimitError extends BadRequestException {
  retryAfterMs: number;
  resetAt?: string;

  constructor(retryAfterMs: number, resetAt?: string) {
    super(
      resetAt
        ? `eBay agoto el limite de Browse API. Vuelve a intentar despues de ${resetAt}.`
        : `eBay esta limitando requests. Espera ${Math.ceil(retryAfterMs / 1000)}s e intenta de nuevo.`,
    );
    this.retryAfterMs = retryAfterMs;
    this.resetAt = resetAt;
  }
}

const runEbayBrowseRequest = async <T,>(request: () => Promise<T>): Promise<T> => {
  let releaseQueue: () => void = () => {};
  const previous = ebayBrowseRequestQueue;
  ebayBrowseRequestQueue = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });

  await previous.catch(() => undefined);

  try {
    const cooldownMs = ebayBrowseCooldownUntil - Date.now();
    if (cooldownMs > 0) {
      throw new EbayBrowseRateLimitError(cooldownMs);
    }

    const result = await request();
    await wait(getEbayBrowseMinIntervalMs());
    return result;
  } finally {
    releaseQueue();
  }
};

const getEbayBrowseRateLimits = async (token: string) => {
  const url = new URL(`${getEbayApiRoot()}/developer/analytics/v1_beta/rate_limit/`);
  url.searchParams.set('api_name', 'browse');
  url.searchParams.set('api_context', 'buy');
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
};

const getBrowseRetryFromRateLimits = (data: any) => {
  const rates = summarizeEbayBrowseRateLimits(data).resources;
  const exhausted = rates.find((rate: any) => Number.isFinite(rate.remaining) && rate.remaining <= 0 && rate.reset);
  const resetMs = exhausted ? Date.parse(exhausted.reset) : 0;
  if (!resetMs || resetMs <= Date.now()) return null;
  return {
    retryAfterMs: Math.max(60_000, resetMs - Date.now()),
    resetAt: exhausted.reset,
  };
};

const summarizeEbayBrowseRateLimits = (data: any) => {
  const limits = Array.isArray(data?.rateLimits) ? data.rateLimits : [];
  const resources = limits.flatMap((limit: any) =>
    (Array.isArray(limit?.resources) ? limit.resources : []).flatMap((resource: any) =>
      (Array.isArray(resource?.rates) ? resource.rates : []).map((rate: any) => {
        const count = Number(rate?.count);
        const limitCount = Number(rate?.limit);
        const remaining = Number(rate?.remaining);
        const reset = String(rate?.reset || '');
        const usedPercent = Number.isFinite(limitCount) && limitCount > 0 && Number.isFinite(count)
          ? Math.min(100, Math.max(0, (count / limitCount) * 100))
          : null;
        return {
          apiContext: String(limit?.apiContext || ''),
          apiName: String(limit?.apiName || ''),
          resource: String(resource?.name || ''),
          count: Number.isFinite(count) ? count : null,
          limit: Number.isFinite(limitCount) ? limitCount : null,
          remaining: Number.isFinite(remaining) ? remaining : null,
          reset,
          timeWindow: Number.isFinite(Number(rate?.timeWindow)) ? Number(rate.timeWindow) : null,
          usedPercent,
        };
      }),
    ),
  );

  const primary =
    resources.find((resource: any) => /item_summary|search/i.test(resource.resource)) ||
    resources.find((resource: any) => resource.remaining != null || resource.limit != null) ||
    null;

  return {
    primary,
    resources,
  };
};

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
    throw new EbayTokenRequestError(res.status, errText);
  }
  return (await res.json()) as { access_token: string; expires_in: number };
};

const getEbayAccessToken = async (): Promise<string> => {
  if (ebayTokenRequestPromise) {
    return ebayTokenRequestPromise;
  }

  ebayTokenRequestPromise = getEbayAccessTokenFresh().finally(() => {
    ebayTokenRequestPromise = null;
  });

  return ebayTokenRequestPromise;
};

const getEbayAccessTokenFresh = async (): Promise<string> => {
  const now = Date.now();
  if (ebayTokenCache && now < ebayTokenCache.expiresAt - 60_000) {
    return ebayTokenCache.token;
  }

  const clientId = normalizeEnvToken(process.env.EBAY_CLIENT_ID || '');
  const clientSecret = normalizeEnvToken(process.env.EBAY_CLIENT_SECRET || '');
  const refreshToken = normalizeEnvToken(process.env.EBAY_REFRESH_TOKEN || '');
  const scopeEnv = normalizeEnvToken(process.env.EBAY_SCOPE || '');
  const defaultScope = scopeEnv || 'https://api.ebay.com/oauth/api_scope';
  const refreshCooldownKey = refreshToken ? getRefreshTokenCooldownKey(clientId, refreshToken) : '';
  const refreshTokenOnCooldown =
    refreshCooldownKey &&
    ebayRefreshTokenCooldown?.key === refreshCooldownKey &&
    now < ebayRefreshTokenCooldown.retryAfter;
  const preferRefreshToken = isTruthyEnvFlag(process.env.EBAY_PREFER_REFRESH_TOKEN);
  let lastTokenError: any = null;

  const tryRefreshToken = async () => {
    if (!clientId || !clientSecret || !refreshToken || refreshTokenOnCooldown) return null;
    try {
      const data = await requestEbayToken({
        grantType: 'refresh_token',
        refreshToken,
        scope: scopeEnv || undefined,
      });
      ebayRefreshTokenCooldown = null;
      ebayTokenCache = {
        token: data.access_token,
        expiresAt: now + Number(data.expires_in || 0) * 1000,
        source: 'refresh_token',
      };
      return ebayTokenCache.token;
    } catch (err) {
      lastTokenError = err;
      if ((err as any)?.errorCode === 'invalid_grant' && refreshCooldownKey) {
        ebayRefreshTokenCooldown = {
          key: refreshCooldownKey,
          retryAfter: now + 6 * 60 * 60 * 1000,
          reason: 'invalid_grant',
        };
      }
      console.log('[eBay] refresh token failed, using next token strategy', {
        reason: (err as any)?.message || err,
      });
      return null;
    }
  };

  const tryClientCredentials = async () => {
    if (!clientId || !clientSecret) return null;
    try {
      const data = await requestEbayToken({
        grantType: 'client_credentials',
        scope: defaultScope,
      });
      ebayTokenCache = {
        token: data.access_token,
        expiresAt: now + Number(data.expires_in || 0) * 1000,
        source: 'client_credentials',
      };
      return ebayTokenCache.token;
    } catch (err) {
      lastTokenError = err;
      console.log(
        refreshToken
          ? '[eBay] client_credentials failed, trying refresh token'
          : '[eBay] client_credentials failed, using next token strategy',
        {
          reason: (err as any)?.message || err,
        },
      );
      return null;
    }
  };

  if (preferRefreshToken) {
    const refreshResult = await tryRefreshToken();
    if (refreshResult) return refreshResult;
    const clientResult = await tryClientCredentials();
    if (clientResult) return clientResult;
  } else {
    const clientResult = await tryClientCredentials();
    if (clientResult) return clientResult;
    const refreshResult = await tryRefreshToken();
    if (refreshResult) return refreshResult;
  }

  const fallback = normalizeEnvToken(process.env.EBAY_ACCESS_TOKEN || '');
  if (!fallback) {
    throw new BadRequestException(
      lastTokenError?.message || 'Faltan credenciales eBay (refresh o access token)',
    );
  }
  console.log('[eBay] access token len', { len: fallback.length, tail: fallback.slice(-6) });
  ebayTokenCache = {
    token: fallback,
    expiresAt: now + 15 * 60 * 1000,
    source: 'static',
  };
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
  if (condition === 'used') return 'conditionIds:{3000}';
  if (condition === 'full') return 'conditionIds:{1000|1500|3000}';
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

const EBAY_QUERY_KNOWN_TERMS = [
  'apple',
  'iphone',
  'ipad',
  'macbook',
  'watch',
  'airpods',
  'airpod',
  'imac',
  'mac',
  'mini',
  'pro',
  'max',
  'plus',
  'air',
  'ultra',
];

const editDistanceWithin = (left: string, right: string, maxDistance: number) => {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > maxDistance) return false;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    let rowMin = current[0];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      const value = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost,
      );
      current[j] = value;
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > maxDistance) return false;
    previous = current;
  }

  return previous[right.length] <= maxDistance;
};

const correctEbayQueryToken = (token: string) => {
  const normalized = String(token || '').trim().toLowerCase();
  if (!normalized || normalized.length < 3 || /^\d+$/.test(normalized)) return normalized;
  if (EBAY_QUERY_KNOWN_TERMS.includes(normalized)) return normalized;

  const partial = EBAY_QUERY_KNOWN_TERMS.find((term) =>
    normalized.length >= 3 &&
    term.includes(normalized) &&
    term.length - normalized.length <= 2,
  );
  if (partial) return partial;

  const maxDistance = normalized.length >= 5 ? 2 : 1;
  const fuzzy = EBAY_QUERY_KNOWN_TERMS.find((term) =>
    Math.abs(term.length - normalized.length) <= maxDistance &&
    editDistanceWithin(normalized, term, maxDistance),
  );
  return fuzzy || normalized;
};

const splitJoinedEbayQueryToken = (token: string) => {
  const normalized = normalizeLookupText(token);
  const modelMatch = normalized.match(/^(iphone|ipad)(\d{1,2})(promax|pro|max|plus|mini|e)?$/);
  if (modelMatch) {
    const suffix = modelMatch[3] === 'promax' ? ['pro', 'max'] : modelMatch[3] ? [modelMatch[3]] : [];
    return [modelMatch[1], modelMatch[2], ...suffix];
  }

  const macbookMatch = normalized.match(/^(macbook)(air|pro)$/);
  if (macbookMatch) return [macbookMatch[1], macbookMatch[2]];

  return [normalized].filter(Boolean);
};

const buildSpacedEbayQueryText = (rawQuery?: string) =>
  normalizeLookupText(String(rawQuery || '').trim())
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((token) => splitJoinedEbayQueryToken(token))
    .join(' ')
    .trim();

const buildLenientEbayQueryVariants = (rawQuery?: string) => {
  const original = String(rawQuery || 'apple').trim() || 'apple';
  const normalized = normalizeLookupText(original);
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const spaced = buildSpacedEbayQueryText(original);
  const corrected = tokens.map((token) => correctEbayQueryToken(token)).join(' ').trim();
  const correctedSpaced = buildSpacedEbayQueryText(corrected);
  const hasAppleProductTerm = /\b(?:iphone|ipad|macbook|watch|airpods?|imac|mac)\b/.test(corrected);
  const variants = [
    original,
    spaced,
    corrected,
    correctedSpaced,
    hasAppleProductTerm && !/\bapple\b/.test(corrected) ? `apple ${corrected}` : '',
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  return Array.from(new Set(variants));
};

const normalizeCompactLookupText = (val: string) =>
  normalizeLookupText(val).replace(/[\s.+-]+/g, '');

const PAWN_SOURCE_COMPACT_MARKERS = [
  'pawn',
  'pawnshop',
  'pawnbroker',
  'paymore',
  'cashamerica',
  'cashngold',
  'cashandgold',
  'firstcash',
  'cashland',
  'buyandsell',
  'jewelryandloan',
  'jewelryloan',
  'loanandjewelry',
  'loancompany',
] as const;

const TRUSTED_STORE_SYSTEM_COMPACT_MARKERS = [
  'bravostoresystems',
  'bravostore',
  'poweredbybravo',
  'poweredbybravostoresystems',
  'buya',
  'poweredbybuya',
  'pawnmaster',
  'pawnshoplive',
] as const;

const hasPawnStoreNameSignal = (text: string) => {
  const normalized = normalizeLookupText(text);
  const compact = normalizeCompactLookupText(text);
  if (!compact) return false;
  if (PAWN_SOURCE_COMPACT_MARKERS.some((marker) => compact.includes(marker))) return true;
  return /\b(?:pawn|pawn\s*shop|pawn\s*broker|paymore|buy\s*and\s*sell|jewelry\s*and\s*loan|loan\s*and\s*jewelry)\b/.test(normalized);
};

const matchesPawnSellerName = (item: any) => {
  const sellerText = [
    item?.storeName,
    item?.seller,
    item?.seller?.username,
    item?.seller?.userId,
  ].join(' ');
  return hasPawnStoreNameSignal(sellerText);
};

const matchesKnownPawnStore = (item: any, storeEntries?: ReadonlyArray<EbayStoreEntry>) => {
  if (!Array.isArray(storeEntries) || storeEntries.length === 0) return false;
  const itemSellers = [
    item?.seller,
    item?.seller?.username,
    item?.seller?.userId,
  ].map((value) => normalizeCompactLookupText(String(value || ''))).filter(Boolean);
  const itemText = normalizeCompactLookupText([
    item?.storeName,
    item?.storeUrl,
    item?.itemWebUrl,
  ].join(' '));

  return storeEntries.some((entry) => {
    const seller = normalizeCompactLookupText(entry.seller);
    const storeName = normalizeCompactLookupText(entry.storeName);
    const storeUrl = normalizeCompactLookupText(entry.storeUrl);
    const originalUrl = normalizeCompactLookupText(entry.originalUrl || '');
    if (seller && itemSellers.includes(seller)) return true;
    return Boolean(
      (storeName && itemText.includes(storeName)) ||
      (storeUrl && itemText.includes(storeUrl)) ||
      (originalUrl && itemText.includes(originalUrl)),
    );
  });
};

const matchesPawnInventoryCode = (item: any) =>
  /\((?=[A-Za-z0-9]{9}\))(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{9}\)/.test(String(item?.title || ''));

const matchesPawnSource = (item: any, storeEntries?: ReadonlyArray<EbayStoreEntry>) =>
  matchesKnownPawnStore(item, storeEntries) || matchesPawnSellerName(item) || matchesPawnInventoryCode(item);

const TRUSTED_STORE_SYSTEM_PATTERNS = [
  /\bpowered\s+by\s+bravo\s+store\s+systems\b/i,
  /\bbravo\s+store\s+systems\b/i,
  /\bbravostoresystems\b/i,
  /\bbuya\.com\b/i,
  /\bpowered\s+by\s+buya\b/i,
  /\bpawnmaster\b/i,
  /\bpawn\s+master\b/i,
  /\bpawnshoplive\b/i,
] as const;

const getTrustedStoreSellerKey = (item: any) =>
  normalizeCompactLookupText([
    item?.seller,
    item?.seller?.username,
    item?.seller?.userId,
  ].join(' '));

const getTrustedStoreItemKey = (item: any) =>
  String(item?.itemId || item?.legacyItemId || item?.itemWebUrl || '').trim();

const getCachedTrustedStoreMatch = (
  cache: Map<string, { expiresAt: number; matched: boolean }>,
  key: string,
) => {
  if (!key) return null;
  const cached = cache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return cached.matched;
};

const setCachedTrustedStoreMatch = (
  cache: Map<string, { expiresAt: number; matched: boolean }>,
  key: string,
  matched: boolean,
) => {
  if (!key) return;
  cache.set(key, {
    matched,
    expiresAt: Date.now() + TRUSTED_STORE_SYSTEM_CACHE_TTL_MS,
  });
};

const hasTrustedStoreSystemText = (text: string) =>
  TRUSTED_STORE_SYSTEM_PATTERNS.some((pattern) => pattern.test(text)) ||
  TRUSTED_STORE_SYSTEM_COMPACT_MARKERS.some((marker) =>
    normalizeCompactLookupText(text).includes(marker),
  );

const matchesTrustedStoreSystemText = (item: any) => {
  const text = [
    item?.storeName,
    item?.storeUrl,
    item?.seller,
    item?.seller?.username,
    item?.seller?.userId,
    item?.itemWebUrl,
  ].join(' ');
  return hasTrustedStoreSystemText(text);
};

const fetchEbayItemHtmlForTrustedStoreCheck = async (item: any) => {
  const rawUrl = String(item?.itemWebUrl || '').trim();
  if (!rawUrl) return '';
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return '';
  }
  if (!/(^|\.)ebay\.com$/i.test(parsed.hostname)) return '';
  const res = await fetchWithTimeout(parsed.toString(), {
    redirect: 'follow',
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
    },
  }, TRUSTED_STORE_SYSTEM_FETCH_TIMEOUT_MS);
  if (!res.ok) return '';
  return res.text().catch(() => '');
};

const matchesTrustedStoreSystemSource = async (item: any) => {
  if (matchesTrustedStoreSystemText(item)) return true;
  if (!isTrustedStoreHtmlBackfillEnabled()) return false;

  const sellerKey = getTrustedStoreSellerKey(item);
  const cachedSeller = getCachedTrustedStoreMatch(ebayTrustedStoreSellerCache, sellerKey);
  if (cachedSeller === true) return true;

  const itemKey = getTrustedStoreItemKey(item);
  const cachedItem = getCachedTrustedStoreMatch(ebayTrustedStoreItemCache, itemKey);
  if (cachedItem !== null) return cachedItem;

  let matched = false;
  try {
    const html = await fetchEbayItemHtmlForTrustedStoreCheck(item);
    matched = hasTrustedStoreSystemText(html);
  } catch {
    matched = false;
  }

  setCachedTrustedStoreMatch(ebayTrustedStoreItemCache, itemKey, matched);
  if (matched) setCachedTrustedStoreMatch(ebayTrustedStoreSellerCache, sellerKey, true);
  return matched;
};

const matchesPreferredStoreSource = async (item: any) => {
  if (matchesPawnSource(item)) return true;
  return matchesTrustedStoreSystemSource(item);
};

const getTrustedStoreCandidatePriority = (item: any) => {
  const text = [
    item?.title,
    item?.storeName,
    item?.storeUrl,
    item?.seller,
    item?.seller?.username,
    item?.seller?.userId,
    item?.itemWebUrl,
  ].join(' ');
  const compact = normalizeCompactLookupText(text);
  let score = 0;
  if (TRUSTED_STORE_SYSTEM_COMPACT_MARKERS.some((marker) => compact.includes(marker))) score += 100;
  if (hasPawnStoreNameSignal(text)) score += 80;
  if (/\b(?:cash|loan|jewelry|gold|buy\s*sell|buy\s*and\s*sell)\b/i.test(text)) score += 30;
  return score;
};

const collectPreferredStoreItems = async (params: {
  items: any[];
  seen: Set<string>;
  storeEntries?: ReadonlyArray<EbayStoreEntry>;
}) => {
  const accepted: any[] = [];
  const trustedCandidates: Array<{ item: any; key: string }> = [];

  for (const item of Array.isArray(params.items) ? params.items : []) {
    const key = String(item?.itemId || item?.legacyItemId || item?.itemWebUrl || '').trim();
    if (!key || params.seen.has(key)) continue;
    if (matchesPawnSource(item, params.storeEntries)) {
      params.seen.add(key);
      accepted.push(item);
      continue;
    }
    trustedCandidates.push({ item, key });
  }

  const maxChecks = Math.min(
    trustedCandidates.length,
    getTrustedStoreBackfillMaxChecks(),
  );
  if (maxChecks <= 0) return accepted;

  const candidatesToCheck = [...trustedCandidates]
    .sort((left, right) =>
      getTrustedStoreCandidatePriority(right.item) - getTrustedStoreCandidatePriority(left.item),
    )
    .slice(0, maxChecks);
  const concurrency = getTrustedStoreCheckConcurrency();
  for (let index = 0; index < candidatesToCheck.length; index += concurrency) {
    const batch = candidatesToCheck.slice(index, index + concurrency);
    const matches = await Promise.all(
      batch.map((candidate) => matchesTrustedStoreSystemSource(candidate.item)),
    );
    for (let matchIndex = 0; matchIndex < batch.length; matchIndex += 1) {
      if (!matches[matchIndex]) continue;
      const candidate = batch[matchIndex];
      if (params.seen.has(candidate.key)) continue;
      params.seen.add(candidate.key);
      accepted.push(candidate.item);
    }
  }

  return accepted;
};

const matchesAppleProductTitle = (item: any) => {
  const titleText = normalizeLookupText(item?.title || '');

  if (/\b(?:samsung|galaxy|google\s+pixel|motorola|moto|xiaomi|huawei|oneplus|oppo|vivo|dell|lenovo|thinkpad|hp|hewlett\s+packard|asus|acer|microsoft|surface|sony|nokia|lg)\b/.test(titleText)) return false;
  if (isExcludedAppleProductTitle(titleText)) return false;
  if (isAccessoryTitle(titleText)) return false;
  return isLikelyAppleDeviceTitle(titleText, 'ipad') ||
    isLikelyAppleDeviceTitle(titleText, 'iphone') ||
    isLikelyAppleDeviceTitle(titleText, 'macbook') ||
    hasTargetImacSignal(titleText) ||
    hasTargetMacMiniSignal(titleText) ||
    hasTargetAppleWatchSignal(titleText);
};

const isTruthyQueryFlag = (value?: string) =>
  ['1', 'true', 'yes', 'si', 'sí', 'on'].includes(
    normalizeLookupText(String(value || '')),
  );

const getPawnScanMaxPages = (fallback: number) => {
  const raw = Number(process.env.EBAY_PAWN_SCAN_MAX_PAGES || fallback);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(1, Math.min(20, raw));
};

const normalizeEbayScanPages = (value?: number | string | null) => {
  const raw = Number(value || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.max(1, Math.min(20, Math.floor(raw)));
};

const normalizeMinSellerReviews = (value?: number | string | null) => {
  const raw = Number(value || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.floor(raw);
};

const getTrustedStoreBackfillMaxChecks = () => {
  const raw = Number(process.env.EBAY_TRUSTED_STORE_BACKFILL_MAX_CHECKS || 0);
  return Math.max(0, Math.min(150, Number.isFinite(raw) ? raw : 0));
};

const getTrustedStoreCheckConcurrency = () => {
  const raw = Number(process.env.EBAY_TRUSTED_STORE_CHECK_CONCURRENCY || 5);
  return Math.max(1, Math.min(10, Number.isFinite(raw) ? raw : 5));
};

const isTrustedStoreHtmlBackfillEnabled = () =>
  isTruthyQueryFlag(process.env.EBAY_TRUSTED_STORE_HTML_BACKFILL || '');

const getEbayCacheItemKey = (item: any) =>
  String(item?.itemId || item?.legacyItemId || item?.itemWebUrl || '').trim();

const normalizeEbayViewedKey = (value: any) =>
  String(value || '').trim().slice(0, 255);

const getEbayCacheListedAt = (item: any) => {
  const raw = String(item?.itemOriginDate || item?.itemCreationDate || item?.itemEndDate || '').trim();
  if (!raw) return null;
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? new Date(ts) : null;
};

const buildEbaySearchCacheKey = (params?: {
  query?: string;
  condition?: string;
  buyingOptions?: string;
  sort?: string;
  pawnOnly?: boolean;
  minSellerReviews?: number;
}) => {
  const minSellerReviews = normalizeMinSellerReviews(params?.minSellerReviews);
  const payload = {
    query: normalizeLookupText(String(params?.query || 'apple').trim() || 'apple'),
    condition: normalizeLookupText(String(params?.condition || '')),
    buyingOptions: normalizeLookupText(String(params?.buyingOptions || '')),
    sort: normalizeLookupText(String(params?.sort || 'newlyListed')),
    pawnOnly: Boolean(params?.pawnOnly),
    minSellerReviews,
    sourceRule: params?.pawnOnly || minSellerReviews > 0 ? 'target-apple-devices-v12' : 'default',
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
};

const loadCachedEbaySearchItems = async (
  repo: Repository<EbaySearchItem> | undefined,
  params: {
    searchKey: string;
    skip: number;
    take: number;
  },
) => {
  if (!repo) return { items: [], total: 0, hasMore: false };
  const skip = Math.max(0, Number(params.skip) || 0);
  const take = Math.min(200, Math.max(1, Number(params.take) || 140));
  const [rows, total] = await repo.findAndCount({
    where: { searchKey: params.searchKey },
    order: { listedAt: 'DESC', updatedAt: 'DESC', id: 'DESC' },
    skip,
    take,
  });
  return {
    items: rows.map((row) => row.item).filter(Boolean),
    total,
    hasMore: skip + rows.length < total,
  };
};

const loadExistingEbayCacheItemKeys = async (
  repo: Repository<EbaySearchItem> | undefined,
  searchKey: string,
  keys: string[],
) => {
  if (!repo || keys.length === 0) return new Set<string>();
  const uniqueKeys = Array.from(new Set(keys.filter(Boolean)));
  if (uniqueKeys.length === 0) return new Set<string>();
  const rows = await repo.find({
    select: { itemKey: true } as any,
    where: { searchKey, itemKey: In(uniqueKeys) },
  });
  return new Set(rows.map((row) => row.itemKey));
};

const saveEbaySearchItemsToCache = async (
  repo: Repository<EbaySearchItem> | undefined,
  params: {
    searchKey: string;
    query?: string;
    condition?: string;
    buyingOptions?: string;
    sort?: string;
    pawnOnly?: boolean;
    ebayOffset?: number;
    items: any[];
  },
) => {
  if (!repo || !Array.isArray(params.items) || params.items.length === 0) {
    return { duplicateDetected: false, saved: 0, newKeys: [] as string[] };
  }

  const uniqueItemsByKey = new Map<string, any>();
  for (const item of params.items) {
    const itemKey = getEbayCacheItemKey(item);
    if (!itemKey || uniqueItemsByKey.has(itemKey)) continue;
    uniqueItemsByKey.set(itemKey, item);
  }
  const keys = Array.from(uniqueItemsByKey.keys());
  if (keys.length === 0) return { duplicateDetected: false, saved: 0, newKeys: [] as string[] };

  const existing = await repo.find({
    select: { itemKey: true } as any,
    where: { searchKey: params.searchKey, itemKey: In(keys) },
  });
  const existingKeys = new Set(existing.map((row) => row.itemKey));
  const newKeys = keys.filter((key) => !existingKeys.has(key));
  const keysToPersist = params.pawnOnly ? newKeys : keys;
  const now = new Date();
  const rows = keysToPersist
    .map((itemKey) => {
      const item = uniqueItemsByKey.get(itemKey);
      if (!item) return null;
      return repo.create({
        searchKey: params.searchKey,
        itemKey,
        query: String(params.query || 'apple').trim() || 'apple',
        condition: String(params.condition || '').trim() || null,
        buyingOptions: String(params.buyingOptions || '').trim() || null,
        sort: String(params.sort || 'newlyListed').trim() || 'newlyListed',
        pawnOnly: Boolean(params.pawnOnly),
        ebayOffset: Number.isFinite(Number(params.ebayOffset)) ? Number(params.ebayOffset) : null,
        listedAt: getEbayCacheListedAt(item),
        item,
        updatedAt: now,
      });
    })
    .filter((row): row is EbaySearchItem => Boolean(row));

  if (rows.length > 0) {
    await repo.upsert(rows, {
      conflictPaths: ['searchKey', 'itemKey'],
      skipUpdateIfNoValuesChanged: true,
    });
  }

  return {
    duplicateDetected: existingKeys.size > 0,
    saved: rows.length,
    newKeys,
  };
};

const loadEbaySearchState = async (
  repo: Repository<EbaySearchState> | undefined,
  searchKey: string,
) => {
  if (!repo) return null;
  return repo.findOne({ where: { searchKey } });
};

const saveEbaySearchState = async (
  repo: Repository<EbaySearchState> | undefined,
  params: { searchKey: string; nextEbayOffset: number; lastCacheTotal?: number },
) => {
  if (!repo) return null;
  const current = await repo.findOne({ where: { searchKey: params.searchKey } });
  const nextEbayOffset = Math.max(
    Number(current?.nextEbayOffset || 0),
    Math.max(0, Number(params.nextEbayOffset || 0)),
  );
  const row = current || repo.create({ searchKey: params.searchKey });
  row.nextEbayOffset = nextEbayOffset;
  if (Number.isFinite(Number(params.lastCacheTotal))) {
    row.lastCacheTotal = Math.max(Number(row.lastCacheTotal || 0), Number(params.lastCacheTotal || 0));
  }
  return repo.save(row);
};

const getTitleKeywordTokenGroups = (rawQuery?: string) => {
  const normalized = normalizeLookupText(String(rawQuery || 'apple').trim() || 'apple');
  const groups: string[][] = [];
  const seen = new Set<string>();
  const addGroup = (tokens: string[]) => {
    const cleaned = tokens.map((token) => normalizeLookupText(token)).filter(Boolean);
    const key = cleaned.join(' ');
    if (!key || seen.has(key)) return;
    seen.add(key);
    groups.push(cleaned);
  };

  const rawTokens = normalized.split(/\s+/).filter(Boolean);
  addGroup(rawTokens);

  const spacedTokens = buildSpacedEbayQueryText(normalized).split(/\s+/).filter(Boolean);
  addGroup(spacedTokens);
  addGroup(spacedTokens.map((token) => correctEbayQueryToken(token)));

  return groups;
};

const titleIncludesKeywordToken = (titleText: string, titleCompact: string, token: string) => {
  if (titleText.includes(token)) return true;
  const compactToken = normalizeCompactLookupText(token);
  return Boolean(compactToken && titleCompact.includes(compactToken));
};

const matchesTitleKeywordQuery = (title: string, rawQuery?: string) => {
  const titleText = normalizeLookupText(title);
  const titleCompact = normalizeCompactLookupText(title);
  const tokenGroups = getTitleKeywordTokenGroups(rawQuery);
  if (!tokenGroups.length) return true;
  return tokenGroups.some((tokens) =>
    tokens.every((token) => titleIncludesKeywordToken(titleText, titleCompact, token)),
  );
};

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
  'charging station',
  'charging stand',
  'charging dock',
  'cable',
  'adapter',
  'stand',
  'dock',
  'station',
  'holder',
  'mount',
  'cradle',
  'protector',
  'screen protector',
  'stylus',
  'pen',
  'band',
  'strap',
  'loop',
  'replacement',
  'housing',
  'digitizer',
  'lcd',
  'glass',
  'empty box',
  'box only',
  'bundle only',
];

const APPLE_ACCESSORY_PRIMARY_PATTERNS = [
  /^(?:apple\s+)?(?:(?:laptop|tablet|phone|cell\s+phone|smartphone)\s+)?(?:case|sleeve|cover|folio|keyboard|magic keyboard|smart folio|screen protector|protector|pencil|charger|adapter|cable|bag|shell|skin|band|strap|loop|stand|dock|station|holder|mount|cradle|housing|digitizer|lcd|glass)\b/,
  /\b(?:laptop|tablet|phone|cell\s+phone|smartphone)\s+(?:case|sleeve|cover|folio|keyboard|screen protector|protector|bag|shell)\b/,
  /\b(?:case|sleeve|cover|folio|keyboard|screen protector|protector|bag|shell|band|strap|loop|stand|dock|station|holder|mount|cradle)\b.{0,80}\bfor\s+(?:new\s+)?(?:the\s+)?(?:apple\s+)?(?:macbook|ipad|iphone|watch|airpods?)\b/,
  /\b(?:charging|wireless|alarm\s+clock).{0,40}(?:station|stand|dock|base|holder|mount|cradle)\b/,
  /\b(?:station|stand|dock|base|holder|mount|cradle)\b.{0,80}\b(?:iphone|ipad|apple\s+watch|watch|airpods?)\b/,
  /\b(?:3\s*-?\s*in\s*-?\s*1|2\s*-?\s*in\s*-?\s*1|multi\s*device)\b.{0,80}\b(?:charger|charging|station|stand|dock)\b/,
  /\b(?:empty\s+box|box\s+only|no\s+(?:airpods?|iphone|ipad|watch|macbook)|packaging\s+only|retail\s+box\s+only)\b/,
  /\bcompatible with\b/,
  /\bdesigned for\b/,
  /\bfits?\s+(?:new\s+)?(?:the\s+)?(?:apple\s+)?(?:macbook|ipad|iphone|watch|airpods?)\b/,
  /\bfor\s+(?:new\s+)?(?:the\s+)?(?:apple\s+)?(?:macbook|ipad|iphone|watch|airpods?)\b/,
  /\breplacement\b/,
];

const EXCLUDED_APPLE_PRODUCT_TITLE_PATTERNS = [
  /\b(?:empty\s+box|box\s+only|no\s+(?:airpods?|iphone|ipad|watch|macbook)|packaging\s+only|retail\s+box\s+only)\b/,
  /\b(?:charging|wireless|alarm\s+clock).{0,50}(?:station|stand|dock|base|holder|mount|cradle)\b/,
  /\b(?:station|stand|dock|base|holder|mount|cradle)\b.{0,100}\b(?:iphone|ipad|apple\s+watch|watch|airpods?)\b/,
  /\b(?:3\s*-?\s*in\s*-?\s*1|2\s*-?\s*in\s*-?\s*1|multi\s*device)\b.{0,100}\b(?:charger|charging|station|stand|dock)\b/,
] as const;

const isExcludedAppleProductTitle = (title: string) => {
  const normalized = normalizeLookupText(title);
  return EXCLUDED_APPLE_PRODUCT_TITLE_PATTERNS.some((pattern) => pattern.test(normalized));
};

const TARGET_MACBOOK_MODEL_NUMBERS = [
  'a2337', 'a2681', 'a2941', 'a3113', 'a3114', 'a3240', 'a3241', 'a3448', 'a3449',
  'a2338', 'a2442', 'a2485', 'a2779', 'a2780', 'a2918', 'a2991', 'a2992', 'a3112',
  'a3185', 'a3186', 'a3401', 'a3403', 'a3426', 'a3427', 'a3428', 'a3429', 'a3434',
] as const;

const TARGET_MACBOOK_ORDER_CODES = [
  'mgn63', 'mgn73', 'mly33', 'mly43', 'mqkw3', 'mrxv3', 'mrxw3', 'mryu3', 'mc6t4',
  'mc6u4', 'mc7a4', 'mdhh4', 'mdhj4', 'mdvq4', 'myda2', 'mkgr3', 'mkgt3', 'mk1e3',
  'mk1h3', 'mneh3', 'mphe3', 'mphf3', 'mphg3', 'mnw83', 'mnwa3', 'mtl73', 'mrx33',
  'mrx43', 'mrx53', 'mrw13', 'mrw33', 'muw63', 'mw2w3', 'mx2e3', 'mx2f3', 'mx2g3',
  'mx2t3', 'mx2v3', 'mx2w3', 'mde44', 'mgdn4', 'mgdp4', 'mgdq4', 'mge44', 'mge74',
  'mge94',
] as const;

const TARGET_IPAD_MODEL_NUMBERS = [
  'a2377', 'a2301', 'a2459', 'a2460', 'a2378', 'a2379', 'a2461', 'a2462',
  'a2759', 'a2435', 'a2761', 'a2762', 'a2436', 'a2764', 'a2437', 'a2766',
  'a2836', 'a2837', 'a3006', 'a2925', 'a2926', 'a3007',
  'a3357', 'a3358', 'a3359', 'a3360', 'a3361', 'a3362',
  'a2316', 'a2324', 'a2072', 'a2325', 'a2588', 'a2589', 'a2591',
  'a2902', 'a2903', 'a2904', 'a2898', 'a2899', 'a2900',
  'a3266', 'a3267', 'a3270', 'a3268', 'a3269', 'a3271',
  'a3459', 'a3460', 'a3463', 'a3461', 'a3462', 'a3464',
  'a3354', 'a3355', 'a3356',
] as const;

const TARGET_IPAD_ORDER_CODES = [
  'mhqt3', 'mhmu3', 'mhw63', 'mhwh3', 'mhng3', 'mhnt3', 'mhr53', 'mhrg3',
  'mnxe3', 'mp563', 'mnyd3', 'mnyp3', 'mnxq3', 'mp5y3', 'mp1y3', 'mp293',
  'mvv93', 'mvw23', 'mvwa3', 'mvx33', 'mvxt3', 'mvy23', 'mdwl4', 'me2p4',
  'me6f4', 'mdyk4', 'me7x4', 'me8q4', 'myfn2', 'myhy2', 'mygx2', 'myhm2',
  'mm9c3', 'mm6r3', 'mm753', 'muwd3', 'muxe3', 'muxx3', 'mv283', 'mv6r3',
  'mv793', 'mc9x4', 'mcfw4', 'mcge4', 'mcnj4', 'mcj24', 'mcjk4', 'mh314',
  'mh794', 'mh8c4', 'mh5p4', 'mh9e4', 'mh9x4', 'md3y4', 'md7f4', 'md7u4',
] as const;

const TARGET_IPHONE_MODEL_NUMBERS = [
  'a2481', 'a2626', 'a2628', 'a2629', 'a2630',
  'a2482', 'a2631', 'a2633', 'a2634', 'a2635',
  'a2483', 'a2636', 'a2638', 'a2639', 'a2640',
  'a2484', 'a2641', 'a2643', 'a2644', 'a2645',
  'a2649', 'a2881', 'a2882', 'a2883', 'a2884',
  'a2632', 'a2885', 'a2886', 'a2887', 'a2888',
  'a2650', 'a2889', 'a2890', 'a2891', 'a2892',
  'a2651', 'a2893', 'a2894', 'a2895', 'a2896',
  'a2846', 'a3089', 'a3090', 'a3092',
  'a2847', 'a3093', 'a3094', 'a3096',
  'a2848', 'a3101', 'a3102', 'a3104',
  'a2849', 'a3105', 'a3106', 'a3108',
  'a3081', 'a3286', 'a3287', 'a3288',
  'a3082', 'a3289', 'a3290', 'a3291',
  'a3083', 'a3292', 'a3293', 'a3294',
  'a3084', 'a3295', 'a3296', 'a3297',
  'a3212', 'a3408', 'a3409', 'a3410',
  'a3258', 'a3519', 'a3520', 'a3521',
  'a3256', 'a3522', 'a3523', 'a3524',
  'a3257', 'a3525', 'a3526', 'a3527',
  'a3260', 'a3516', 'a3517', 'a3518',
  'a3575', 'a3634', 'a3635',
] as const;
const TARGET_IPHONE_ORDER_CODES: readonly string[] = [];
const IPHONE_13_MINI_MODEL_NUMBERS = ['a2481', 'a2626', 'a2628', 'a2629', 'a2630'] as const;
const BLOCKED_IPHONE_PATTERN =
  /\b(?:carrier|network|sim|activation|icloud|finance|financed|mdm)\s*locked\b|\b(?:verizon|at\s*&?\s*t|att|t[\s-]*mobile|sprint|cricket|boost|metro(?:pcs)?|xfinity|spectrum|tracfone|straight\s+talk|us\s+cellular)\b|\bbad\s+esn\b|\bblacklisted\b|\bnot\s+unlocked\b/;

const TARGET_IMAC_MODEL_NUMBERS = ['a2438', 'a2439', 'a2873', 'a2874', 'a3137', 'a3247'] as const;
const TARGET_IMAC_ORDER_CODES = [
  'mjv93', 'mgpk3', 'mqrc3', 'mqrq3', 'mwuf3', 'mwue3', 'mwug3', 'mwuc3', 'mwv13',
] as const;

const TARGET_MAC_MINI_MODEL_NUMBERS = ['a2348', 'a2686', 'a2816', 'a3238', 'a3239'] as const;
const TARGET_MAC_MINI_ORDER_CODES = ['mgnr3', 'mgnt3', 'mnh73', 'mu9d3', 'mu9e3', 'mcyt4'] as const;

const TARGET_APPLE_WATCH_SERIES_11_MODEL_NUMBERS = ['a3331', 'a3333', 'a3450', 'a3451', 'a3335', 'a3337', 'a3452', 'a3453'] as const;
const TARGET_APPLE_WATCH_SE3_MODEL_NUMBERS = ['a3324', 'a3325', 'a3391', 'a3392', 'a3326', 'a3328', 'a3327', 'a3329'] as const;
const TARGET_APPLE_WATCH_ULTRA_MODEL_NUMBERS = ['a2622', 'a2684', 'a2859', 'a2986', 'a2987', 'a3281', 'a3282'] as const;
const APPLE_WATCH_ULTRA_MODEL_NUMBER_PATTERN = /\ba(?:2622|2684|2859|2986|2987|3281|3282)\b/;

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

const hasAnyTargetModelNumber = (normalized: string, modelNumbers: readonly string[]) =>
  modelNumbers.some((modelNumber) => new RegExp(`\\b${modelNumber}\\b`).test(normalized));

const hasAnyTargetOrderCode = (title: string, orderCodes: readonly string[]) => {
  const compact = normalizeCompactLookupText(title);
  return orderCodes.some((orderCode) => compact.includes(orderCode));
};

const titleHasTargetIdentifier = (
  title: string,
  modelNumbers: readonly string[],
  orderCodes: readonly string[],
) => {
  const normalized = normalizeLookupText(title);
  return hasAnyTargetModelNumber(normalized, modelNumbers) || hasAnyTargetOrderCode(title, orderCodes);
};

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

const MACBOOK_CHIP_PATTERN = /\b(?:m[1-5](?:\s+(?:pro|max|ultra))?|a18\s*pro)\b/;
const MACBOOK_MODEL_NUMBER_PATTERN = /\ba(?:2337|2338|2442|2485|2681|2779|2780|2918|2941|2991|2992|3112|3113|3114|3185|3186|3240|3241|3401|3403|3426|3427|3428|3429|3434|3448|3449)\b/;
const MACBOOK_INTEL_PATTERN = /\b(?:intel|core\s+i[3579]|i[3579][-\s]?\d{3,5})\b/;

const hasTargetMacBookSignal = (normalized: string) => {
  const compact = normalizeCompactLookupText(normalized);
  const hasTargetModel = hasAnyTargetModelNumber(normalized, TARGET_MACBOOK_MODEL_NUMBERS);
  const hasTargetOrder = TARGET_MACBOOK_ORDER_CODES.some((orderCode) => compact.includes(orderCode));
  if (normalized.includes('macbook neo') || /\bneo\b/.test(normalized) && /\ba18\s*pro\b/.test(normalized)) return true;
  if (MACBOOK_CHIP_PATTERN.test(normalized)) return true;
  if (hasTargetModel) return true;
  if (hasTargetOrder && !MACBOOK_INTEL_PATTERN.test(normalized)) return true;
  if (compact.includes('fk1e3lla') && !MACBOOK_INTEL_PATTERN.test(normalized)) return true;
  return false;
};

const hasTargetIpadSignal = (title: string) => {
  const normalized = normalizeLookupText(title);
  if (titleHasTargetIdentifier(title, TARGET_IPAD_MODEL_NUMBERS, TARGET_IPAD_ORDER_CODES)) return true;
  if (/\bm[1-5]\b/.test(normalized) && /\bipad\s+pro\b|\bipad\s+air\b/.test(normalized)) return true;
  if (/\bipad\s+pro\b/.test(normalized)) {
    if (/\b11(?:\.\d+)?\s*(?:inch|in|")?\b/.test(normalized) && /\b(?:3rd|third|4th|fourth|m[1-5])\b/.test(normalized)) return true;
    if (/\b12\.9(?:\s*(?:inch|in|"))?\b/.test(normalized) && /\b(?:5th|fifth|6th|sixth|m[1-5])\b/.test(normalized)) return true;
    if (/\b13(?:\s*(?:inch|in|"))?\b/.test(normalized) && /\bm[4-5]\b/.test(normalized)) return true;
  }
  if (/\bipad\s+air\b/.test(normalized)) {
    if (/\b(?:4th|fourth|5th|fifth|m[1-4])\b/.test(normalized)) return true;
    if (/\b(?:11|13)(?:\s*(?:inch|in|"))?\b/.test(normalized) && /\bm[2-4]\b/.test(normalized)) return true;
  }
  if (/\bipad\b/.test(normalized) && !/\b(?:pro|air|mini)\b/.test(normalized)) {
    return /\b(?:11th|eleventh|a16)\b/.test(normalized);
  }
  return false;
};

const hasTargetIphoneSignal = (title: string) => {
  const normalized = normalizeLookupText(title);
  if (/\bmini\b/.test(normalized)) return false;
  if (hasAnyTargetModelNumber(normalized, IPHONE_13_MINI_MODEL_NUMBERS)) return false;
  if (BLOCKED_IPHONE_PATTERN.test(normalized)) return false;
  if (titleHasTargetIdentifier(title, TARGET_IPHONE_MODEL_NUMBERS, TARGET_IPHONE_ORDER_CODES)) return true;
  return /\biphone\s*(?:13|14|15|16|17)\b/.test(normalized) ||
    /\biphone\s*(?:16|17)\s*e\b|\b(?:16|17)e\b/.test(normalized) ||
    /\biphone\s+air\b/.test(normalized);
};

const hasTargetImacSignal = (title: string) => {
  const normalized = normalizeLookupText(title);
  if (MACBOOK_INTEL_PATTERN.test(normalized)) return false;
  if (titleHasTargetIdentifier(title, TARGET_IMAC_MODEL_NUMBERS, TARGET_IMAC_ORDER_CODES)) return true;
  return (/\bi\s*mac\b|\bimac\b/.test(normalized)) && /\bm[1-5]\b/.test(normalized);
};

const hasTargetMacMiniSignal = (title: string) => {
  const normalized = normalizeLookupText(title);
  if (MACBOOK_INTEL_PATTERN.test(normalized)) return false;
  if (titleHasTargetIdentifier(title, TARGET_MAC_MINI_MODEL_NUMBERS, TARGET_MAC_MINI_ORDER_CODES)) return true;
  return (/\bmac\s*mini\b|\bmacmini\b/.test(normalized)) && /\bm[1-5]\b/.test(normalized);
};

const hasTargetAppleWatchSignal = (title: string) => {
  const normalized = normalizeLookupText(title);
  if (isAccessoryTitle(normalized)) return false;
  const modelNumbers = [
    ...TARGET_APPLE_WATCH_SERIES_11_MODEL_NUMBERS,
    ...TARGET_APPLE_WATCH_SE3_MODEL_NUMBERS,
    ...TARGET_APPLE_WATCH_ULTRA_MODEL_NUMBERS,
  ];
  if (hasAnyTargetModelNumber(normalized, modelNumbers)) return true;
  const isWatch = /\bapple\s+watch\b|\biwatch\b/.test(normalized);
  if (!isWatch) return false;
  if (/\bultra(?:\s*[123])?\b/.test(normalized)) return true;
  if (/\bse\s*3\b|\bse\s*third\b|\bse\s*3rd\b/.test(normalized)) return true;
  if (/\b(?:series\s*)?11\b|\bs11\b/.test(normalized)) {
    const statedSize = normalized.match(/\b(\d{2})\s*mm\b/)?.[1];
    return !statedSize || statedSize === '42' || statedSize === '46';
  }
  return false;
};

const isLikelyAppleDeviceTitle = (title: string, family: 'ipad' | 'iphone' | 'macbook') => {
  const normalized = normalizeLookupText(title);
  if (isAccessoryTitle(normalized, family)) return false;
  if (family === 'ipad') return normalized.includes('ipad') && hasTargetIpadSignal(title);
  if (family === 'iphone') {
    return (normalized.includes('iphone') && hasTargetIphoneSignal(title)) ||
      titleHasTargetIdentifier(title, TARGET_IPHONE_MODEL_NUMBERS, TARGET_IPHONE_ORDER_CODES);
  }
  if (!hasTargetMacBookSignal(normalized)) return false;
  return normalized.includes('macbook') ||
    /\bmac\s*book\b/.test(normalized) ||
    normalized.includes('mac laptop') ||
    normalized.includes('apple laptop') ||
    titleHasTargetIdentifier(title, TARGET_MACBOOK_MODEL_NUMBERS, TARGET_MACBOOK_ORDER_CODES);
};

const getAppleCollectionFamilyLabel = (family: string) => {
  const labels: Record<string, string> = {
    ipad: 'iPad',
    iphone: 'iPhone',
    macbook: 'MacBook',
    airpods: 'AirPods',
    'apple-watch': 'Apple Watch',
    'apple-watch-ultra': 'Apple Watch Ultra',
    imac: 'iMac',
    'mac-mini': 'Mac mini',
    accessories: 'Accesorios',
  };
  return labels[family] || family;
};

const getRequiredChipFromEntryKey = (key: string) => {
  const match = String(key || '').toLowerCase().match(/\bm[1-5]\b/);
  return match ? match[0] : '';
};

const titleHasRequiredAppleChip = (normalized: string, key: string) => {
  const requiredChip = getRequiredChipFromEntryKey(key);
  if (!requiredChip) return true;
  return new RegExp(`\\b${requiredChip}\\b`).test(normalized);
};

const isWatchUltraAccessoryTitle = (normalized: string) =>
  /^apple\s+watch\s+ultra(?:\s+\d)?\s+(?:band|strap|loop)\b/.test(normalized) ||
  /\b(?:band|strap|loop)\b.{0,80}\bfor\s+(?:apple\s+)?watch\s+ultra\b/.test(normalized);

const isLikelyExtendedAppleTitle = (title: string, family: string, key = '') => {
  const normalized = normalizeLookupText(title);
  if (family === 'airpods') return /\bair\s*pods?\b|\bairpods?\b/.test(normalized);
  if (family === 'apple-watch') return hasTargetAppleWatchSignal(title);
  if (family === 'apple-watch-ultra') {
    if (isAccessoryTitle(normalized)) return false;
    if (isWatchUltraAccessoryTitle(normalized)) return false;
    return hasAnyTargetModelNumber(normalized, TARGET_APPLE_WATCH_ULTRA_MODEL_NUMBERS) ||
      APPLE_WATCH_ULTRA_MODEL_NUMBER_PATTERN.test(normalized) ||
      ((/\bapple\s+watch\b|\biwatch\b/.test(normalized)) && /\bultra\b/.test(normalized));
  }
  if (family === 'imac') return hasTargetImacSignal(title) && titleHasRequiredAppleChip(normalized, key);
  if (family === 'mac-mini') return hasTargetMacMiniSignal(title) && titleHasRequiredAppleChip(normalized, key);
  if (family === 'accessories') {
    const appleSignal = /\bapple\b|\bmacbook\b|\bipad\b|\biphone\b|\bwatch\b|\bmagsafe\b|\bmagic\s+(?:keyboard|mouse|trackpad)\b|\bapple\s+pencil\b/.test(normalized);
    const accessorySignal = hasAppleAccessoryKeyword(normalized) ||
      /\b(?:magic keyboard|magic mouse|magic trackpad|apple pencil|magsafe|charger|cable|adapter|case|cover|folio|sleeve|band|strap)\b/.test(normalized);
    return appleSignal && accessorySignal;
  }
  return false;
};

const matchesAppleFamilyEntry = (
  title: string,
  entry: { family: string; key: string },
) => {
  const normalized = normalizeLookupText(title);
  if (entry.family === 'ipad' || entry.family === 'iphone' || entry.family === 'macbook') {
    if (!isLikelyAppleDeviceTitle(normalized, entry.family)) return false;
  } else {
    return isLikelyExtendedAppleTitle(normalized, entry.family, entry.key);
  }

  if (entry.family === 'iphone') {
    const key = String(entry.key || '').toLowerCase();
    const numberMatch = key.match(/iphone-(13|14|15|16|17)/);
    if (!numberMatch) return true;
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

const isTrustedEbaySeller = (item: any) => {
  const feedbackPercentage = parsePriceValue(item?.sellerFeedbackPercentage ?? item?.seller?.feedbackPercentage);
  const feedbackScore = parsePriceValue(item?.sellerFeedbackScore ?? item?.seller?.feedbackScore);
  if (feedbackPercentage !== null && Number.isFinite(feedbackPercentage) && feedbackPercentage <= 0) return false;
  if (feedbackScore !== null && Number.isFinite(feedbackScore) && feedbackScore <= 0) return false;
  return true;
};

const getSellerFeedbackScore = (item: any) =>
  parsePriceValue(item?.sellerFeedbackScore ?? item?.seller?.feedbackScore);

const matchesMinSellerReviews = (item: any, minSellerReviews?: number) => {
  const minReviews = normalizeMinSellerReviews(minSellerReviews);
  if (minReviews <= 0) return true;
  const feedbackScore = getSellerFeedbackScore(item);
  return feedbackScore !== null && Number.isFinite(feedbackScore) && feedbackScore >= minReviews;
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
      const sellerStoreName = String(item?.seller?.storeName || item?.seller?.storefront?.storeName || '').trim();
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
        storeName: storeMeta?.storeName || sellerStoreName || seller,
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
    .filter((item: any) => isTrustedEbaySeller(item))
    .sort((a: any, b: any) => {
      const timeA = Date.parse(a.itemOriginDate || a.itemCreationDate || '') || 0;
      const timeB = Date.parse(b.itemOriginDate || b.itemCreationDate || '') || 0;
      return timeB - timeA;
    });
};

const getEbayListedTime = (item: any) =>
  Date.parse(item?.itemOriginDate || item?.itemCreationDate || '') || 0;

const sortEbayByListedDate = (items: any[], sort?: string) => {
  const oldestFirst = String(sort || '').trim() === 'oldestListed';
  return [...(Array.isArray(items) ? items : [])].sort((a: any, b: any) => {
    const timeA = getEbayListedTime(a);
    const timeB = getEbayListedTime(b);
    if (timeA !== timeB) return oldestFirst ? timeA - timeB : timeB - timeA;
    return String(a?.itemId || a?.legacyItemId || '').localeCompare(String(b?.itemId || b?.legacyItemId || ''));
  });
};

const getEbayNewestSortedOffsetFromOldestCursor = (
  total: number,
  limit: number,
  oldestCursor: number,
) => {
  const totalCount = Math.max(0, Number(total) || 0);
  const pageLimit = Math.max(1, Number(limit) || 1);
  if (totalCount <= 0) return null;
  const pageDepth = Math.floor(Math.max(0, Number(oldestCursor) || 0) / pageLimit);
  const deepestOffset = Math.floor((totalCount - 1) / pageLimit) * pageLimit;
  const offset = deepestOffset - pageDepth * pageLimit;
  return offset >= 0 ? offset : null;
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
  const requestedOffset = Math.max(0, Number.isFinite(offsetRaw) ? offsetRaw : 0);
  const offset = requestedOffset - (requestedOffset % limit);
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

  const res = await runEbayBrowseRequest(() =>
    fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      },
    }),
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    if (res.status === 429) {
      const retryAfterSeconds = Number(res.headers.get('retry-after') || 0);
      let retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds * 1000
        : 10 * 60_000;
      let resetAt: string | undefined;
      const rateLimits = await getEbayBrowseRateLimits(token).catch(() => null);
      const browseRetry = getBrowseRetryFromRateLimits(rateLimits);
      if (browseRetry) {
        retryAfterMs = browseRetry.retryAfterMs;
        resetAt = browseRetry.resetAt;
      }
      ebayBrowseCooldownUntil = Date.now() + retryAfterMs;
      if (Date.now() > ebayBrowseRateLimitLoggedUntil) {
        console.log('[eBay] browse rate limited', { status: res.status, retryAfterMs, resetAt, body: errText.slice(0, 400) });
        ebayBrowseRateLimitLoggedUntil = Date.now() + 30_000;
      }
      throw new EbayBrowseRateLimitError(retryAfterMs, resetAt);
    }
    console.log('[eBay] browse store feed status', { status: res.status, body: errText.slice(0, 400) });
    throw new BadRequestException(`No se pudo obtener items eBay (${res.status})`);
  }

  const data = await res.json();
  const rawItems = Array.isArray(data?.itemSummaries) ? data.itemSummaries : [];
  const items = normalizeEbayBrowseItems({
    items: rawItems,
    storeEntries: params?.storeEntries,
  });

  const result = {
    query,
    sort,
    limit,
    offset,
    total: Number(data?.total || items.length || 0),
    nextOffset: offset + limit,
    hasMore: offset + limit < Number(data?.total || items.length || 0),
    rawCount: rawItems.length,
    sellers: params?.storeEntries || [],
    items,
  };
  return result;
};

const fetchEbayStoreFeed = async (params?: {
  query?: string;
  limit?: number;
  offset?: number;
  condition?: string;
  buyingOptions?: string;
  storeEntries?: ReadonlyArray<EbayStoreEntry>;
}) => {
  const targetLimitRaw = Number(params?.limit || 140);
  const targetOffsetRaw = Number(params?.offset || 0);
  const targetLimit = Math.min(200, Math.max(1, Number.isFinite(targetLimitRaw) ? targetLimitRaw : 140));
  const targetOffset = Math.max(0, Number.isFinite(targetOffsetRaw) ? targetOffsetRaw : 0);
  const queryVariants = buildLenientEbayQueryVariants(params?.query);
  const desiredCount = targetOffset + targetLimit + 1;
  const perQueryLimit = 200;
  const maxPages = 10;

  const collected: any[] = [];
  const seen = new Set<string>();
  let sort = 'newlyListed';
  let searchedTotal = 0;
  let exhausted = false;

  for (let page = 0; page < maxPages; page += 1) {
    const pageOffset = page * perQueryLimit;
    const results = await Promise.all(
      queryVariants.map((query) =>
        searchEbayItems({
          query,
          limit: perQueryLimit,
          offset: pageOffset,
          condition: params?.condition,
          buyingOptions: params?.buyingOptions,
          storeEntries: params?.storeEntries || [],
        }),
      ),
    );

    if (page === 0) {
      sort = results[0]?.sort || 'newlyListed';
      searchedTotal = results.reduce((sum, result) => sum + Number(result?.total || 0), 0);
    }

    const pageItems = results.flatMap((result) => (Array.isArray(result?.items) ? result.items : []));
    for (const item of pageItems) {
      if (!matchesTitleKeywordQuery(item?.title || '', params?.query)) continue;
      const key = String(item?.itemId || item?.legacyItemId || item?.itemWebUrl || '').trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      collected.push(item);
    }

    exhausted = results.every((result) => {
      const total = Number(result?.total || 0);
      const rawCount = Number(result?.rawCount ?? (Array.isArray(result?.items) ? result.items.length : 0));
      return rawCount < perQueryLimit || pageOffset + perQueryLimit >= total;
    });

    if (collected.length >= desiredCount || exhausted) break;
  }

  const merged = collected
    .sort((a: any, b: any) => {
      const timeA = Date.parse(a.itemOriginDate || a.itemCreationDate || '') || 0;
      const timeB = Date.parse(b.itemOriginDate || b.itemCreationDate || '') || 0;
      return timeB - timeA;
    });

  const items = merged.slice(targetOffset, targetOffset + targetLimit);
  const hasMore = merged.length > targetOffset + targetLimit || !exhausted;

  return {
    query: queryVariants[0],
    queryVariants,
    sort,
    limit: targetLimit,
    offset: targetOffset,
    total: hasMore || !exhausted ? Math.max(searchedTotal, merged.length) : merged.length,
    filteredTotal: merged.length,
    hasMore,
    sellers: params?.storeEntries || [],
    items,
  };
};

const fetchEbayCatalogSearch = async (params?: {
  query?: string;
  limit?: number;
  offset?: number;
  cacheOffset?: number;
  preferCache?: boolean;
  condition?: string;
  buyingOptions?: string;
  sort?: string;
  pawnOnly?: boolean;
  minSellerReviews?: number;
  scanPages?: number;
  cacheRepo?: Repository<EbaySearchItem>;
  stateRepo?: Repository<EbaySearchState>;
  storeEntries?: ReadonlyArray<EbayStoreEntry>;
}) => {
  const cacheRepo = params?.cacheRepo;
  const stateRepo = params?.stateRepo;
  const searchKey = buildEbaySearchCacheKey(params);
  const minSellerReviews = normalizeMinSellerReviews(params?.minSellerReviews);
  const cacheTake = Math.min(200, Math.max(1, Number(params?.limit || 140)));
  const cacheOffset = Math.max(0, Number(params?.cacheOffset || 0));
  const requestedSort = params?.sort === 'oldestListed' ? 'oldestListed' : 'newlyListed';
  const canServeCachedPage = requestedSort !== 'newlyListed';
  if (params?.preferCache && canServeCachedPage && cacheRepo) {
    const cached = await loadCachedEbaySearchItems(cacheRepo, {
      searchKey,
      skip: cacheOffset,
      take: cacheTake,
    });
    if (cached.items.length > 0) {
      return {
        query: String(params?.query || 'apple').trim() || 'apple',
        sort: params?.sort || 'newlyListed',
        limit: cacheTake,
        offset: Math.max(0, Number(params?.offset || 0)),
        nextOffset: Math.max(0, Number(params?.offset || 0)),
        cacheOffset,
        nextCacheOffset: cacheOffset + cached.items.length,
        nextPreferCache: cached.hasMore,
        cacheTotal: cached.total,
        fromCache: true,
        hasMore: true,
        sellers: [],
        items: cached.items,
      };
    }
  }

  if (!params?.pawnOnly && minSellerReviews <= 0) {
    const data = await searchEbayItems({
      query: params?.query,
      limit: params?.limit,
      offset: params?.offset,
      condition: params?.condition,
      buyingOptions: params?.buyingOptions,
      sort: params?.sort,
    });
    const deviceItems = data.items.filter((item: any) => matchesAppleProductTitle(item));
    const saved = await saveEbaySearchItemsToCache(cacheRepo, {
      searchKey,
      query: params?.query,
      condition: params?.condition,
      buyingOptions: params?.buyingOptions,
      sort: params?.sort,
      pawnOnly: false,
      ebayOffset: params?.offset,
      items: deviceItems,
    });
    const shouldReadCacheNext = saved.duplicateDetected && cacheOffset === 0;
    return {
      ...data,
      items: deviceItems,
      filteredTotal: deviceItems.length,
      cacheOffset,
      nextCacheOffset: shouldReadCacheNext ? data.items.length : cacheOffset,
      nextPreferCache: shouldReadCacheNext,
      cacheSaved: saved.saved,
      duplicateDetected: saved.duplicateDetected,
    };
  }

  const targetLimitRaw = Number(params?.limit || 140);
  const targetOffsetRaw = Number(params?.offset || 0);
  const targetLimit = Math.min(200, Math.max(1, Number.isFinite(targetLimitRaw) ? targetLimitRaw : 140));
  const requestedOffset = Math.max(0, Number.isFinite(targetOffsetRaw) ? targetOffsetRaw : 0);
  const scanOffset = requestedOffset;
  const desiredCount = targetLimit;
  const perPageLimit = 200;
  const shouldSkipCachedDuringScan = Boolean(
    cacheRepo &&
    params?.preferCache &&
    canServeCachedPage &&
    cacheOffset > 0,
  );
  const minPages = shouldSkipCachedDuringScan ? 10 : 1;
  const filteredScanFallback = minSellerReviews > 0 ? 20 : 10;
  const maxPages = shouldSkipCachedDuringScan
    ? Math.max(minPages, getPawnScanMaxPages(20))
    : Math.max(minPages, getPawnScanMaxPages(filteredScanFallback));
  const requestedScanPages = normalizeEbayScanPages(params?.scanPages);
  const effectiveMaxPages = requestedScanPages > 0 ? Math.min(maxPages, requestedScanPages) : maxPages;
  const collected: any[] = [];
  const seen = new Set<string>();
  let sort = 'newlyListed';
  let searchedTotal = 0;
  let exhausted = false;
  let nextOffset = scanOffset;
  let rateLimited = false;
  let oldestSearchTotal: number | null = null;

  if (requestedSort === 'oldestListed') {
    try {
      const initial = await searchEbayItems({
        query: params?.query,
        limit: 1,
        offset: 0,
        condition: params?.condition,
        buyingOptions: params?.buyingOptions,
        sort: 'newlyListed',
      });
      sort = initial?.sort || 'newlyListed';
      oldestSearchTotal = Number(initial?.total || 0);
      searchedTotal = oldestSearchTotal;
    } catch (err) {
      if (err instanceof EbayBrowseRateLimitError) {
        rateLimited = true;
      } else {
        throw err;
      }
    }
  }

  for (let page = 0; !rateLimited && page < effectiveMaxPages; page += 1) {
    const cursor = scanOffset + page * perPageLimit;
    const pageOffset = requestedSort === 'oldestListed'
      ? getEbayNewestSortedOffsetFromOldestCursor(oldestSearchTotal || 0, perPageLimit, cursor)
      : cursor;
    if (pageOffset == null) {
      exhausted = true;
      break;
    }
    nextOffset = requestedSort === 'oldestListed' ? cursor + perPageLimit : pageOffset + perPageLimit;
    let data: any;
    try {
      data = await searchEbayItems({
        query: params?.query,
        limit: perPageLimit,
        offset: pageOffset,
        condition: params?.condition,
        buyingOptions: params?.buyingOptions,
        sort: 'newlyListed',
      });
    } catch (err) {
      if (err instanceof EbayBrowseRateLimitError) {
        rateLimited = true;
        exhausted = false;
        break;
      }
      throw err;
    }

    if (page === 0) {
      sort = data?.sort || 'newlyListed';
      if (requestedSort !== 'oldestListed') searchedTotal = Number(data?.total || 0);
    }

    const pageItems = Array.isArray(data?.items) ? data.items : [];
    const rawCount = Number(data?.rawCount ?? pageItems.length);
    const pageAppleItems = pageItems.filter((item: any) => matchesAppleProductTitle(item));
    let pageCandidates: any[] = [];
    if (params?.pawnOnly) {
      pageCandidates = await collectPreferredStoreItems({
        items: pageAppleItems,
        seen,
        storeEntries: params?.storeEntries,
      });
    }
    if (minSellerReviews > 0) {
      for (const item of pageAppleItems) {
        if (!matchesMinSellerReviews(item, minSellerReviews)) continue;
        const key = getEbayCacheItemKey(item);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        pageCandidates.push(item);
      }
    }
    const pageCandidateKeys = pageCandidates.map((item: any) => getEbayCacheItemKey(item)).filter(Boolean);

    if (shouldSkipCachedDuringScan && pageCandidates.length > 0) {
      const cachedKeys = await loadExistingEbayCacheItemKeys(cacheRepo, searchKey, pageCandidateKeys);
      collected.push(...pageCandidates.filter((item) => !cachedKeys.has(getEbayCacheItemKey(item))));
    } else {
      collected.push(...pageCandidates);
    }

    const total = Number(data?.total || 0);
    exhausted = requestedSort === 'oldestListed'
      ? pageOffset === 0
      : total <= 0 || pageOffset + rawCount >= total;
    const scannedPages = page + 1;
    if ((scannedPages >= minPages && collected.length >= desiredCount) || exhausted) break;
  }

  const items = sortEbayByListedDate(collected, requestedSort);
  const hasMore = !exhausted;
  const saved = await saveEbaySearchItemsToCache(cacheRepo, {
    searchKey,
    query: params?.query,
    condition: params?.condition,
    buyingOptions: params?.buyingOptions,
    sort: requestedSort,
    pawnOnly: Boolean(params?.pawnOnly),
    ebayOffset: scanOffset,
    items,
  });
  await saveEbaySearchState(stateRepo, {
    searchKey,
    nextEbayOffset: nextOffset,
    lastCacheTotal: cacheOffset + items.length,
  });
  const newKeySet = new Set(saved.newKeys || []);
  const returnItems = shouldSkipCachedDuringScan
    ? items.filter((item) => newKeySet.has(getEbayCacheItemKey(item)))
    : items;
  const nextCacheOffset = cacheOffset + returnItems.length;
  const nextPreferCache = Boolean(
    canServeCachedPage &&
    cacheRepo &&
    cacheOffset > 0 &&
    saved.duplicateDetected,
  );

  return {
    query: String(params?.query || 'apple').trim() || 'apple',
    sort: requestedSort,
    limit: targetLimit,
    offset: scanOffset,
    nextOffset,
    cacheOffset,
    nextCacheOffset,
    nextPreferCache,
    cacheSaved: saved.saved,
    duplicateDetected: saved.duplicateDetected,
    total: hasMore ? Math.max(searchedTotal, scanOffset + returnItems.length) : scanOffset + returnItems.length,
    filteredTotal: returnItems.length,
    hasMore,
    rateLimited,
    minSellerReviews,
    sellers: [],
    items: returnItems,
  };
};

const fetchEbayAppleCollection = async (params?: {
  limit?: number;
  offset?: number;
  family?: 'all' | 'ipad' | 'iphone' | 'macbook' | 'apple-watch' | 'apple-watch-ultra' | 'imac' | 'mac-mini';
  condition?: string;
  buyingOptions?: string;
  sort?: string;
  pawnOnly?: boolean;
}) => {
  const targetLimitRaw = Number(params?.limit || 140);
  const targetOffsetRaw = Number(params?.offset || 0);
  const targetLimit = Math.min(200, Math.max(1, Number.isFinite(targetLimitRaw) ? targetLimitRaw : 140));
  const targetOffset = Math.max(0, Number.isFinite(targetOffsetRaw) ? targetOffsetRaw : 0);
  const requestedFamily = String(params?.family || 'all').trim().toLowerCase();
  const isAuctionSort = params?.sort === 'endingSoonest';
  const includeExtendedAll = requestedFamily === 'all' && !isAuctionSort;
  const includeDesktopAuctionAll = requestedFamily === 'all' && isAuctionSort;
  const includeWatchAuctionAll = requestedFamily === 'all' && isAuctionSort;
  const includeWatchUltraAuctionAll = requestedFamily === 'all' && isAuctionSort;
  const familyKeys = requestedFamily && requestedFamily !== 'all'
    ? [requestedFamily]
    : [
        'ipad',
        'iphone',
        'macbook',
        ...(includeExtendedAll ? ['airpods', 'apple-watch', 'imac', 'mac-mini'] : []),
        ...(includeDesktopAuctionAll ? ['imac', 'mac-mini'] : []),
        ...(includeWatchAuctionAll ? ['apple-watch'] : []),
        ...(includeWatchUltraAuctionAll ? ['apple-watch-ultra'] : []),
      ];
  const getAuctionQueryGroupsForFamily = (familyKey: string) => {
    if (isAuctionSort && familyKey === 'iphone') {
      const includeModelQueries = requestedFamily === 'iphone';
      const modelQueries = includeModelQueries
        ? TARGET_IPHONE_MODEL_NUMBERS.map((modelNumber) => ({
            key: `iphone-${modelNumber}-auctions`,
            label: `iPhone ${modelNumber.toUpperCase()}`,
            query: `apple ${modelNumber.toUpperCase()}`,
          }))
        : [];
      return [...IPHONE_AUCTION_QUERY_GROUPS, ...modelQueries];
    }
    if (isAuctionSort && familyKey in QUICK_AUCTION_QUERY_GROUPS) {
      return QUICK_AUCTION_QUERY_GROUPS[familyKey as keyof typeof QUICK_AUCTION_QUERY_GROUPS];
    }
    if (isAuctionSort && familyKey === 'apple-watch') return QUICK_WATCH_AUCTION_QUERY_GROUPS;
    if (isAuctionSort && (familyKey === 'imac' || familyKey === 'mac-mini')) {
      return QUICK_DESKTOP_AUCTION_QUERY_GROUPS.filter((entry) => entry.family === familyKey);
    }
    if (familyKey === 'macbook') return MACBOOK_AUCTION_QUERY_GROUPS;
    if (familyKey === 'apple-watch-ultra') return WATCH_ULTRA_AUCTION_QUERY_GROUPS;
    return APPLE_FAMILY_QUERY_GROUPS[familyKey as keyof typeof APPLE_FAMILY_QUERY_GROUPS] || [];
  };

  const queryEntries = [
    ...(requestedFamily && requestedFamily !== 'all'
      ? (getAuctionQueryGroupsForFamily(requestedFamily).map((entry) => ({
          ...entry,
          family: requestedFamily,
        })))
      : (['ipad', 'iphone', 'macbook'] as const).flatMap((familyKey) =>
          getAuctionQueryGroupsForFamily(familyKey).map((entry) => ({
            ...entry,
            family: familyKey,
          })),
        )),
    ...(includeExtendedAll ? EXTENDED_APPLE_ALL_QUERY_GROUPS : []),
    ...(includeDesktopAuctionAll ? QUICK_DESKTOP_AUCTION_QUERY_GROUPS : []),
    ...(includeWatchAuctionAll ? QUICK_WATCH_AUCTION_QUERY_GROUPS : []),
    ...(includeWatchUltraAuctionAll ? WATCH_ULTRA_AUCTION_QUERY_GROUPS.map((entry) => ({
      ...entry,
      family: 'apple-watch-ultra',
    })) : []),
  ];

  if (params?.pawnOnly) {
    const scanOffset = targetOffset;
    const desiredCount = targetLimit;
    const perQueryLimit = 200;
    const maxPages = getPawnScanMaxPages(10);
    const pawnQueryEntries = requestedFamily === 'all'
      ? [
          { key: 'ipad', label: 'iPad', query: 'ipad', family: 'all' as const },
          { key: 'iphone', label: 'iPhone', query: 'iphone unlocked', family: 'all' as const },
          { key: 'macbook', label: 'MacBook', query: 'macbook', family: 'all' as const },
          { key: 'airpods', label: 'AirPods', query: 'airpods', family: 'all' as const },
          { key: 'apple-watch', label: 'Apple Watch', query: 'apple watch', family: 'all' as const },
          { key: 'imac', label: 'iMac', query: 'imac', family: 'all' as const },
          { key: 'mac-mini', label: 'Mac mini', query: 'mac mini', family: 'all' as const },
          { key: 'cable-lots', label: 'Lotes de cables', query: 'apple cable lot', family: 'all' as const },
          { key: 'charger-lots', label: 'Lotes de cubos', query: 'apple charger lot', family: 'all' as const },
        ]
      : queryEntries;
    const collected: any[] = [];
    const seen = new Set<string>();
    const totalsByFamily = new Map<string, number>();
    let exhausted = false;
    let nextOffset = scanOffset;
    let searchedTotal = 0;
    let rateLimited = false;
    const requestedSort = params?.sort === 'oldestListed' ? 'oldestListed' : 'newlyListed';
    const oldestTotalsByEntry = new Map<string, number>();
    const entryKey = (entry: any) => `${entry.family || ''}:${entry.key || ''}:${entry.query || ''}`;

    if (requestedSort === 'oldestListed') {
      for (const entry of pawnQueryEntries) {
        try {
          const data = await searchEbayItems({
            query: entry.query,
            limit: 1,
            offset: 0,
            condition: params?.condition,
            buyingOptions: params?.buyingOptions,
            sort: 'newlyListed',
          });
          const total = Number(data?.total || 0);
          oldestTotalsByEntry.set(entryKey(entry), total);
          searchedTotal += total;
          totalsByFamily.set(
            entry.family,
            Math.max(totalsByFamily.get(entry.family) || 0, total),
          );
        } catch (err) {
          if (err instanceof EbayBrowseRateLimitError) {
            rateLimited = true;
            exhausted = false;
            break;
          }
          throw err;
        }
      }
    }

    for (let page = 0; !rateLimited && page < maxPages; page += 1) {
      const cursor = scanOffset + page * perQueryLimit;
      nextOffset = cursor + perQueryLimit;
      const results: Array<(typeof pawnQueryEntries)[number] & { total: number; rawCount: number; items: any[] }> = [];
      for (const entry of pawnQueryEntries) {
        const pageOffset = requestedSort === 'oldestListed'
          ? getEbayNewestSortedOffsetFromOldestCursor(
              oldestTotalsByEntry.get(entryKey(entry)) || 0,
              perQueryLimit,
              cursor,
            )
          : cursor;
        if (pageOffset == null) continue;
        try {
          const data = await searchEbayItems({
            query: entry.query,
            limit: perQueryLimit,
            offset: pageOffset,
            condition: params?.condition,
            buyingOptions: params?.buyingOptions,
            sort: 'newlyListed',
          });
          results.push({
            ...entry,
            total: Number(data?.total || 0),
            rawCount: Number(data?.rawCount || 0),
            items: Array.isArray(data?.items) ? data.items : [],
          });
        } catch (err) {
          if (err instanceof EbayBrowseRateLimitError) {
            rateLimited = true;
            exhausted = false;
            break;
          }
          throw err;
        }
      }

      if (!results.length) {
        exhausted = true;
        break;
      }

      for (const entry of results) {
        if (requestedSort !== 'oldestListed' && page === 0) {
          searchedTotal += Number(entry.total || 0);
          totalsByFamily.set(
            entry.family,
            Math.max(totalsByFamily.get(entry.family) || 0, Number(entry.total || 0)),
          );
        }

        const entryCandidates: any[] = [];
        for (const item of entry.items) {
          const family = entry.family === 'all' ? '' : entry.family;
          const enriched = {
            ...item,
            family,
            familyLabel: family === 'ipad' ? 'iPad' : family === 'iphone' ? 'iPhone' : family === 'macbook' ? 'MacBook' : 'Apple',
            familyEntryKey: entry.key,
          };
          if (family && !matchesAppleFamilyEntry(enriched?.title || '', {
            family,
            key: enriched?.familyEntryKey || '',
          })) continue;
          if (!matchesAppleProductTitle(enriched)) continue;
          entryCandidates.push(enriched);
        }

        if (entryCandidates.length > 0) {
          collected.push(...(await collectPreferredStoreItems({
            items: entryCandidates,
            seen,
          })));
        }
      }

      exhausted = rateLimited ? false : requestedSort === 'oldestListed'
        ? pawnQueryEntries.every((entry) =>
            getEbayNewestSortedOffsetFromOldestCursor(
              oldestTotalsByEntry.get(entryKey(entry)) || 0,
              perQueryLimit,
              nextOffset,
            ) == null,
          )
        : results.every((result) => {
            const total = Number(result?.total || 0);
            const rawCount = Number(result?.rawCount ?? (Array.isArray(result?.items) ? result.items.length : 0));
            return rawCount < perQueryLimit || cursor + perQueryLimit >= total;
          });

      if (collected.length >= desiredCount || exhausted || rateLimited) break;
    }

    const filteredMerged = sortEbayByListedDate(collected, requestedSort);
    const merged = filteredMerged;
    const hasMore = !exhausted;

    return {
      query: requestedFamily === 'all' ? 'Apple pawn collection' : `Apple ${requestedFamily} pawn`,
      sort: requestedSort,
      buyingOptions: params?.buyingOptions || '',
      condition: params?.condition || '',
      limit: targetLimit,
      offset: scanOffset,
      nextOffset,
      family: requestedFamily || 'all',
      total: hasMore ? Math.max(searchedTotal, scanOffset + filteredMerged.length) : scanOffset + filteredMerged.length,
      filteredTotal: filteredMerged.length,
      hasMore,
      rateLimited,
      groups: familyKeys.map((familyKey) => ({
        key: familyKey,
        label: getAppleCollectionFamilyLabel(familyKey),
        total: totalsByFamily.get(familyKey) || 0,
      })),
      items: merged,
    };
  }

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
  const filteredMerged = results
    .flatMap((entry) =>
      entry.items.map((item: any) => ({
        ...item,
        family: entry.family,
        familyLabel: getAppleCollectionFamilyLabel(entry.family),
        familyEntryKey: entry.key,
      })),
    )
    .filter((item: any) => matchesAppleFamilyEntry(item?.title || '', {
      family: item?.family,
      key: item?.familyEntryKey || '',
    }))
    .filter((item: any) => !params?.pawnOnly || matchesPawnSource(item))
    .filter((item: any) => !params?.pawnOnly || matchesAppleProductTitle(item))
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
    });

  const merged = filteredMerged.slice(targetOffset, targetOffset + targetLimit);
  const rawTotal = results.reduce((sum, entry) => sum + Number(entry.total || 0), 0);
  const hasMore = params?.pawnOnly
    ? filteredMerged.length > targetOffset + targetLimit
    : targetOffset + targetLimit < rawTotal;

  return {
    query: requestedFamily === 'all' ? 'Apple collection' : `Apple ${requestedFamily}`,
    sort: params?.sort || 'newlyListed',
    buyingOptions: params?.buyingOptions || '',
    condition: params?.condition || '',
    limit: targetLimit,
    offset: targetOffset,
    family: requestedFamily || 'all',
    total: params?.pawnOnly ? filteredMerged.length : rawTotal,
    filteredTotal: filteredMerged.length,
    hasMore,
    groups: familyKeys.map((familyKey) => ({
      key: familyKey,
      label: getAppleCollectionFamilyLabel(familyKey),
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
  family?: 'all' | 'ipad' | 'iphone' | 'macbook' | 'apple-watch' | 'apple-watch-ultra' | 'imac' | 'mac-mini';
  condition?: string;
}) => {
  const cacheTtlMs = getEbayAppleAuctionsCacheTtlMs();
  const cacheKey = JSON.stringify({
    limit: Number(params?.limit || 140),
    offset: Number(params?.offset || 0),
    family: String(params?.family || 'all').trim().toLowerCase(),
    condition: String(params?.condition || '').trim().toLowerCase(),
  });
  const cached = ebayAppleAuctionsCache.get(cacheKey);
  if (cacheTtlMs > 0 && cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const data = await fetchEbayAppleCollection({
    limit: params?.limit,
    offset: params?.offset,
    family: params?.family,
    condition: params?.condition,
    buyingOptions: 'AUCTION',
    sort: 'endingSoonest',
  });

  if (cacheTtlMs > 0) {
    ebayAppleAuctionsCache.set(cacheKey, {
      expiresAt: Date.now() + cacheTtlMs,
      data,
    });
    if (ebayAppleAuctionsCache.size > 100) {
      ebayAppleAuctionsCache = new Map(
        Array.from(ebayAppleAuctionsCache.entries()).filter(([, entry]) => entry.expiresAt > Date.now()),
      );
    }
  }

  return data;
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
    @InjectRepository(EbaySearchItem)
    private readonly ebaySearchItemsRepo: Repository<EbaySearchItem>,
    @InjectRepository(EbaySearchState)
    private readonly ebaySearchStateRepo: Repository<EbaySearchState>,
    @InjectRepository(EbayViewedItem)
    private readonly ebayViewedItemsRepo: Repository<EbayViewedItem>,
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

  @Get('utils/ebay/rate-limits')
  async getEbayRateLimits() {
    const token = await getEbayAccessToken();
    const data = await getEbayBrowseRateLimits(token);
    if (!data) {
      throw new BadRequestException('No se pudo consultar limites de eBay');
    }
    const browseRetry = getBrowseRetryFromRateLimits(data);
    const summary = summarizeEbayBrowseRateLimits(data);
    return {
      ok: true,
      browseExhausted: Boolean(browseRetry),
      retryAfterMs: browseRetry?.retryAfterMs || 0,
      resetAt: browseRetry?.resetAt || '',
      summary,
      data,
    };
  }

  @Get('utils/ebay/viewed')
  async getViewedEbayItems() {
    const rows = await this.ebayViewedItemsRepo.find({
      order: { viewedAt: 'DESC', id: 'DESC' },
      take: 5000,
    });
    return {
      total: rows.length,
      items: rows.map((row) => ({
        itemKey: row.itemKey,
        itemUrl: row.itemUrl,
        title: row.title,
        viewedAt: row.viewedAt,
      })),
    };
  }

  @Post('utils/ebay/viewed')
  async markViewedEbayItem(@Body() body: any) {
    const rawKeys = Array.isArray(body?.keys)
      ? body.keys
      : [body?.itemKey, body?.legacyItemId, body?.itemId, body?.itemUrl];
    const keys = Array.from(new Set(rawKeys.map(normalizeEbayViewedKey).filter(Boolean))) as string[];
    if (!keys.length) {
      throw new BadRequestException('Debes enviar itemKey o keys');
    }

    const viewedAt = new Date();
    const itemUrl = String(body?.itemUrl || '').trim().slice(0, 1000) || null;
    const title = String(body?.title || '').trim().slice(0, 500) || null;
    const rows = keys.map((itemKey) => this.ebayViewedItemsRepo.create({
      itemKey,
      itemUrl,
      title,
      viewedAt,
    }));

    await this.ebayViewedItemsRepo.upsert(rows, {
      conflictPaths: ['itemKey'],
      skipUpdateIfNoValuesChanged: true,
    });

    return {
      ok: true,
      viewedAt,
      keys,
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
    @Query('cacheOffset') cacheOffset?: string,
    @Query('preferCache') preferCache?: string,
    @Query('condition') condition?: string,
    @Query('buyingOptions') buyingOptions?: string,
    @Query('sort') sort?: string,
    @Query('pawnOnly') pawnOnly?: string,
    @Query('minSellerReviews') minSellerReviews?: string,
    @Query('scanPages') scanPages?: string,
  ) {
    const pawnOnlyFlag = isTruthyQueryFlag(pawnOnly);
    const storeEntries = pawnOnlyFlag ? await this.loadEbayStoreFeedFromDb() : undefined;
    return fetchEbayCatalogSearch({
      query: q,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      cacheOffset: cacheOffset ? Number(cacheOffset) : undefined,
      preferCache: isTruthyQueryFlag(preferCache),
      condition,
      buyingOptions,
      sort,
      pawnOnly: pawnOnlyFlag,
      minSellerReviews: normalizeMinSellerReviews(minSellerReviews),
      scanPages: normalizeEbayScanPages(scanPages),
      cacheRepo: this.ebaySearchItemsRepo,
      stateRepo: this.ebaySearchStateRepo,
      storeEntries,
    });
  }

  @Get('utils/ebay/apple-collection')
  async getEbayAppleCollection(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('family') family?: 'all' | 'ipad' | 'iphone' | 'macbook' | 'apple-watch' | 'apple-watch-ultra' | 'imac' | 'mac-mini',
    @Query('condition') condition?: string,
    @Query('buyingOptions') buyingOptions?: string,
    @Query('sort') sort?: string,
    @Query('pawnOnly') pawnOnly?: string,
  ) {
    return fetchEbayAppleCollection({
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      family,
      condition,
      buyingOptions,
      pawnOnly: isTruthyQueryFlag(pawnOnly),
      sort: sort === 'oldestListed' ? 'oldestListed' : 'newlyListed',
    });
  }

  @Get('utils/ebay/apple-auctions')
  async getEbayAppleAuctions(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('family') family?: 'all' | 'ipad' | 'iphone' | 'macbook' | 'apple-watch' | 'apple-watch-ultra' | 'imac' | 'mac-mini',
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
