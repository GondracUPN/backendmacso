import { AppleCatalogService, KIND_SNAPSHOT, validateSpecsDataset } from './apple-catalog.service';
import { AppleDbProvider } from './appledb.provider';
import { EveryMacProvider } from './everymac.provider';
import { APPLEDB_BASELINE } from './data/appledb-baseline.data';
import { APPLE_SPECS_DATASET } from './data/apple-specs.dataset';

/** Repositorio en memoria para CatalogItem (solo lo que usa el servicio). */
function memoryRepo() {
  const rows: any[] = [];
  let seq = 0;
  const matches = (row: any, where: any = {}) => Object.entries(where).every(([key, value]: [string, any]) => {
    if (value && typeof value === 'object' && Array.isArray(value._value)) return value._value.includes(row[key]);
    return row[key] === value;
  });
  const repo = {
    rows,
    create: (data: any) => ({ ...data }),
    save: async (row: any) => {
      if (!row.id) { row.id = ++seq; row.createdAt = new Date(); rows.push(row); }
      else { const idx = rows.findIndex((r) => r.id === row.id); rows[idx] = row; }
      return row;
    },
    findOne: async ({ where }: any) => rows.find((row) => matches(row, where)) || null,
    find: async ({ where, order, take }: any = {}) => {
      let out = rows.filter((row) => matches(row, where));
      if (order?.id === 'DESC') out = [...out].sort((a, b) => b.id - a.id);
      return take ? out.slice(0, take) : out;
    },
    delete: async ({ id }: any) => {
      const ids = id?._value || [id];
      for (const target of ids) { const idx = rows.findIndex((r) => r.id === target); if (idx >= 0) rows.splice(idx, 1); }
    },
  };
  return repo;
}

function setup(fetchImpl: any) {
  const repo = memoryRepo();
  const dataSource = {
    createQueryRunner: () => ({ connect: async () => undefined, release: async () => undefined, query: async () => [{ ok: true }] }),
    transaction: async (cb: any) => cb({ query: async () => undefined, getRepository: () => repo }),
    query: async () => [],
  };
  const provider = new AppleDbProvider();
  provider.retries = 0;
  provider.fetchImpl = fetchImpl;
  const everymac = new EveryMacProvider();
  everymac.minIntervalMs = 0;
  const service = new AppleCatalogService(repo as any, dataSource as any, provider, everymac);
  return { repo, service, everymac };
}

const response = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  text: async () => JSON.stringify(body),
});
// Feed "real" congelado: el subconjunto AppleDB empaquetado más un modelo nuevo.
const feedDevices = [...APPLEDB_BASELINE.devices, { key: 'iPhone99,1', name: 'iPhone 30', type: 'iPhone', released: '2036-09-20', model: ['A9998'] }];
const okFetch = (devices: any[] = feedDevices) => jest.fn(async (url: string) =>
  url.includes('/group/') ? response(200, APPLEDB_BASELINE.groups) : response(200, devices, { etag: 'W/"v1"' }));

describe('AppleCatalogService sincronización', () => {
  it('publica una versión válida, es idempotente al repetir y el nuevo modelo aparece en formularios', async () => {
    const { repo, service } = setup(okFetch());
    const first = await service.syncNow('manual');
    expect(first.status).toBe('published');
    expect(first.diff!.added).toContain('iphone-30-normal');
    const forms = await service.forms('iphone');
    expect(forms.models.map((m) => m.id)).toContain('iphone-30-normal');

    const second = await service.syncNow('manual');
    expect(second.status).toBe('unchanged');
    expect(repo.rows.filter((r) => r.kind === KIND_SNAPSHOT)).toHaveLength(1);
  });

  it('feed vacío o con familias perdidas se rechaza y conserva la versión válida', async () => {
    const { service } = setup(okFetch());
    await service.syncNow('manual');
    const before = (await service.getCatalog()).version;

    const { service: s2, repo } = setup(okFetch());
    await s2.syncNow('manual');
    (s2 as any).provider.fetchImpl = okFetch([]);
    const rejected = await s2.syncNow('manual');
    expect(rejected.status).toBe('rejected');
    (s2 as any).invalidate();
    expect((await s2.getCatalog()).models.some((m) => m.id === 'iphone-30-normal')).toBe(true);
    expect(repo.rows.find((r) => r.kind === 'apple_catalog_state').metadata.lastResult).toBe('rejected');
    expect(before).toBeTruthy();
  });

  it('caída de la fuente conserva el catálogo y registra el error; 304 no publica', async () => {
    const { service, repo } = setup(jest.fn(async () => { throw new Error('ECONNRESET'); }));
    const failed = await service.syncNow('manual');
    expect(failed.status).toBe('failed');
    expect((await service.getCatalog()).models.length).toBeGreaterThan(100);
    expect(repo.rows.find((r) => r.kind === 'apple_catalog_state').metadata.lastError).toMatch(/ECONNRESET/);

    const notModified = setup(jest.fn(async () => response(304, null)));
    expect((await notModified.service.syncNow('manual')).status).toBe('not_modified');
  });

  it('un modelo que desaparece del feed se conserva consultable (retenido)', async () => {
    const { service } = setup(okFetch());
    await service.syncNow('manual');
    (service as any).provider.fetchImpl = okFetch(feedDevices.filter((d) => d.key !== 'iPhone99,1'));
    const outcome = await service.syncNow('manual');
    expect(outcome.status).toBe('published');
    const model = (await service.getCatalog()).models.find((m) => m.id === 'iphone-30-normal');
    expect(model?.retired).toBe(true);
  });
});

