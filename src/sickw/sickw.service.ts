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

const APPLE_BASIC_INFO_SERVICE_ID = '30';

@Injectable()
export class SickwService {
  constructor(private readonly config: ConfigService) {}

  async appleBasicInfo(identifier: string, type?: string) {
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

    const url = new URL('https://sickw.com/api.php');
    url.searchParams.set('format', 'json');
    url.searchParams.set('key', key);
    url.searchParams.set('imei', cleanIdentifier);
    url.searchParams.set('service', APPLE_BASIC_INFO_SERVICE_ID);

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
    const status = String(payload.status || '').toLowerCase();
    const failed =
      ['error', 'failed', 'fail', 'rejected'].includes(status) ||
      /error|invalid|wrong|insufficient|balance|not found/i.test(rawResult || payload.message || payload.error || '');

    if (failed) {
      throw new HttpException(
        { message: payload.message || payload.error || this.htmlToText(rawResult) || 'SICKW no pudo completar la consulta.' },
        HttpStatus.BAD_GATEWAY,
      );
    }

    return {
      serviceId: APPLE_BASIC_INFO_SERVICE_ID,
      serviceName: 'APPLE BASIC INFO',
      identifier: cleanIdentifier,
      type: type || null,
      raw: rawResult,
      fields: this.parseResultFields(rawResult),
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

  private parseResultFields(result: string) {
    const normalized = String(result || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>');

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

    return fields;
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
