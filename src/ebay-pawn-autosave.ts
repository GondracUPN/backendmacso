import { Raw, Repository } from 'typeorm';
import { EbayPawn } from './ebay-pawn.entity';
import { BuyaEbayItem, buyaPlainText } from './ebay-buya';

// These checks deliberately exclude seller names, inventory-code patterns,
// feedback scores, and generic Buya/PawnMaster mentions.
export const hasBravoPawnEvidence = (description: string) => {
  const text = buyaPlainText(description);
  if (/\b(?:powered\s+by\s+bravo(?:\s+store\s+systems)?|bravo\s+store\s+systems)\b/i.test(text)) return true;
  for (const match of description.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)) {
    try {
      const url = new URL(match[1].replace(/^\/\//, 'https://'));
      if (['http:', 'https:'].includes(url.protocol) && ['bravostoresystems.com', 'www.bravostoresystems.com'].includes(url.hostname.toLowerCase())) return true;
    } catch { /* Not a Bravo link. */ }
  }
  return false;
};

const sellerKey = (seller: string) => String(seller || '').trim().toLowerCase();

/** A side effect of product search; never changes its query, items or paging. */
export class EbayPawnAutoSave {
  private tail: Promise<void> = Promise.resolve();
  private readonly pending = new Map<string, BuyaEbayItem[]>();
  private readonly checkedItems = new Map<string, number>();

  constructor(
    private readonly repo: Repository<EbayPawn>,
    private readonly detail: (item: BuyaEbayItem) => Promise<{ description?: string; shortDescription?: string }>,
    private readonly onError: () => void = () => {},
  ) {}

  enqueue(items: ReadonlyArray<Record<string, any>>, knownStores: ReadonlyArray<{ seller: string }>) {
    const known = new Set(knownStores.map((store) => sellerKey(store.seller)));
    const groups = new Map<string, BuyaEbayItem[]>();
    for (const item of items) {
      const seller = sellerKey(item.seller);
      if (!/^[a-z0-9][a-z0-9._-]{0,119}$/.test(seller) || known.has(seller) || !item.itemId) continue;
      const group = this.pending.get(seller) || groups.get(seller) || [];
      if (!group.some((other) => other.itemId === String(item.itemId))) group.push({
        ...item, itemId: String(item.itemId), seller: String(item.seller), title: String(item.title || ''), itemWebUrl: String(item.itemWebUrl || ''),
      });
      if (!this.pending.has(seller)) groups.set(seller, group);
    }
    for (const [seller, candidates] of groups) {
      this.pending.set(seller, candidates);
      this.tail = this.tail.then(async () => {
        const existing = await this.repo.findOne({ where: { seller: Raw((column) => `LOWER(TRIM(${column})) = :seller`, { seller }) } });
        if (existing) return;
        for (const item of candidates) {
          const key = `${seller}:${item.itemId}`;
          if ((this.checkedItems.get(key) || 0) > Date.now()) continue;
          let detail: { description?: string; shortDescription?: string };
          try { detail = await this.detail(item); } catch { continue; }
          const confirmed = hasBravoPawnEvidence(`${detail.description || ''} ${detail.shortDescription || ''}`);
          if (!confirmed) {
            this.checkedItems.set(key, Date.now() + 12 * 60 * 60 * 1000);
            if (this.checkedItems.size > 2000) this.checkedItems.delete(this.checkedItems.keys().next().value!);
            continue;
          }
          await this.saveConfirmed(seller, item);
          break;
        }
      }).catch(() => this.onError()).finally(() => this.pending.delete(seller));
    }
  }

  whenIdle() { return this.tail; }

  private async saveConfirmed(seller: string, item: BuyaEbayItem) {
    await this.repo.manager.transaction(async (manager) => {
      // Concurrent product searches must not insert the same seller twice.
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ebay-pawn-autosave:${seller}`]);
      const repo = manager.getRepository(EbayPawn);
      const existing = await repo.findOne({ where: { seller: Raw((column) => `LOWER(TRIM(${column})) = :seller`, { seller }) } });
      if (existing) return;
      const storeUrl = `https://www.ebay.com/usr/${encodeURIComponent(seller)}`;
      await repo.save(repo.create({
        seller, storeName: String(item.storeName || item.seller).trim().slice(0, 255) || seller,
        storeUrl, originalUrl: storeUrl,
      }));
    });
  }
}
