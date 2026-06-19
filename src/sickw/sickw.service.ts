import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

type SickwApiResponse = {
  status?: string;
  result?: string;
  response?: string;
  message?: string;
  error?: string;
  [key: string]: any;
};

const SICKW_SERVICES: Record<string, { id: '8' | '30' | '81'; name: string; costUSD: number }> = {
  '8': { id: '8', name: 'SIM LOCK STATUS', costUSD: 0.025 },
  '30': { id: '30', name: 'APPLE BASIC INFO', costUSD: 0.05 },
  '81': { id: '81', name: 'APPLE MDM STATUS', costUSD: 0.30 },
};

const IFREEICLOUD_SERVICE_ID = '238';
const IFREEICLOUD_MODAL_SERVICE_ID = 'ifreeicloud-238';

@Injectable()
export class SickwService {
  constructor(private readonly config: ConfigService) {}

  async appleBasicInfo(identifier: string, type?: string, serviceId?: string) {
    if (serviceId === IFREEICLOUD_MODAL_SERVICE_ID) {
      return this.ifreeIcloudCheck(identifier, type);
    }

    const key =
      this.config.get<string>('SICKW_API_KEY') ||
      process.env.SICKW_API_KEY;

    if (!key) {
      throw new HttpException(
        { message: 'Falta configurar SICKW_API_KEY en el backend.' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const cleanIdentifier = String(identifier || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{8,20}$/.test(cleanIdentifier)) {
      throw new HttpException({ message: 'SN/IMEI invalido para consultar SICKW.' }, HttpStatus.BAD_REQUEST);
    }
    const service = SICKW_SERVICES[String(serviceId || '30')] || SICKW_SERVICES['30'];

    const url = new URL('https://sickw.com/api.php');
    url.searchParams.set('format', 'json');
    url.searchParams.set('key', key);
    url.searchParams.set('imei', cleanIdentifier);
    url.searchParams.set('service', service.id);

    const response = await fetch(url.toString(), {
      headers: {
        Accept: 'application/json,text/plain,*/*',
        'User-Agent': 'macsomenos-servicios/1.0',
      },
    });

    const rawBody = await response.text();
    const payload = this.parseApiBody(rawBody);

    if (!response.ok) {
      throw new HttpException(
        { message: payload.message || payload.error || `SICKW respondio ${response.status}.` },
        response.status,
      );
    }

    const rawResult = this.extractResultText(payload, rawBody);
    const fields = this.parseResultFields(rawResult);
    const status = String(payload.status || '').toLowerCase();
    const hasResultFields = fields.length > 0;
    const failed =
      (!hasResultFields && ['error', 'failed', 'fail', 'rejected'].includes(status)) ||
      (!hasResultFields && /invalid|wrong|insufficient|balance|not found|api key|service unavailable/i.test(rawResult || payload.message || payload.error || ''));

    if (failed) {
      throw new HttpException(
        { message: payload.message || payload.error || this.htmlToText(rawResult) || 'SICKW no pudo completar la consulta.' },
        HttpStatus.BAD_GATEWAY,
      );
    }

    return {
      serviceId: service.id,
      serviceName: service.name,
      costUSD: service.costUSD,
      balance: await this.getSickwBalance().catch(() => null),
      identifier: cleanIdentifier,
      type: type || null,
      raw: rawResult,
      fields,
    };
  }

  async balance() {
    const sickw = await this.getSickwBalance().catch((err) => ({
      provider: 'sickw',
      available: false,
      error: err?.message || 'No se pudo leer saldo SICKW.',
    }));
    return { sickw };
  }

  private async getSickwBalance() {
    const key =
      this.config.get<string>('SICKW_API_KEY') ||
      process.env.SICKW_API_KEY;

    if (!key) {
      throw new Error('Falta configurar SICKW_API_KEY.');
    }

    const url = new URL('https://sickw.com/api.php');
    url.searchParams.set('format', 'json');
    url.searchParams.set('key', key);
    url.searchParams.set('action', 'balance');

    const response = await fetch(url.toString(), {
      headers: {
        Accept: 'application/json,text/plain,*/*',
        'User-Agent': 'macsomenos-servicios/1.0',
      },
    });
    const rawBody = await response.text();
    const payload = this.parseApiBody(rawBody);
    const rawResult = this.extractResultText(payload, rawBody);
    const status = String(payload.status || '').toLowerCase();
    if (['error', 'failed', 'fail', 'rejected'].includes(status) || /error\s+[a-z]\d+/i.test(rawResult)) {
      throw new Error(payload.message || payload.error || this.htmlToText(rawResult) || 'Saldo SICKW no disponible.');
    }
    const balance = this.extractBalanceValue(payload, rawResult);

    if (!response.ok || balance == null) {
      throw new Error(payload.message || payload.error || this.htmlToText(rawResult) || 'Saldo SICKW no disponible.');
    }

    return {
      provider: 'sickw',
      available: true,
      balanceUSD: balance,
      label: `$${balance.toFixed(3)}`,
    };
  }

  private extractBalanceValue(payload: SickwApiResponse, rawResult: string) {
    const candidates = [
      payload.balance,
      payload.credit,
      payload.credits,
      payload.amount,
      payload.result,
      payload.response,
      rawResult,
    ];
    for (const candidate of candidates) {
      const match = String(candidate ?? '').match(/-?\d+(?:[.,]\d+)?/);
      if (!match) continue;
      const value = Number(match[0].replace(',', '.'));
      if (Number.isFinite(value)) return value;
    }
    return null;
  }

  private async ifreeIcloudCheck(identifier: string, type?: string) {
    const key =
      this.config.get<string>('IFREEICLOUD_API_KEY') ||
      process.env.IFREEICLOUD_API_KEY;
    const apiUrl =
      this.config.get<string>('IFREEICLOUD_API_URL') ||
      process.env.IFREEICLOUD_API_URL ||
      'https://api.ifreeicloud.co.uk';

    if (!key) {
      throw new HttpException(
        { message: 'Falta configurar IFREEICLOUD_API_KEY en el backend.' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const cleanIdentifier = String(identifier || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{8,20}$/.test(cleanIdentifier)) {
      throw new HttpException({ message: 'SN/IMEI invalido para consultar iFreeiCloud.' }, HttpStatus.BAD_REQUEST);
    }

    const url = new URL(apiUrl);
    const body = new URLSearchParams();
    body.set('service', IFREEICLOUD_SERVICE_ID);
    body.set('imei', cleanIdentifier);
    body.set('key', key);

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        Accept: 'application/json,text/plain,*/*',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'macsomenos-servicios/1.0',
      },
      body,
    });

    const rawBody = await response.text();
    const payload = this.parseApiBody(rawBody);

    if (!response.ok) {
      throw new HttpException(
        { message: payload.message || payload.error || `iFreeiCloud respondio ${response.status}.` },
        response.status,
      );
    }

    const rawResult = this.extractResultText(payload, rawBody);
    const fields = this.parseResultFields(rawResult);
    const status = String(payload.status || '').toLowerCase();
    const hasResultFields = fields.length > 0;
    const failed =
      (!hasResultFields && ['error', 'failed', 'fail', 'rejected'].includes(status)) ||
      (!hasResultFields && /invalid|wrong|insufficient|balance|not found|api key|service unavailable/i.test(rawResult || payload.message || payload.error || ''));

    if (failed) {
      throw new HttpException(
        { message: payload.message || payload.error || this.htmlToText(rawResult) || 'iFreeiCloud no pudo completar la consulta.' },
        HttpStatus.BAD_GATEWAY,
      );
    }

    return {
      serviceId: IFREEICLOUD_MODAL_SERVICE_ID,
      serviceName: 'iFreeiCloud Free Check',
      provider: 'ifreeicloud',
      costUSD: 0,
      identifier: cleanIdentifier,
      type: type || null,
      raw: rawResult,
      fields,
    };
  }

  private parseApiBody(rawBody: string): SickwApiResponse {
    try {
      return JSON.parse(rawBody) as SickwApiResponse;
    } catch {
      return { result: rawBody };
    }
  }

  private extractResultText(payload: SickwApiResponse, rawBody: string) {
    const result = payload.result ?? payload.response ?? payload.message ?? rawBody;
    if (typeof result === 'string') return result;
    return JSON.stringify(result);
  }

  private normalizeResultText(result: string) {
    const normalized = String(result || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&#39;/gi, "'")
      .replace(/&quot;/gi, '"');

    const text = this.htmlToText(normalized);
    const knownLabels = [
      'Model Description',
      'Serial Number',
      'Estimated Purchase Date',
      'Warranty Status',
      'iCloud Lock',
      'Demo Unit',
      'Loaner Device',
      'Replaced Device',
      'Replacement Device',
      'Refurbished Device',
      'Locked Carrier',
      'Sim-Lock Status',
      'SIM Lock Status',
      'Find My iPhone',
      'IMEI2',
      'IMEI',
      'MEID',
      'Model',
      'Blacklist Status',
      'MDM Status',
    ];
    const labelPattern = knownLabels
      .sort((a, b) => b.length - a.length)
      .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');

    return text
      .replace(new RegExp(`[\\\\|]?\\s*(?=(${labelPattern})\\s*:)`, 'gi'), '\n')
      .replace(/^\n+/, '')
      .trim();
  }

  private parseResultFields(result: string) {
    const normalized = this.normalizeResultText(result);

    const lines = normalized
      .split('\n')
      .map((line) => this.htmlToText(line).trim())
      .filter(Boolean);

    const fields: Array<{ label: string; value: string; tone?: 'good' | 'warn' | 'bad' }> = [];
    const seen = new Set<string>();

    for (const line of lines) {
      const match = line.match(/^([^:]{2,60}):\s*(.+)$/);
      if (!match) continue;
      const label = this.normalizeLabel(match[1]);
      const value = match[2].trim();
      if (!label || !value) continue;
      const key = label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      fields.push({ label, value, tone: this.toneForValue(label, value) });
    }

    return this.enrichWarrantyFields(fields);
  }

  private enrichWarrantyFields(fields: Array<{ label: string; value: string; tone?: 'good' | 'warn' | 'bad' }>) {
    const enriched = fields.map((field) => {
      if (this.isPurchaseDateLabel(field.label)) {
        const parsedDate = this.parseLooseDate(field.value);
        if (parsedDate) {
          return {
            ...field,
            value: this.formatDateDmy(parsedDate),
          };
        }
      }
      return field;
    });

    const purchaseField = enriched.find((field) => this.isPurchaseDateLabel(field.label));
    const purchaseDate = purchaseField ? this.parseLooseDate(purchaseField.value) : null;
    if (!purchaseDate || enriched.some((field) => /garantia|warranty/i.test(field.label) && /fin|end|hasta|expires|expiration/i.test(field.label))) {
      return enriched;
    }

    const warrantyEnd = new Date(purchaseDate);
    warrantyEnd.setFullYear(warrantyEnd.getFullYear() + 1);
    warrantyEnd.setDate(warrantyEnd.getDate() - 1);
    enriched.push({
      label: 'Fin garantia estimada',
      value: this.formatDateDmy(warrantyEnd),
      tone: warrantyEnd.getTime() >= Date.now() ? 'good' : 'warn',
    });
    return enriched;
  }

  private isPurchaseDateLabel(label: string) {
    return /estimated\s+purchase\s+date|purchase\s+date|fecha.*compra|compra.*estimada/i.test(label);
  }

  private parseLooseDate(value: string) {
    const text = String(value || '').trim();
    let match = text.match(/\b(\d{4})[-/.\s](\d{1,2})[-/.\s](\d{1,2})\b/);
    if (match) {
      const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      return Number.isNaN(date.getTime()) ? null : date;
    }
    match = text.match(/\b(\d{1,2})[-/.\s](\d{1,2})[-/.\s](\d{4})\b/);
    if (match) {
      const first = Number(match[1]);
      const second = Number(match[2]);
      const year = Number(match[3]);
      const day = first > 12 ? first : second > 12 ? second : first;
      const month = first > 12 ? second : second > 12 ? first : second;
      const date = new Date(year, month - 1, day);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private formatDateDmy(date: Date) {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `${day}-${month}-${year}`;
  }

  private htmlToText(value: string) {
    return String(value || '')
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private normalizeLabel(label: string) {
    const clean = label.replace(/\s+/g, ' ').trim();
    const map: Record<string, string> = {
      'Model Description': 'Description',
      IMEI: 'IMEI Number',
      IMEI2: 'IMEI2 Number',
      MEID: 'MEID Number',
      'iCloud Lock': 'Find My iPhone',
      'Sim-Lock Status': 'Sim-Lock',
      'Warranty Status': 'Coverage Status',
    };
    return map[clean] || clean;
  }

  private toneForValue(label: string, value: string): 'good' | 'warn' | 'bad' | undefined {
    const cleanLabel = label.toLowerCase();
    const cleanValue = value.toLowerCase();
    if (/\boff\b|unlocked|\bno\b|clean|limited warranty/.test(cleanValue)) return 'good';
    if (/find my iphone|icloud/.test(cleanLabel) && /\bon\b|lost|locked/.test(cleanValue)) return 'bad';
    if (/sim-lock/.test(cleanLabel) && /locked/.test(cleanValue) && !/unlocked/.test(cleanValue)) return 'bad';
    if (/blacklist/.test(cleanLabel) && /blacklist|lost|stolen/.test(cleanValue)) return 'bad';
    if (/replaced|replacement|refurbished|demo|loaner/.test(cleanLabel) && /\byes\b/.test(cleanValue)) return 'bad';
    if (/orange|expired|unknown/i.test(value)) return 'warn';
    return undefined;
  }
}
