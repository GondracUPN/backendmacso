import {
  prepareLocalDatabase,
  shouldSynchronizeLocalDatabase,
} from './local-schema';
describe('synchronize local contra BD de pruebas', () => {
  it.each(['development', 'test', ''])(
    'habilita synchronize local por defecto en %s',
    (env) => expect(shouldSynchronizeLocalDatabase(env)).toBe(true),
  );
  it.each(['production', 'prod', ' Production '])(
    'jamás habilita synchronize en %s aunque DB_SYNC=true',
    (env) => expect(shouldSynchronizeLocalDatabase(env, 'true')).toBe(false),
  );
  it('respeta la desactivación local explícita', () =>
    expect(shouldSynchronizeLocalDatabase('development', 'false')).toBe(false));
  it('no prepara ni modifica esquemas con synchronize apagado', async () => {
    const ds = {
      options: { synchronize: false },
      createQueryRunner: jest.fn(),
    };
    await prepareLocalDatabase(ds as any);
    expect(ds.createQueryRunner).not.toHaveBeenCalled();
  });
});
