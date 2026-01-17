// src/tracking/tracking.controller.ts
import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Param,
  Body,
  ParseIntPipe,
  NotFoundException,
  BadRequestException,
  ValidationPipe,
} from '@nestjs/common';
import { TrackingService } from './tracking.service';
import { CreateTrackingDto } from './dto/create-tracking.dto';
import { UpdateTrackingDto } from './dto/update-tracking.dto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ESHOPEX_CACHE_TTL_MS = 5 * 60 * 1000;
const eshopexCache = new Map<string, { ts: number; data: { status: string | null; date: string | null; time: string | null; items: Array<{ date: string; time: string; status: string; detail: string }> } }>();
const ESHOPEX_CARGA_CACHE_TTL_MS = 5 * 60 * 1000;
let eshopexCargaCache: { ts: number; data: Array<{ guia: string; estado: string; tienda: string; descripcion: string; peso: string; valor: string; fechaRecepcion: string; factura: string; fotos: string[]; account: string }> } | null = null;

type EshopexAccount = { email: string; password: string };
type EshopexCargaRow = {
  guia: string;
  estado: string;
  tienda: string;
  descripcion: string;
  peso: string;
  valor: string;
  fechaRecepcion: string;
  factura: string;
  fotos: string[];
  account: string;
};

const parseHiddenInputs = (html: string) => {
  const hidden: Record<string, string> = {};
  const re = /<input[^>]+type="hidden"[^>]*>/gi;
  const nameRe = /name="([^"]+)"/i;
  const valueRe = /value="([^"]*)"/i;
  const matches = html.match(re) || [];
  for (const raw of matches) {
    const name = raw.match(nameRe)?.[1];
    if (!name) continue;
    const value = raw.match(valueRe)?.[1] || '';
    hidden[name] = value;
  }
  return hidden;
};

const decodeHtml = (input: string) => {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
};

const stripTags = (input: string) => input.replace(/<[^>]*>/g, ' ');
const normalizeCell = (input: string) => decodeHtml(stripTags(input)).replace(/\s+/g, ' ').trim();

const parseEshopexCargaTable = (html: string, account: string): EshopexCargaRow[] => {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  const target = tables.find((t) => /No\.\s*de\s*Gu/i.test(t) || /Fecha\s*Recepci/i.test(t));
  if (!target) return [];

  const rows = target.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const items: EshopexCargaRow[] = [];
  for (const row of rows) {
    const cells: string[] = [];
    const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let match;
    while ((match = cellRe.exec(row)) !== null) {
      cells.push(match[1] || '');
    }
    if (!cells.length) continue;
    const clean = cells.map((c) => normalizeCell(c));
    if (clean.some((c) => /No\.\s*de\s*Gu/i.test(c))) continue;
    const guia = clean[0] || '';
    if (!guia) continue;
    items.push({
      guia,
      estado: clean[1] || '',
      tienda: clean[2] || '',
      descripcion: clean[3] || '',
      peso: clean[4] || '',
      valor: clean[5] || '',
      fechaRecepcion: clean[6] || '',
      factura: clean[7] || '',
      fotos: [],
      account,
    });
  }
  return items;
};

const readEnvVarFromFile = (key: string): { value: string | null; source: string | null } => {
  const candidates = [
    join(process.cwd(), 'backend', '.env'),
    join(process.cwd(), '.env'),
  ];
  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue;
    try {
      const content = readFileSync(filePath, 'utf8');
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        if (!trimmed.startsWith(key + '=')) continue;
        let value = trimmed.slice(key.length + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        return { value, source: filePath };
      }
    } catch {
      // ignore file read errors
    }
  }
  return { value: null, source: null };
};

let lastEshopexEnvSource: { source: string; length: number } = { source: 'none', length: 0 };

