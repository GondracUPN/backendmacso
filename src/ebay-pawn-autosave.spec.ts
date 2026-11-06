import { Repository } from 'typeorm';
import { EbayPawn } from './ebay-pawn.entity';
import { EbayPawnAutoSave, hasBravoPawnEvidence } from './ebay-pawn-autosave';

const listing = (seller = 'new-pawn', itemId = 'v1|123|0') => ({ seller, itemId, title: 'Apple MacBook (P13023745)', storeName: seller, itemWebUrl: 'https://www.ebay.com/itm/123' });
const setup = () => {
  const transactionalRepo = { findOne: jest.fn().mockResolvedValue(null), create: jest.fn((row) => row), save: jest.fn().mockResolvedValue({ id: 1 }) };
  const manager = { query: jest.fn(), getRepository: jest.fn(() => transactionalRepo) };
  const repo = { findOne: jest.fn().mockResolvedValue(null), manager: { transaction: jest.fn(async (callback) => callback(manager)) } };
  const detail = jest.fn().mockResolvedValue({ description: '<p>Powered by Bravo Store Systems</p>' });
  const onError = jest.fn();
  const worker = new EbayPawnAutoSave(repo as unknown as Repository<EbayPawn>, detail, onError);
  return { worker, repo, transactionalRepo, manager, detail, onError };
};

test.each([
  '<p>Powered <span>by</span> Bravo Store Systems</p>',
  '<div>BRAVO&nbsp;STORE&nbsp;SYSTEMS</div>',
  '<a href="https://www.bravostoresystems.com/">Software</a>',
])('confirma Bravo por la descripción y sus enlaces: %s', (html) => expect(hasBravoPawnEvidence(html)).toBe(true));

test.each([
  'Pawn shop with 10000 reviews', 'Powered by Buya', 'Powered by PawnMaster', 'Bravo electronics',
  '<a href="https://bravostoresystems.com.fake.test/">Software</a>',
  '<script>Bravo Store Systems</script>',
])('no autoguarda señales que no confirman Bravo: %s', (html) => expect(hasBravoPawnEvidence(html)).toBe(false));

test('guarda una tienda nueva con su vendedor exacto y un enlace reutilizable', async () => {
  const { worker, transactionalRepo, manager } = setup();
  expect(worker.enqueue([listing('New.Pawn-1')], [])).toBeUndefined();
  await worker.whenIdle();
  expect(manager.query).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext($1))', ['ebay-pawn-autosave:new.pawn-1']);
  expect(transactionalRepo.save).toHaveBeenCalledWith({ seller: 'new.pawn-1', storeName: 'New.Pawn-1', storeUrl: 'https://www.ebay.com/usr/new.pawn-1', originalUrl: 'https://www.ebay.com/usr/new.pawn-1' });
});

test('no duplica tiendas registradas y distingue nombres parecidos', async () => {
  const { worker, detail, transactionalRepo } = setup();
  worker.enqueue([listing('NEW-PAWN'), listing('new-pawn-2')], [{ seller: 'new-pawn' }]);
  await worker.whenIdle();
  expect(detail).toHaveBeenCalledTimes(1);
  expect(detail).toHaveBeenCalledWith(expect.objectContaining({ seller: 'new-pawn-2' }));
  expect(transactionalRepo.save).toHaveBeenCalledTimes(1);
});

test('comprueba los datos actuales antes de verificar y antes de insertar', async () => {
  const { worker, repo, detail, transactionalRepo } = setup();
  repo.findOne.mockResolvedValueOnce({ id: 2 });
  worker.enqueue([listing()], []);
  await worker.whenIdle();
  expect(detail).not.toHaveBeenCalled();
  repo.findOne.mockResolvedValue(null);
  transactionalRepo.findOne.mockResolvedValue({ id: 3 });
  worker.enqueue([listing()], []);
  await worker.whenIdle();
  expect(detail).toHaveBeenCalledTimes(1);
  expect(transactionalRepo.save).not.toHaveBeenCalled();
});

test('un nombre pawn y un código de inventario no autorizan guardar sin Bravo', async () => {
  const { worker, detail, transactionalRepo } = setup();
  detail.mockResolvedValue({ description: 'Pawn1 sells on Buya. 50000 reviews.' });
  worker.enqueue([listing()], []);
  await worker.whenIdle();
  expect(transactionalRepo.save).not.toHaveBeenCalled();
});

test('revisa otra publicación del vendedor si la primera no contiene la evidencia', async () => {
  const { worker, detail, transactionalRepo } = setup();
  detail.mockResolvedValueOnce({ description: 'Apple computer' }).mockResolvedValueOnce({ description: 'Powered by Bravo Store Systems' });
  worker.enqueue([listing('pawn', '1'), listing('pawn', '2')], []);
  await worker.whenIdle();
  expect(detail).toHaveBeenCalledTimes(2);
  expect(transactionalRepo.save).toHaveBeenCalledTimes(1);
});

test('búsquedas simultáneas no encolan dos veces al mismo vendedor', async () => {
  const { worker, detail, transactionalRepo } = setup();
  worker.enqueue([listing()], []);
  worker.enqueue([listing('NEW-PAWN')], []);
  await worker.whenIdle();
  expect(detail).toHaveBeenCalledTimes(1);
  expect(transactionalRepo.save).toHaveBeenCalledTimes(1);
});

test('una búsqueda paralela puede aportar otra publicación que sí confirme Bravo', async () => {
  const { worker, detail, transactionalRepo } = setup();
  detail.mockResolvedValueOnce({ description: 'Apple computer' }).mockResolvedValueOnce({ description: 'Bravo Store Systems' });
  worker.enqueue([listing('new-pawn', '1')], []);
  worker.enqueue([listing('NEW-PAWN', '2')], []);
  await worker.whenIdle();
  expect(detail).toHaveBeenCalledTimes(2);
  expect(transactionalRepo.save).toHaveBeenCalledTimes(1);
});

test('los fallos de verificación o guardado no rompen la búsqueda y pueden reintentarse', async () => {
  const { worker, detail, transactionalRepo, onError } = setup();
  detail.mockRejectedValueOnce(new Error('network'));
  worker.enqueue([listing()], []);
  await worker.whenIdle();
  expect(transactionalRepo.save).not.toHaveBeenCalled();
  transactionalRepo.save.mockRejectedValueOnce(new Error('database'));
  worker.enqueue([listing()], []);
  await worker.whenIdle();
  expect(onError).toHaveBeenCalledTimes(1);
  worker.enqueue([listing()], []);
  await worker.whenIdle();
  expect(transactionalRepo.save).toHaveBeenCalledTimes(2);
});
