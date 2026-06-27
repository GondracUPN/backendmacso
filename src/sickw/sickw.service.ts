import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SickwCheckHistory } from './sickw-check-history.entity';

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

const COMBINED_SICKW_SERVICES: Record<
  string,
  { ids: Array<'8' | '30' | '81'>; name: string; costUSD: number }
> = {
  '30+81': {
    ids: ['30', '81'],
    name: 'MACBOOK / IPAD MDM',
    costUSD: SICKW_SERVICES['30'].costUSD + SICKW_SERVICES['81'].costUSD,
  },
  '30+8': {
    ids: ['30', '8'],
    name: 'IPHONE / IPAD SIM LOCK',
    costUSD: SICKW_SERVICES['30'].costUSD + SICKW_SERVICES['8'].costUSD,
  },
};

const IFREEICLOUD_SERVICE_ID = '238';
const IFREEICLOUD_MODAL_SERVICE_ID = 'ifreeicloud-238';

@Injectable()
export class SickwService {
  constructor(
    private readonly config: ConfigService,
    @InjectRepository(SickwCheckHistory)
    private readonly historyRepo: Repository<SickwCheckHistory>,
  ) {}

  async appleBasicInfo(identifier: string, type?: string, serviceId?: string) {
    if (serviceId === IFREEICLOUD_MODAL_SERVICE_ID) {
      const result = await this.ifreeIcloudCheck(identifier, type);
      return this.saveHistory(result);
    }

    const cleanIdentifier = this.cleanIdentifier(identifier);

    const combinedService = COMBINED_SICKW_SERVICES[String(serviceId || '')];
    if (combinedService) {
      const existing = await this.findExistingServiceResults(cleanIdentifier, combinedService.ids);
      const missingIds = combinedService.ids.filter((id) => !existing.has(id));
      const existingIds = combinedService.ids.filter((id) => existing.has(id));

      if (!missingIds.length) {
        return this.composeCombinedResult(
          cleanIdentifier,
          type,
          String(serviceId),
          combinedService,
          combinedService.ids.map((id) => existing.get(id)),
          0,
          null,
          this.buildLookupStatus(cleanIdentifier, existingIds, [], []),
        );
      }

      const key = this.getSickwKey();
      const queried = await Promise.all(
        missingIds.map((id) => this.runSickwCheck(key, cleanIdentifier, id)),
      );
      const queriedById = new Map(queried.map((result) => [result.serviceId, result]));
      const results = combinedService.ids.map((id) => existing.get(id) || queriedById.get(id));
      const lookupStatus = this.buildLookupStatus(cleanIdentifier, existingIds, missingIds, []);
      const result = this.composeCombinedResult(
        cleanIdentifier,
        type,
        String(serviceId),
        combinedService,
        results,
        missingIds.reduce((sum, id) => sum + SICKW_SERVICES[id].costUSD, 0),
        await this.getSickwBalance().catch(() => null),
        lookupStatus,
      );
      const savedResults = await Promise.all(
        queried.map((queriedResult) =>
          this.saveHistory({
            ...queriedResult,
            type: type || null,
            lookupStatus: this.buildLookupStatus(
              cleanIdentifier,
              [],
              [queriedResult.serviceId],
              [],
            ),
          }),
        ),
      );
      return {
        ...result,
        historyRecords: savedResults.map((saved) => saved.historyRecord),
      };
    }

    const service = SICKW_SERVICES[String(serviceId || '30')] || SICKW_SERVICES['30'];
    const existing = await this.findExistingServiceResults(cleanIdentifier, [service.id]);
    const cachedResult = existing.get(service.id);
    if (cachedResult) {
      return {
        ...cachedResult,
        identifier: cleanIdentifier,
        type: type || cachedResult.type || null,
        costUSD: 0,
        lookupStatus: this.buildLookupStatus(cleanIdentifier, [service.id], [], []),
      };
    }

    const key = this.getSickwKey();
    const result = await this.runSickwCheck(key, cleanIdentifier, service.id);

    const response = {
      ...result,
      balance: await this.getSickwBalance().catch(() => null),
      type: type || null,
      lookupStatus: this.buildLookupStatus(cleanIdentifier, [], [service.id], []),
    };
    return this.saveHistory(response);
  }