const parseAccountsEnv = (): EshopexAccount[] => {
  const fromProcess = process.env.ESHOPEX_ACCOUNTS || '';
  const fromFile = readEnvVarFromFile('ESHOPEX_ACCOUNTS');
  const raw = fromProcess || fromFile.value || '';
  lastEshopexEnvSource = {
    source: fromProcess ? 'process.env' : (fromFile.source || 'not_found'),
    length: raw ? raw.length : 0,
  };
  console.log('[Eshopex] ESHOPEX_ACCOUNTS source:', lastEshopexEnvSource.source, 'len:', lastEshopexEnvSource.length);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => ({
          email: String(item?.email || '').trim(),
          password: String(item?.password || '').trim(),
        }))
        .filter((item) => item.email && item.password);
    }
  } catch {
    // fall back to line parsing
  }
  const parts = raw.split(/\s*[;\n]\s*/).map((p) => p.trim()).filter(Boolean);
  const accounts: EshopexAccount[] = [];
  for (const part of parts) {
    const split = part.includes(',') ? part.split(',') : part.split(':');
    const email = (split[0] || '').trim();
    const password = (split[1] || '').trim();
    if (email && password) accounts.push({ email, password });
  }
  console.log('[Eshopex] Parsed accounts count:', accounts.length);
  return accounts;
};

const getSetCookies = (res: any): string[] => {
  const headers: any = res.headers;
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }
  const raw = res.headers.get('set-cookie');
  if (!raw) return [];
  return raw.split(/,(?=[^;]+?=)/).map((c) => c.trim()).filter(Boolean);
};

const mergeCookies = (jar: Map<string, string>, setCookies: string[]) => {
  for (const entry of setCookies) {
    const pair = entry.split(';')[0];
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!name) continue;
    if (value === '' && jar.has(name)) continue;
    jar.set(name, value);
  }
};

const cookieHeader = (jar: Map<string, string>) => {
  return Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
};

