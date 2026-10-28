// Descarga de fichas EveryMac SOLO a petición de un administrador (importación autorizada por EveryMac).
// Agente de usuario identificable, una petición por enlace, pausa mínima entre peticiones y caché corta
// para que la vista previa y la importación no repitan la descarga. Nunca se consulta desde formularios.
import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { EVERYMAC_URL, parseEveryMacPage, type EveryMacRecord } from './everymac.parser';
import type { FetchLike } from './appledb.provider';

export const EVERYMAC_MAX_URLS = 25;
const CACHE_MS = 15 * 60_000;
const MAX_BYTES = 3 * 1024 * 1024;

export function normalizeEveryMacUrl(raw: string): string {
  const trimmed = String(raw || '').trim().replace(/^http:\/\//i, 'https://').replace(/[?#].*$/, '');
  if (!EVERYMAC_URL.test(trimmed)) {
    throw new BadRequestException(`Enlace no admitido (solo fichas https://everymac.com/systems/apple/...html): ${String(raw).slice(0, 160)}`);
  }
  return trimmed.replace('://www.', '://');
}

@Injectable()
export class EveryMacProvider {
  private readonly logger = new Logger(EveryMacProvider.name);
  private readonly cache = new Map<string, { record: EveryMacRecord; at: number }>();
  private lastRequestAt = 0;
  fetchImpl: FetchLike = (url, init) => fetch(url, init) as any;
  minIntervalMs = Number(process.env.EVERYMAC_MIN_INTERVAL_MS || 2000);
  timeoutMs = Number(process.env.EVERYMAC_FETCH_TIMEOUT_MS || 20_000);
  userAgent = process.env.EVERYMAC_USER_AGENT || 'MacsomenosCatalogImport/1.0 (importacion autorizada por EveryMac)';

  enabled() {
    return String(process.env.EVERYMAC_IMPORT_ENABLED ?? 'true').toLowerCase() !== 'false';
  }

  async getRecord(url: string): Promise<EveryMacRecord> {
    if (!this.enabled()) throw new ServiceUnavailableException('La importación desde EveryMac está desactivada (EVERYMAC_IMPORT_ENABLED=false).');
    const cached = this.cache.get(url);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.record;
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastRequestAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { headers: { 'User-Agent': this.userAgent, Accept: 'text/html' }, signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      if (html.length > MAX_BYTES) throw new Error('Página demasiado grande');
      if (!/contentcenter_specs_table/i.test(html)) throw new Error('La página no contiene una ficha técnica de EveryMac');
      const record = parseEveryMacPage(html, url);
      this.cache.set(url, { record, at: Date.now() });
      return record;
    } catch (error: any) {
      this.logger.warn(`EveryMac ${url}: ${error?.message || error}`);
      throw new Error(error?.name === 'AbortError' ? 'Tiempo de espera agotado' : error?.message || String(error));
    } finally {
      clearTimeout(timer);
    }
  }
}
