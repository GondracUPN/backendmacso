// Lectura del JSON público y gratuito de AppleDB (GET sin autenticación, sin claves).
// Solo device/main.json y group/main.json; nunca firmware ni el catálogo de sistemas operativos.
import { Injectable, Logger } from '@nestjs/common';

export const APPLEDB_DEVICE_URL = 'https://api.appledb.dev/device/main.json';
export const APPLEDB_GROUP_URL = 'https://api.appledb.dev/group/main.json';
const MAX_BYTES = 40 * 1024 * 1024;

export interface AppleDbFetchResult {
  notModified: boolean;
  devices?: any[];
  groups?: any[];
  etag?: string | null;
  lastModified?: string | null;
}

export type FetchLike = (url: string, init?: any) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

@Injectable()
export class AppleDbProvider {
  private readonly logger = new Logger(AppleDbProvider.name);
  /** Inyectable en pruebas para no depender de red. */
  fetchImpl: FetchLike = (url, init) => fetch(url, init) as any;
  timeoutMs = Number(process.env.APPLE_CATALOG_FETCH_TIMEOUT_MS || 30_000);
  retries = 2;

  async fetchSource(previous?: { etag?: string | null; lastModified?: string | null }): Promise<AppleDbFetchResult> {
    const devices = await this.getJson(APPLEDB_DEVICE_URL, previous);
    if (devices.notModified) return { notModified: true, etag: previous?.etag ?? null, lastModified: previous?.lastModified ?? null };
    const groups = await this.getJson(APPLEDB_GROUP_URL);
    return { notModified: false, devices: devices.body ?? undefined, groups: groups.body ?? undefined, etag: devices.etag, lastModified: devices.lastModified };
  }

  private async getJson(url: string, previous?: { etag?: string | null; lastModified?: string | null }) {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'macsomenos-catalog-sync' };
        if (previous?.etag) headers['If-None-Match'] = previous.etag;
        if (previous?.lastModified) headers['If-Modified-Since'] = previous.lastModified;
        const res = await this.fetchImpl(url, { headers, signal: controller.signal });
        if (res.status === 304) return { notModified: true as const, body: null, etag: previous?.etag ?? null, lastModified: previous?.lastModified ?? null };
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const length = Number(res.headers.get('content-length') || 0);
        if (length > MAX_BYTES) throw new Error('Respuesta demasiado grande');
        const text = await res.text();
        if (text.length > MAX_BYTES) throw new Error('Respuesta demasiado grande');
        const body = JSON.parse(text);
        if (!Array.isArray(body)) throw new Error('Formato inesperado: se esperaba un array');
        return { notModified: false as const, body, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') };
      } catch (error) {
        lastError = error;
        if (attempt < this.retries) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      } finally {
        clearTimeout(timer);
      }
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    this.logger.warn(`AppleDB no disponible (${url}): ${message}`);
    throw new Error(`AppleDB no disponible: ${message}`);
  }
}