const fetchEshopexCarga = async (account: EshopexAccount): Promise<EshopexCargaRow[]> => {
  const baseHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'es-PE,es;q=0.9',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-User': '?1',
    'Sec-Fetch-Dest': 'document',
    'Cache-Control': 'max-age=0',
    'Pragma': 'no-cache',
  };

  const runFlow = async (
    baseUrl: string,
    loginUrl: string,
    dashboardUrl: string,
    rastreoUrls: string[],
  ): Promise<{ rows: EshopexCargaRow[]; rastreoLoc?: string | null; rastreoStatus: number }> => {
    const jar = new Map<string, string>();
    jar.set('userInfo', 'language=SP&country=PE');
    jar.set('Pais%5Fselected', 'PE');

    const fetchWithRedirect = async (url: string, init: any = {}, max = 5) => {
      let current = url;
      let last: Response | null = null;
      for (let i = 0; i < max; i += 1) {
        const headers = { ...(init.headers || {}) };
        if (!headers.Cookie && jar.size) {
          headers.Cookie = cookieHeader(jar);
        }
        const res = await fetch(current, { ...init, headers, redirect: 'manual' });
        mergeCookies(jar, getSetCookies(res));
        last = res;
        if (!(res.status >= 300 && res.status < 400)) return res;
        const loc = res.headers.get('location');
        if (!loc) return res;
        current = loc.startsWith('http') ? loc : new URL(loc, current).toString();
        const nextHeaders = { ...(init.headers || {}), Cookie: cookieHeader(jar) };
        init = { ...init, headers: nextHeaders };
      }
      return last as Response;
    };

    // Preload base country page to set country cookies
    await fetchWithRedirect(baseUrl, { headers: baseHeaders });
    console.log('[Eshopex] Cookie keys after base', account.email, Array.from(jar.keys()));

    const loginRes = await fetchWithRedirect(loginUrl, {
      headers: baseHeaders,
    });
    console.log('[Eshopex] Login page status for', account.email, loginRes.status, 'base:', baseUrl);
    const loginHtml = await loginRes.text();
    const hidden = parseHiddenInputs(loginHtml);
    console.log('[Eshopex] Hidden inputs found:', Object.keys(hidden).length);

    const form = new URLSearchParams();
    Object.entries(hidden).forEach(([k, v]) => form.set(k, v || ''));
    form.set('ctl00$ContentPlaceHolder1$txtEcode', account.email);
    form.set('ctl00$ContentPlaceHolder1$txtClave', account.password);
    form.set('ctl00$ContentPlaceHolder1$Button1', 'Entrar');

    const postRes = await fetchWithRedirect(loginUrl, {
      method: 'POST',
      headers: {
        ...baseHeaders,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'https://www.eshopex.com',
        'Referer': loginUrl,
        'Cookie': cookieHeader(jar),
      },
      body: form.toString(),
    });
    console.log('[Eshopex] Login submit status for', account.email, postRes.status);
    console.log('[Eshopex] Cookie keys after login', account.email, Array.from(jar.keys()));
    const postHtml = await postRes.text();
    const loginFailed = /ContentPlaceHolder1_txtClave/i.test(postHtml);
    if (loginFailed) {
      console.log('[Eshopex] Login failed for', account.email);
      return { rows: [], rastreoStatus: 0 };
    }

    if (dashboardUrl) {
      await fetchWithRedirect(dashboardUrl, {
        headers: { ...baseHeaders, 'Referer': loginUrl },
      });
    }

    for (const rastreoUrl of rastreoUrls) {
      console.log('[Eshopex] Cookie header for rastreo', account.email, cookieHeader(jar));
      const rastreoRes = await fetchWithRedirect(rastreoUrl, {
        headers: { ...baseHeaders, 'Referer': dashboardUrl || loginUrl, 'Origin': 'https://www.eshopex.com' },
      });
      const rastreoLoc = rastreoRes.headers.get('location');
      console.log('[Eshopex] Rastreo status for', account.email, rastreoRes.status, 'loc:', rastreoLoc || '-', 'url:', rastreoUrl);
      const rastreoHtml = await rastreoRes.text();
      console.log('[Eshopex] Rastreo html snippet:', rastreoHtml.slice(0, 200).replace(/\s+/g, ' '));
      if (/ContentPlaceHolder1_txtClave/i.test(rastreoHtml)) {
        console.log('[Eshopex] Rastreo redirected to login for', account.email);
        continue;
      }
      const rows = parseEshopexCargaTable(rastreoHtml, account.email);
      console.log('[Eshopex] Rows parsed for', account.email, rows.length);
      if (rows.length) {
        return { rows, rastreoLoc, rastreoStatus: rastreoRes.status };
      }
    }
    return { rows: [], rastreoLoc: null, rastreoStatus: 0 };
  };

  const peFlow = {
    baseUrl: 'https://www.eshopex.com/pe/',
    loginUrl: 'https://www.eshopex.com/pe/mi_cuenta.aspx',
    dashboardUrl: 'https://www.eshopex.com/pe/mi_cuenta2.aspx',
    rastreoUrls: [
      'https://www.eshopex.com/pe/Rasteo_Carga.aspx',
    ],
  };

  const usFlow = {
    baseUrl: 'https://www.eshopex.com/us/',
    loginUrl: 'https://www.eshopex.com/us/mi_cuenta.aspx',
    dashboardUrl: 'https://www.eshopex.com/us/mi_cuenta2.aspx',
    rastreoUrls: [
      'https://www.eshopex.com/us/Rasteo_Carga.aspx',
      'https://www.eshopex.com/us/Rastreo_Carga.aspx',
    ],
  };

  const first = await runFlow(peFlow.baseUrl, peFlow.loginUrl, peFlow.dashboardUrl, peFlow.rastreoUrls);
  if (first.rows.length) return first.rows;

  if (first.rastreoStatus >= 300 && first.rastreoStatus < 400 && first.rastreoLoc?.includes('/us')) {
    console.log('[Eshopex] PE rastreo redirected to /us, intentando flujo US');
  }

  const second = await runFlow(usFlow.baseUrl, usFlow.loginUrl, usFlow.dashboardUrl, usFlow.rastreoUrls);
  return second.rows;
};

