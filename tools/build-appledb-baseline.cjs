#!/usr/bin/env node
/*
 * Congela un subconjunto mínimo de AppleDB (licencia MIT, littlebyteorg/appledb)
 * como línea base del catálogo Apple cuando la BD aún no tiene una versión publicada.
 *
 * Uso:
 *   node tools/build-appledb-baseline.cjs                 # descarga los JSON públicos
 *   node tools/build-appledb-baseline.cjs main.json group.json
 *
 * Solo lee device/main.json y group/main.json (sin firmware ni sistemas operativos).
 * El filtrado y la minimización son los mismos que aplica la sincronización en
 * src/apple-catalog/appledb.normalizer.ts (minimizeAppleDbSource).
 */
const fs = require('fs');
const path = require('path');

const DEVICE_URL = 'https://api.appledb.dev/device/main.json';
const GROUP_URL = 'https://api.appledb.dev/group/main.json';
const OUT = path.join(__dirname, '..', 'src', 'apple-catalog', 'data', 'appledb-baseline.data.ts');

// Debe coincidir con APPLEDB_SOURCE_TYPES en appledb.normalizer.ts.
const TYPES = new Set([
  'iPhone', 'iPad', 'iPad mini', 'iPad Air', 'iPad Pro', 'Apple Watch', 'AirPods',
  'MacBook Air', 'MacBook Pro', 'MacBook Neo', 'iMac', 'Mac mini', 'Mac Studio', 'Mac Pro',
]);

async function load(arg, url) {
  if (arg) return JSON.parse(fs.readFileSync(arg, 'utf8'));
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

const pickInfo = (info) => (Array.isArray(info) ? info : [])
  .filter((block) => block && ['Memory', 'Display'].includes(block.type))
  .map((block) => block.type === 'Memory'
    ? { type: 'Memory', RAM: block.RAM, Storage: block.Storage }
    : { type: 'Display', Screen_Size: block.Screen_Size });

async function main() {
  const [devices, groups] = await Promise.all([load(process.argv[2], DEVICE_URL), load(process.argv[3], GROUP_URL)]);
  if (!Array.isArray(devices) || !Array.isArray(groups)) throw new Error('Formato AppleDB inesperado');
  const minDevices = devices
    .filter((d) => d && TYPES.has(d.type))
    .map((d) => {
      const out = { key: d.key, name: d.name, type: d.type };
      for (const k of ['identifier', 'model', 'soc', 'released', 'discontinued', 'internal']) if (d[k] !== undefined) out[k] = d[k];
      if (Array.isArray(d.colors)) out.colors = d.colors.map((c) => ({ key: c.key, name: c.name, hex: c.hex }));
      const info = pickInfo(d.info);
      if (info.length) out.info = info;
      return out;
    })
    .sort((a, b) => String(a.key).localeCompare(String(b.key)));
  const minGroups = groups
    .filter((g) => g && TYPES.has(g.type))
    .map((g) => ({ key: g.key, name: g.name, type: g.type, devices: g.devices }))
    .sort((a, b) => String(a.key).localeCompare(String(b.key)));
  const header = `/* eslint-disable */
// Generado por tools/build-appledb-baseline.cjs el ${new Date().toISOString().slice(0, 10)}.
// Datos: AppleDB (https://github.com/littlebyteorg/appledb), licencia MIT,
// Copyright (c) 2022 emiyl (aviso completo en ./APPLEDB_LICENSE.txt). No incluye imágenes.
// Subconjunto de device/main.json y group/main.json (${minDevices.length} dispositivos, ${minGroups.length} grupos).
import type { AppleDbSource } from '../apple-catalog.types';

export const APPLEDB_BASELINE: AppleDbSource = `;
  const body = JSON.stringify({ fetchedAt: new Date().toISOString(), sourceUrl: DEVICE_URL, devices: minDevices, groups: minGroups });
  fs.writeFileSync(OUT, `${header}${body};\n`);
  console.log(`OK ${OUT} devices=${minDevices.length} groups=${minGroups.length} bytes=${body.length}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
