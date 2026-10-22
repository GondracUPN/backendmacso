// Credencial compartida con la API del catálogo (debe coincidir con su CATALOG_SYNC_SECRET).
// El catálogo rechaza /api/sync/* y /admin/sales-sync/remote-status sin ella.
export function catalogSyncHeaders(): Record<string, string> {
  const secret = String(process.env.CATALOG_SYNC_SECRET || '').trim();
  return secret ? { 'x-sync-secret': secret } : {};
}