describe('AppleCatalogService validación de productos', () => {
  const { service } = setup(okFetch());

  it('alta: rechaza RAM en iPhone, pantalla fuera de catálogo y modelo desconocido', async () => {
    expect((await service.validateProductoDetalle('iphone', { numero: '16', modelo: 'Pro', almacenamiento: '256', ram: '8' })).errors[0]).toMatch(/ram/);
    expect((await service.validateProductoDetalle('ipad', { gama: 'Mini', generacion: '6', tamano: '11', almacenamiento: '64', conexion: 'Wifi' })).errors[0]).toMatch(/tamano/);
    expect((await service.validateProductoDetalle('iphone', { numero: '99', modelo: 'Pro' })).errors[0]).toMatch(/no reconocido/);
    expect((await service.validateProductoDetalle('iphone', { numero: '', modelo: '', almacenamiento: '' })).errors[0]).toMatch(/no reconocido/);
    expect((await service.validateProductoDetalle('ipad', { gama: 'Mini', generacion: '6', tamano: '8.3', almacenamiento: '256', conexion: 'Wifi + Cel' })).errors).toEqual([]);
  });

  it('alta: exige guardar la opción única comprobada (pantalla del Mini 5)', async () => {
    const result = await service.validateProductoDetalle('ipad', { gama: 'Mini', generacion: '5', almacenamiento: '64', conexion: 'Wifi' });
    expect(result.errors[0]).toMatch(/7.9/);
  });

  it('edición: conserva valores legados que no cambian y valida solo lo modificado', async () => {
    const previous = { numero: '13', modelo: 'Pro', almacenamiento: '128', ram: '6' };
    const unchanged = await service.validateProductoDetalle('iphone', { ...previous }, previous);
    expect(unchanged.errors).toEqual([]);
    expect(unchanged.warnings[0]).toMatch(/legado/);
    const changed = await service.validateProductoDetalle('iphone', { ...previous, almacenamiento: '64' }, previous);
    expect(changed.errors[0]).toMatch(/almacenamiento/);
  });

  it('Mac mini no admite pantalla; AirPods 4 con ANC se valida por título estructurado', async () => {
    expect((await service.validateProductoDetalle('macmini', { procesador: 'M4', ram: '16', almacenamiento: '256', tamano: '24' })).errors[0]).toMatch(/tamano/);
    expect((await service.validateProductoDetalle('airpods', { modelo: 'AirPods 4 con ANC' })).errors).toEqual([]);
    expect((await service.validateProductoDetalle('airpods', { modelo: 'AirPods 5 sin ANC' })).errors[0]).toMatch(/no reconocido/);
  });
});

describe('dataset complementario', () => {
  it('valida estructura y procedencia antes de publicar', () => {
    expect(validateSpecsDataset({ version: 'x', models: [] }).errors.length).toBeGreaterThan(0);
    const bad = validateSpecsDataset({ version: '2027.01.01', models: [{ id: 'iphone-17-e', storages: { value: ['256'], provenance: { source: 'apple_official' } } }] });
    expect(bad.errors[0]).toMatch(/url y verifiedAt/);
    expect(validateSpecsDataset(APPLE_SPECS_DATASET).errors).toEqual([]);
  });

  it('previsualiza y publica una versión posterior sin tocar código; repetir no duplica', async () => {
    const { service, repo } = setup(okFetch());
    const next = {
      ...APPLE_SPECS_DATASET,
      version: '2026.10.23-1',
      models: [...APPLE_SPECS_DATASET.models.filter((m) => m.id !== 'iphone-17-e'),
        { id: 'iphone-17-e', storages: { value: ['256', '512'], provenance: { source: 'apple_official', url: 'https://www.apple.com/iphone-17e/specs/', verifiedAt: '2026-10-23' } } }],
    };
    const preview = await service.previewDataset(next);
    expect(preview).toMatchObject({ valid: true, newerThanCurrent: true });
    expect(preview.diff!.changed).toContain('iphone-17-e');
    expect((await service.publishDataset(next, 'admin')).status).toBe('published');
    expect((await service.publishDataset(next, 'admin')).status).toBe('unchanged');
    expect(repo.rows.filter((r) => r.kind === 'apple_specs_dataset')).toHaveLength(1);
    const sel = (await service.getModel('iphone-17-e')).model.selectors[0];
    expect(sel.options.map((o) => o.value)).toEqual(['256', '512']);
  });
});