  async historyStatus(identifier: string, type?: string, serviceId?: string) {
    const cleanIdentifier = this.cleanIdentifier(identifier);
    const combinedService = COMBINED_SICKW_SERVICES[String(serviceId || '')];

    if (combinedService) {
      const existing = await this.findExistingServiceResults(cleanIdentifier, combinedService.ids);
      const existingIds = combinedService.ids.filter((id) => existing.has(id));
      const missingIds = combinedService.ids.filter((id) => !existing.has(id));
      const status = this.buildLookupStatus(cleanIdentifier, existingIds, [], missingIds);
      if (!missingIds.length) {
        return {
          ...status,
          result: this.composeCombinedResult(
            cleanIdentifier,
            type,
            String(serviceId),
            combinedService,
            combinedService.ids.map((id) => existing.get(id)),
            0,
            null,
            status,
          ),
        };
      }
      return status;
    }

    const service = SICKW_SERVICES[String(serviceId || '30')] || SICKW_SERVICES['30'];
    const existing = await this.findExistingServiceResults(cleanIdentifier, [service.id]);
    const cachedResult = existing.get(service.id);
    if (!cachedResult) {
      return this.buildLookupStatus(cleanIdentifier, [], [], [service.id]);
    }

    const status = this.buildLookupStatus(cleanIdentifier, [service.id], [], []);
    return {
      ...status,
      result: {
        ...cachedResult,
        identifier: cleanIdentifier,
        type: type || cachedResult.type || null,
        costUSD: 0,
        lookupStatus: status,
      },
    };
  }

  private cleanIdentifier(identifier: string) {
    const cleanIdentifier = String(identifier || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{8,20}$/.test(cleanIdentifier)) {
      throw new HttpException(
        { message: 'SN/IMEI invalido para consultar SICKW.' },
        HttpStatus.BAD_REQUEST,
      );
    }
    return cleanIdentifier;
  }

