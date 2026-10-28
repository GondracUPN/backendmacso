// Informe de cobertura del catálogo Apple con lectura REAL de AppleDB (sin BD, sin escribir nada).
// Uso: npm run apple-catalog:coverage [-- --out ../docs/APPLE_CATALOG_COVERAGE.md] [-- --offline]
import { writeFileSync } from 'fs';
import { consolidateCatalog, coverageReport, hashJson } from '../apple-catalog/apple-catalog.consolidator';
import type { AppleDbSource } from '../apple-catalog/apple-catalog.types';
import { minimizeAppleDbSource } from '../apple-catalog/appledb.normalizer';
import { APPLEDB_DEVICE_URL, AppleDbProvider } from '../apple-catalog/appledb.provider';
import { APPLEDB_BASELINE } from '../apple-catalog/data/appledb-baseline.data';
import { APPLE_SPECS_DATASET } from '../apple-catalog/data/apple-specs.dataset';
import { EVERYMAC_SEED } from '../apple-catalog/data/everymac-seed.data';
import { datasetWithEveryMac } from '../apple-catalog/apple-catalog.service';

async function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const offline = args.includes('--offline');
  let appleDb: AppleDbSource = APPLEDB_BASELINE;
  let origin = 'línea base empaquetada';
  let rawCount = 0;
  if (!offline) {
    const fetched = await new AppleDbProvider().fetchSource();
    rawCount = fetched.devices?.length || 0;
    const min = minimizeAppleDbSource(fetched.devices || [], fetched.groups || []);
    appleDb = { fetchedAt: new Date().toISOString(), sourceUrl: APPLEDB_DEVICE_URL, etag: fetched.etag, lastModified: fetched.lastModified, ...min };
    origin = `lectura real ${APPLEDB_DEVICE_URL} (etag ${fetched.etag || '-'}, last-modified ${fetched.lastModified || '-'})`;
  }
  const catalog = consolidateCatalog({ appleDb, appleDbHash: hashJson({ devices: appleDb.devices, groups: appleDb.groups }), dataset: datasetWithEveryMac(APPLE_SPECS_DATASET, appleDb, EVERYMAC_SEED) });
  const rows = coverageReport(catalog);
  const lines: string[] = [];
  lines.push(`# Cobertura del catálogo Apple`, '');
  lines.push(`Generado: ${new Date().toISOString()} · Fuente: ${origin}${rawCount ? ` · ${rawCount} entradas totales en device/main.json` : ''}`);
  lines.push(`Dataset complementario: ${catalog.dataset.version} · Versión de catálogo: ${catalog.version}`, '');
  lines.push('## Clasificación de dispositivos AppleDB conservados', '');
  lines.push('| Clasificación | Dispositivos |', '| --- | ---: |');
  for (const [bucket, count] of Object.entries(catalog.report.byBucket)) lines.push(`| ${bucket} | ${count} |`);
  if (catalog.report.unclassified.length) lines.push('', `Sin clasificar: ${catalog.report.unclassified.map((u) => `${u.key} (${u.type})`).join(', ')}`);
  lines.push('', '## Cobertura por familia y campo comercial', '');
  lines.push('Cada celda: confirmados/total por procedencia (ficha oficial Apple · EveryMac · curado/reglas previas · AppleDB). Desconocido = hueco que requiere revisión.', '');
  lines.push('| Familia | Modelos | Campo | Confirmados | Oficial | EveryMac | Curado/reglas | AppleDB | Desconocidos |', '| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const row of rows) {
    for (const [field, stats] of Object.entries(row.fields)) {
      lines.push(`| ${row.tipo} | ${row.models} | ${field} | ${stats.confirmed}/${row.models} | ${stats.official} | ${stats.everymac} | ${stats.curated} | ${stats.appledb} | ${stats.unknown} |`);
    }
  }
  lines.push('', '## Huecos exactos', '');
  const gaps = rows.flatMap((row) => row.gaps.map((gap) => `- ${row.tipo}: \`${gap.modelId}\` → ${gap.field}`));
  lines.push(...(gaps.length ? gaps : ['- Ninguno']));
  lines.push('', '## Conflictos entre fuentes (pendientes)', '');
  const open = catalog.conflicts.filter((c) => !c.resolved);
  lines.push(...(open.length ? open.map((c) => `- \`${c.modelId}\` (${c.field}): ${c.detail}`) : ['- Ninguno']));
  lines.push('', '## Conflictos resueltos', '');
  lines.push(...catalog.conflicts.filter((c) => c.resolved).map((c) => `- \`${c.modelId}\` (${c.field}): ${c.detail}`));
  lines.push('', '## Modelos que requieren revisión', '');
  const review = catalog.models.filter((m) => m.needsReview.length);
  lines.push(...(review.length ? review.map((m) => `- \`${m.id}\` ${m.title}: ${m.needsReview.join(', ')}`) : ['- Ninguno']));
  lines.push('', '## Descubiertos por AppleDB fuera del alcance (no se ofrecen en formularios)', '');
  lines.push(catalog.models.filter((m) => !m.listed && !m.retired).map((m) => m.title).join(', ') || 'Ninguno');
  lines.push('', '## Modelos por familia (alcance comercial)', '');
  for (const row of rows) {
    lines.push(`- **${row.tipo}** (${row.models}): ${catalog.models.filter((m) => m.tipo === row.tipo && !m.retired && m.listed).map((m) => m.title).join(', ')}`);
  }
  const output = lines.join('\n') + '\n';
  if (outIndex >= 0 && args[outIndex + 1]) writeFileSync(args[outIndex + 1], output);
  process.stdout.write(output);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