describe('versiones del dataset', () => {
  it('compara tramos numéricamente (10 > 9)', () => {
    const { compareVersions } = jest.requireActual('./apple-catalog.service');
    expect(compareVersions('2026.10.22-10', '2026.10.22-9')).toBeGreaterThan(0);
    expect(compareVersions('2026.10.22-1', '2026.10.22-1')).toBe(0);
  });
});

describe('importación por enlaces de EveryMac', () => {
  const table = (n: number, pairs: Array<[string, string]>, details = '') =>
    `<table id="specs${n}-title"><tr>${pairs.map(([l, v]) => `<td>${l}:</td><td>${v}</td>`).join('')}</tr></table><table id="specs${n}"><tr><td>Details:</td><td>${details}</td></tr></table>`;
  const html = `<html><head><title>MacBook Air &quot;M6&quot; 10 CPU/10 GPU 13&quot; Specs (13-Inch, M6, 2027, A9500): EveryMac.com</title></head><body><div id="contentcenter_specs_table">${[
    table(1, [['Processor Type', 'Apple M6']]),
    table(2, [['Standard RAM', '16 GB'], ['Maximum RAM', '32 GB']], 'Configurable with 24 GB or 32 GB.'),
    table(3, [['Built-in Display', '13.6&quot; 16:10']]),
    table(4, [['Standard Storage', '512 GB SSD']], 'Also configurable with a 1 TB or 2 TB SSD for US$200 or US$600.'),
    table(5, [['Apple Order No', 'BTO/CTO'], ['Apple Subfamily', '13-Inch, M6, 2027']]),
    table(6, [['Apple Model No', 'A9500 (EMC 1)'], ['Model ID', 'Mac30,9']]),
  ].join('')}</div></body></html>`;
  const URL = 'https://everymac.com/systems/apple/macbook-air/specs/macbook-air-m6-10-core-cpu-10-core-gpu-13-2027-specs.html';

  it('previsualiza sin guardar, importa a la BD, no duplica y el modelo nuevo sale en los selectores', async () => {
    const { service, repo, everymac } = setup(okFetch());
    everymac.fetchImpl = jest.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => html })) as any;

    const preview: any = await service.everymacImport([URL], false);
    expect(preview.mode).toBe('preview');
    expect(preview.results[0]).toMatchObject({ ok: true, modelId: 'macbook-air-m6', nuevo: true, config: { chip: 'M6', pantalla: '13', ram: ['16', '24', '32'], almacenamiento: ['512', '1TB', '2TB'] } });
    expect(repo.rows.filter((r) => r.kind === 'apple_everymac_page')).toHaveLength(0);

    const saved: any = await service.everymacImport([URL], true, 'admin');
    expect(saved.saved).toBe(1);
    await service.everymacImport([URL], true, 'admin');
    expect(repo.rows.filter((r) => r.kind === 'apple_everymac_page')).toHaveLength(1);
    expect((everymac.fetchImpl as jest.Mock).mock.calls).toHaveLength(1); // la vista previa y la importación reutilizan la lectura

    const forms = await service.forms('macbook');
    const m6 = forms.models.find((m) => m.id === 'macbook-air-m6')!;
    expect(m6).toMatchObject({ listed: true, detalle: { gama: 'Air', procesador: 'M6' } });
    expect(m6.selectors.map((s) => [s.field, s.options.map((o) => o.value)])).toEqual([['tamano', ['13']], ['ram', ['16', '24', '32']], ['almacenamiento', ['512', '1TB', '2TB']]]);
    expect((await service.validateProductoDetalle('macbook', { gama: 'Air', procesador: 'M6', tamano: '13', ram: '24', almacenamiento: '1TB' })).errors).toEqual([]);
  });

  it('rechaza enlaces que no son fichas de EveryMac', async () => {
    const { service } = setup(okFetch());
    await expect(service.everymacImport(['https://example.com/x.html'], false)).rejects.toThrow('Enlace no admitido');
  });
});