const toAbsoluteUrl = (loc: string, base: string) => {
  if (!loc) return '';
  if (/^https?:\/\//i.test(loc)) return loc;
  const clean = loc.replace(/^\.\/?/, '');
  if (/ConfirmCli\.aspx/i.test(clean) && !/confirmationpe\//i.test(clean) && !clean.startsWith('/')) {
    return `https://www.eshopex.com/confirmationpe/${clean}`;
  }
  try {
    return new URL(clean, base).toString();
  } catch {
    return clean;
  }
};

const extractConfirmUrl = (html: string, base: string) => {
  if (!html) return '';
  const direct = html.match(/https?:\/\/[^\s"'<>]*ConfirmCli\.aspx\?id=[^&"'<>]+&re=\d+/i);
  if (direct) return direct[0];
  const rel = html.match(/(?:\.\/)?ConfirmCli\.aspx\?id=([A-Za-z0-9]+)&re=(\d+)/i);
  if (rel) {
    return `https://www.eshopex.com/confirmationpe/ConfirmCli.aspx?id=${rel[1]}&re=${rel[2]}`;
  }
  const path = html.match(/\/confirmationpe\/ConfirmCli\.aspx\?id=([A-Za-z0-9]+)&re=(\d+)/i);
  if (path) {
    return `https://www.eshopex.com/confirmationpe/ConfirmCli.aspx?id=${path[1]}&re=${path[2]}`;
  }
  const action = html.match(/action="([^"]*ConfirmCli\.aspx\?id=[^"]+)"/i);
  if (action) return toAbsoluteUrl(action[1], base);
  return '';
};

const fetchEshopexPrePago = async (account: EshopexAccount): Promise<string> => {
  const baseHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'es-PE,es;q=0.9',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-User': '?1',
    'Sec-Fetch-Dest': 'document',
    'Cache-Control': 'max-age=0',
    'Pragma': 'no-cache',
  };

  const runFlow = async (
    baseUrl: string,
    loginUrl: string,
    dashboardUrl: string,
    saldoUrl: string,
  ): Promise<string> => {
    const jar = new Map<string, string>();
    jar.set('userInfo', 'language=SP&country=PE');
    jar.set('Pais%5Fselected', 'PE');

    const fetchWithRedirect = async (url: string, init: any = {}, max = 5) => {
      let current = url;
      let last: Response | null = null;
      for (let i = 0; i < max; i += 1) {
        const headers = { ...(init.headers || {}) };
        if (!headers.Cookie && jar.size) {
          headers.Cookie = cookieHeader(jar);
        }
        const res = await fetch(current, { ...init, headers, redirect: 'manual' });
        mergeCookies(jar, getSetCookies(res));
        last = res;
        if (!(res.status >= 300 && res.status < 400)) return res;
        const loc = res.headers.get('location');
        if (!loc) return res;
        current = loc.startsWith('http') ? loc : new URL(loc, current).toString();
        const nextHeaders = { ...(init.headers || {}), Cookie: cookieHeader(jar) };
        init = { ...init, headers: nextHeaders };
      }
      return last as Response;
    };

    await fetchWithRedirect(baseUrl, { headers: baseHeaders });

    const loginRes = await fetchWithRedirect(loginUrl, { headers: baseHeaders });
    const loginHtml = await loginRes.text();
    const hidden = parseHiddenInputs(loginHtml);
    if (!Object.keys(hidden).length) return '';

    const form = new URLSearchParams();
    Object.entries(hidden).forEach(([k, v]) => form.set(k, v || ''));
    form.set('ctl00$ContentPlaceHolder1$txtEcode', account.email);
    form.set('ctl00$ContentPlaceHolder1$txtClave', account.password);
    form.set('ctl00$ContentPlaceHolder1$Button1', 'Entrar');

    const postRes = await fetchWithRedirect(loginUrl, {
      method: 'POST',
      headers: {
        ...baseHeaders,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'https://www.eshopex.com',
        'Referer': loginUrl,
        'Cookie': cookieHeader(jar),
      },
      body: form.toString(),
    });
    const postHtml = await postRes.text();
    if (/ContentPlaceHolder1_txtClave/i.test(postHtml)) {
      return '';
    }

    if (dashboardUrl) {
      await fetchWithRedirect(dashboardUrl, {
        headers: { ...baseHeaders, 'Referer': loginUrl },
      });
    }

    const saldoRes = await fetchWithRedirect(saldoUrl, {
      headers: { ...baseHeaders, 'Referer': dashboardUrl || loginUrl },
    });
    const saldoHtml = await saldoRes.text();
    const saldoHidden = parseHiddenInputs(saldoHtml);
    if (!Object.keys(saldoHidden).length) return '';

    const saldoForm = new URLSearchParams();
    Object.entries(saldoHidden).forEach(([k, v]) => saldoForm.set(k, v || ''));
    saldoForm.set('ctl00$ContentPlaceHolder1$btnPrePago', 'PrePago Carga');

    const prepagoRes = await fetch(saldoUrl, {
      method: 'POST',
      headers: {
        ...baseHeaders,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'https://www.eshopex.com',
        'Referer': saldoUrl,
        'Cookie': cookieHeader(jar),
      },
      redirect: 'manual',
      body: saldoForm.toString(),
    });
    mergeCookies(jar, getSetCookies(prepagoRes));
    const loc = prepagoRes.headers.get('location');
    if (loc) return toAbsoluteUrl(loc, saldoUrl);
    const prepagoHtml = await prepagoRes.text();
    return extractConfirmUrl(prepagoHtml, saldoUrl);
  };

  const peFlow = {
    baseUrl: 'https://www.eshopex.com/pe/',
    loginUrl: 'https://www.eshopex.com/pe/mi_cuenta.aspx',
    dashboardUrl: 'https://www.eshopex.com/pe/mi_cuenta2.aspx',
    saldoUrl: 'https://www.eshopex.com/pe/Saldo_Cuenta.aspx',
  };

  const usFlow = {
    baseUrl: 'https://www.eshopex.com/us/',
    loginUrl: 'https://www.eshopex.com/us/mi_cuenta.aspx',
    dashboardUrl: 'https://www.eshopex.com/us/mi_cuenta2.aspx',
    saldoUrl: 'https://www.eshopex.com/us/Saldo_Cuenta.aspx',
  };

  const first = await runFlow(peFlow.baseUrl, peFlow.loginUrl, peFlow.dashboardUrl, peFlow.saldoUrl);
  if (first) return first;
  return runFlow(usFlow.baseUrl, usFlow.loginUrl, usFlow.dashboardUrl, usFlow.saldoUrl);
};

@Controller('tracking')
export class TrackingController {
  constructor(private readonly svc: TrackingService) {}

  // Obtener tracking por Producto
  @Get('producto/:pid')
  getByProducto(@Param('pid', ParseIntPipe) pid: number) {
    return this.svc.findByProducto(pid);
  }

  @Get('eshopex-status/:code')
  async getEshopexStatus(@Param('code') code: string) {
    const cleanCode = String(code || '').trim();
    if (!cleanCode) throw new NotFoundException('Tracking Eshopex invalido');
    const cached = eshopexCache.get(cleanCode);
    if (cached && Date.now() - cached.ts < ESHOPEX_CACHE_TTL_MS) {
      return cached.data;
    }
    const url = `https://usamybox.com/internacional/tracking_box.php?nrotrack=${encodeURIComponent(cleanCode)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) throw new NotFoundException('No se pudo consultar el tracking');
    const html = await res.text();
    const items: Array<{ date: string; time: string; status: string; detail: string }> = [];
    const re = /<div class="tracking-item">[\s\S]*?<div class="tracking-date">([^<]+)<span>([^<]+)<\/span><\/div>[\s\S]*?<div class="tracking-content">([^<]+)<span>([^<]*)<\/span>/g;
    let match;
    while ((match = re.exec(html)) !== null) {
      items.push({
        date: (match[1] || '').trim(),
        time: (match[2] || '').trim(),
        status: (match[3] || '').trim(),
        detail: (match[4] || '').trim(),
      });
    }
    const latest = items[0] || null;
    const data = {
      status: latest?.status || null,
      date: latest?.date || null,
      time: latest?.time || null,
      items,
    };
    eshopexCache.set(cleanCode, { ts: Date.now(), data });
    return data;
  }

  @Get('eshopex-carga')
  async getEshopexCarga() {
    if (eshopexCargaCache && Date.now() - eshopexCargaCache.ts < ESHOPEX_CARGA_CACHE_TTL_MS) {
      return eshopexCargaCache.data;
    }
    const accounts = parseAccountsEnv();
    console.log('[Eshopex] Accounts loaded:', accounts.map((a) => a.email));
    if (!accounts.length) {
      throw new BadRequestException({
        message: 'Configura ESHOPEX_ACCOUNTS con cuentas validas',
        source: lastEshopexEnvSource.source,
        length: lastEshopexEnvSource.length,
      });
    }
    const rows: EshopexCargaRow[] = [];
    for (const account of accounts) {
      try {
        const data = await fetchEshopexCarga(account);
        rows.push(...data);
      } catch (err) {
        console.warn('[Eshopex] Error en cuenta', account.email, err);
      }
    }
    const unique = new Map<string, EshopexCargaRow>();
    for (const row of rows) {
      const key = `${row.guia}`.trim();
      if (!key) continue;
      if (!unique.has(key)) unique.set(key, row);
    }
    const data = Array.from(unique.values());
    const statusByCode: Record<string, string> = {};
    for (const row of data) {
      const code = String(row?.guia || '').trim();
      const status = String(row?.estado || '').trim();
      if (code && status) statusByCode[code] = status;
    }
    await this.svc.updateEstatusEshoBulk(statusByCode);
    eshopexCargaCache = { ts: Date.now(), data };
    return data;
  }

  @Post('eshopex-prepago')
  async startEshopexPrepago(@Body() body: { account?: string }) {
    const accounts = parseAccountsEnv();
    if (!accounts.length) {
      throw new BadRequestException({
        message: 'Configura ESHOPEX_ACCOUNTS con cuentas validas',
        source: lastEshopexEnvSource.source,
        length: lastEshopexEnvSource.length,
      });
    }
    const requested = String(body?.account || '').trim().toLowerCase();
    const account = requested
      ? accounts.find((a) => a.email.toLowerCase() === requested)
      : accounts[0];
    if (!account) {
      throw new BadRequestException('Cuenta de Eshopex no encontrada para prepago.');
    }
    const url = await fetchEshopexPrePago(account);
    if (!url) {
      throw new BadRequestException('No se pudo iniciar el prepago en Eshopex.');
    }
    return { url };
  }

  // Obtener tracking por ID
  @Get(':id')
  async getOne(@Param('id', ParseIntPipe) id: number) {
    const t = await this.svc['repo'].findOne({ where: { id } });
    if (!t) throw new NotFoundException(`Tracking ${id} no encontrado`);
    return t;
  }

  // Crear tracking (requiere productoId en el body)
  @Post()
  create(
    @Body(new ValidationPipe({ whitelist: true })) dto: CreateTrackingDto,
  ) {
    return this.svc.create(dto);
  }

  // Upsert por producto: si existe lo actualiza, si no crea uno nuevo
  @Put('producto/:pid')
  async upsertByProducto(
    @Param('pid', ParseIntPipe) pid: number,
    @Body(new ValidationPipe({ whitelist: true }))
    body: Omit<CreateTrackingDto, 'productoId'>,
  ) {
    const existing = await this.svc.findByProducto(pid);
    if (existing) {
      return this.svc.update(existing.id, body as UpdateTrackingDto);
    }
    return this.svc.create({ ...(body as CreateTrackingDto), productoId: pid });
  }

  // Actualizar por ID
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ValidationPipe({ whitelist: true })) dto: UpdateTrackingDto,
  ) {
    return this.svc.update(id, dto);
  }
}