  private getSickwKey() {
    const key = this.config.get<string>('SICKW_API_KEY') || process.env.SICKW_API_KEY;
    if (!key) {
      throw new HttpException(
        { message: 'Falta configurar SICKW_API_KEY en el backend.' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return key;
  }

  private composeCombinedResult(
    identifier: string,
    type: string | undefined,
    serviceId: string,
    combinedService: { ids: Array<'8' | '30' | '81'>; name: string; costUSD: number },
    results: any[],
    costUSD: number,
    balance: any,
    lookupStatus: any,
  ) {
    const validResults = results.filter(Boolean);
    return {
      serviceId,
      serviceName: combinedService.name,
      costUSD,
      balance,
      identifier,
      type: type || null,
      raw: validResults
        .map((result) => `--- ${result.serviceName} ---\n${result.raw}`)
        .join('\n\n'),
      fields: this.mergeCombinedFields(validResults),
      results: validResults,
      lookupStatus,
    };
  }

  private buildLookupStatus(
    identifier: string,
    existingServiceIds: Array<'8' | '30' | '81'>,
    queriedServiceIds: Array<'8' | '30' | '81'>,
    missingServiceIds: Array<'8' | '30' | '81'>,
  ) {
    const identifierType = /^\d{15}$/.test(identifier) ? 'IMEI' : 'SN';
    const names = (ids: Array<'8' | '30' | '81'>) =>
      ids.map((id) => SICKW_SERVICES[id].name);
    let state: 'new' | 'partial' | 'cached' | 'queried' = 'new';
    let message = '';

    if (existingServiceIds.length && !queriedServiceIds.length && !missingServiceIds.length) {
      state = 'cached';
      message = existingServiceIds.length > 1
        ? `Este ${identifierType} ya fue consultado en ambos servicios (${names(existingServiceIds).join(' y ')}). Se muestran los resultados guardados y no se realizo una consulta nueva.`
        : `Este ${identifierType} ya fue consultado en ${names(existingServiceIds)[0]}. Se muestra el resultado guardado y no se realizo una consulta nueva.`;
    } else if (existingServiceIds.length && (queriedServiceIds.length || missingServiceIds.length)) {
      state = 'partial';
      const pendingIds = queriedServiceIds.length ? queriedServiceIds : missingServiceIds;
      message = `${names(existingServiceIds).join(' y ')} ya estaba guardado para este ${identifierType}. ${queriedServiceIds.length ? 'Solo se consulto' : 'Solo se consultara'} ${names(pendingIds).join(' y ')}.`;
    } else if (queriedServiceIds.length) {
      state = 'queried';
      message = `Consulta realizada en ${names(queriedServiceIds).join(' y ')} y guardada en el historial.`;
    }

    return {
      state,
      existingServiceIds,
      queriedServiceIds,
      missingServiceIds,
      message,
    };
  }

  private async findExistingServiceResults(
    identifier: string,
    serviceIds: Array<'8' | '30' | '81'>,
  ) {
    const aliases = new Set([identifier]);
    const recordsById = new Map<number, SickwCheckHistory>();

    // Basic Info suele relacionar SN, IMEI e IMEI2. Expandimos esos alias para
    // detectar un servicio previo aunque la nueva busqueda use otro identificador.
    for (let pass = 0; pass < 3; pass += 1) {
      const identifiers = Array.from(aliases);
      const records = await this.historyRepo
        .createQueryBuilder('history')
        .where(
          `(UPPER(history.identifier) IN (:...identifiers)
            OR UPPER(COALESCE(history.serial, '')) IN (:...identifiers)
            OR UPPER(COALESCE(history.imei, '')) IN (:...identifiers)
            OR UPPER(COALESCE(history.imei2, '')) IN (:...identifiers))`,
          { identifiers },
        )
        .orderBy('history.checkedAt', 'DESC')
        .getMany();
      let addedAlias = false;

      for (const record of records) {
        recordsById.set(record.id, record);
        for (const value of [record.identifier, record.serial, record.imei, record.imei2]) {
          const clean = String(value || '').trim().toUpperCase();
          if (!/^[A-Z0-9]{8,20}$/.test(clean) || aliases.has(clean)) continue;
          aliases.add(clean);
          addedAlias = true;
        }
      }

      if (!addedAlias) break;
    }

    const records = Array.from(recordsById.values()).sort(
      (a, b) => new Date(b.checkedAt).getTime() - new Date(a.checkedAt).getTime(),
    );
    const found = new Map<string, any>();

    for (const record of records) {
      if (serviceIds.includes(record.serviceId as '8' | '30' | '81') && !found.has(record.serviceId)) {
        found.set(record.serviceId, {
          serviceId: record.serviceId,
          serviceName: record.serviceName,
          costUSD: Number(record.costUSD),
          identifier,
          type: record.type || null,
          raw: record.raw || '',
          fields: Array.isArray(record.fields) ? record.fields : [],
        });
      }

      for (const nested of Array.isArray(record.results) ? record.results : []) {
        const nestedServiceId = String((nested as any)?.serviceId || '');
        if (serviceIds.includes(nestedServiceId as '8' | '30' | '81') && !found.has(nestedServiceId)) {
          found.set(nestedServiceId, {
            ...(nested as any),
            identifier,
            type: record.type || (nested as any)?.type || null,
          });
        }
      }

      if (found.size === serviceIds.length) break;
    }

    return found;
  }

  private async runSickwCheck(
    key: string,
    cleanIdentifier: string,
    serviceId: '8' | '30' | '81',
  ) {
    const service = SICKW_SERVICES[serviceId];

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
      identifier: cleanIdentifier,
      raw: rawResult,
      fields,
    };
  }

  private mergeCombinedFields(
    results: Array<{
      serviceName: string;
      fields: Array<{ label: string; value: string; tone?: 'good' | 'warn' | 'bad' }>;
    }>,
  ) {
    const merged: Array<{ label: string; value: string; tone?: 'good' | 'warn' | 'bad' }> = [];
    const labels = new Map<string, string>();

    for (const result of results) {
      for (const field of result.fields) {
        const key = field.label.toLowerCase();
        const previousValue = labels.get(key);
        if (previousValue === field.value) continue;

        if (previousValue !== undefined) {
          merged.push({
            ...field,
            label: `${field.label} (${result.serviceName})`,
          });
          continue;
        }

        labels.set(key, field.value);
        merged.push(field);
      }
    }

    return merged;
  }

  async history(query?: string, rawLimit?: string, serviceId?: string) {
    const limit = Math.min(Math.max(Number.parseInt(String(rawLimit || '150'), 10) || 150, 1), 500);
    const normalizedQuery = String(query || '').trim().toUpperCase().replace(/[^A-Z0-9+\- /]/g, '');
    const qb = this.historyRepo
      .createQueryBuilder('history')
      .orderBy('history.checkedAt', 'DESC')
      .take(limit);

    if (normalizedQuery) {
      qb.where(
        `(UPPER(history.identifier) LIKE :query
          OR UPPER(COALESCE(history.serial, '')) LIKE :query
          OR UPPER(COALESCE(history.imei, '')) LIKE :query
          OR UPPER(COALESCE(history.imei2, '')) LIKE :query
          OR UPPER(history.serviceName) LIKE :query)`,
        { query: `%${normalizedQuery}%` },
      );
    }

    const normalizedServiceId = String(serviceId || '').trim();
    if (normalizedServiceId) {
      qb.andWhere('history.serviceId = :serviceId', { serviceId: normalizedServiceId });
    }

    const [records, total] = await qb.getManyAndCount();
    return {
      items: records.map((record) => this.toHistoryResponse(record)),
      total,
    };
  }

  private async saveHistory(result: any) {
    const fields = Array.isArray(result?.fields) ? result.fields : [];
    const serial = this.findFieldValue(fields, [/^serial number$/i, /^serial$/i, /^s\/n$/i]);
    const imei = this.findFieldValue(fields, [/^imei number$/i, /^imei$/i]);
    const imei2 = this.findFieldValue(fields, [/^imei2 number$/i, /^imei2$/i]);
    const record = this.historyRepo.create({
      serviceId: String(result.serviceId || ''),
      serviceName: String(result.serviceName || ''),
      costUSD: String(result.costUSD ?? 0),
      identifier: String(result.identifier || '').toUpperCase(),
      type: result.type || null,
      serial: serial || null,
      imei: imei || null,
      imei2: imei2 || null,
      fields,
      raw: result.raw || null,
      results: Array.isArray(result.results) ? result.results : null,
    });
    const saved = await this.historyRepo.save(record);
    return {
      ...result,
      historyRecord: this.toHistoryResponse(saved),
    };
  }

  private toHistoryResponse(record: SickwCheckHistory) {
    const identifiers = Array.from(
      new Set([record.identifier, record.serial, record.imei, record.imei2].filter(Boolean)),
    );
    return {
      id: record.id,
      checkedAt: record.checkedAt,
      serviceId: record.serviceId,
      serviceName: record.serviceName,
      costUSD: Number(record.costUSD),
      identifier: record.identifier,
      type: record.type || '',
      serial: record.serial || '',
      imei1: record.imei || '',
      imei2: record.imei2 || '',
      identifiers,
      fields: Array.isArray(record.fields) ? record.fields : [],
      raw: record.raw || '',
    };
  }

  private findFieldValue(
    fields: Array<{ label?: string; value?: string }>,
    patterns: RegExp[],
  ) {
    const field = fields.find((candidate) =>
      patterns.some((pattern) => pattern.test(String(candidate.label || ''))),
    );
    return String(field?.value || '').trim();
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
      'Model Number',
      'Part Number',
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
      'MDM Lock',
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
      MODEL: 'Model',
      'SERIAL NUMBER': 'Serial Number',
      'MODEL NUMBER': 'Model Number',
      'PART NUMBER': 'Part Number',
      'MDM LOCK': 'MDM Lock',
      'MDM STATUS': 'MDM Status',
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
    if (/mdm/.test(cleanLabel) && /\bon\b|locked|\byes\b/.test(cleanValue)) return 'bad';
    if (/sim-lock/.test(cleanLabel) && /locked/.test(cleanValue) && !/unlocked/.test(cleanValue)) return 'bad';
    if (/blacklist/.test(cleanLabel) && /blacklist|lost|stolen/.test(cleanValue)) return 'bad';
    if (/replaced|replacement|refurbished|demo|loaner/.test(cleanLabel) && /\byes\b/.test(cleanValue)) return 'bad';
    if (/orange|expired|unknown/i.test(value)) return 'warn';
    return undefined;
  }
}
