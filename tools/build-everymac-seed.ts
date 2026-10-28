// Genera la semilla empaquetada de fichas EveryMac (importación autorizada) a partir de páginas ya
// descargadas una sola vez. Uso:
//   npx ts-node -T tools/build-everymac-seed.ts <carpeta-cache>
// Cada archivo de la carpeta es la ficha HTML cuyo nombre es la ruta tras /systems/apple/ con "/" → "__".
// Solo se conservan valores estructurados (EveryMacRecord), nunca el HTML ni textos descriptivos.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseEveryMacPage } from '../src/apple-catalog/everymac.parser';

const dir = process.argv[2];
if (!dir) {
  console.error('Uso: ts-node tools/build-everymac-seed.ts <carpeta-cache>');
  process.exit(1);
}
const records = readdirSync(dir)
  .filter((name) => name.endsWith('.html'))
  .sort()
  .map((name) => {
    const url = `https://everymac.com/systems/apple/${name.replace(/__/g, '/')}`;
    const fetchedAt = statSync(join(dir, name)).mtime.toISOString();
    return parseEveryMacPage(readFileSync(join(dir, name), 'utf8'), url, fetchedAt);
  });
const withWarnings = records.filter((r) => r.warnings.length);
const out = join(__dirname, '..', 'src', 'apple-catalog', 'data', 'everymac-seed.data.ts');
writeFileSync(out, `/* eslint-disable */
// Generado por tools/build-everymac-seed.ts el ${new Date().toISOString().slice(0, 10)} desde ${records.length} fichas de EveryMac
// (importación autorizada por EveryMac al titular). Solo valores estructurados; cada registro conserva su URL.
import type { EveryMacRecord } from '../everymac.parser';

export const EVERYMAC_SEED: EveryMacRecord[] = ${JSON.stringify(records, null, 1)};
`);
console.log(`OK ${records.length} fichas → ${out}; con avisos: ${withWarnings.length}`);
for (const r of withWarnings) console.log(` - ${r.url}: ${r.warnings.join(' ')}`);
