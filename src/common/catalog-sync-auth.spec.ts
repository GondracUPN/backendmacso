import { catalogSyncHeaders } from './catalog-sync-auth';

describe('catalogSyncHeaders', () => {
  const previous = process.env.CATALOG_SYNC_SECRET;
  afterEach(() => {
    if (previous === undefined) delete process.env.CATALOG_SYNC_SECRET;
    else process.env.CATALOG_SYNC_SECRET = previous;
  });

  it('envía el secreto configurado', () => {
    process.env.CATALOG_SYNC_SECRET = ' test-secret ';
    expect(catalogSyncHeaders()).toEqual({ 'x-sync-secret': 'test-secret' });
  });

  it('no añade cabecera sin secreto', () => {
    delete process.env.CATALOG_SYNC_SECRET;
    expect(catalogSyncHeaders()).toEqual({});
  });
});
