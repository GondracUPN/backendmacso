import { reservaActivaSql, ventaActivaSql } from '../venta/estado-comercial';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { In, Repository } from 'typeorm';
import { Producto } from '../producto/producto.entity';
import { Tracking } from '../tracking/tracking.entity';
import { UpdateInventarioDto } from './dto/update-inventario.dto';
import { Inventario } from './inventario.entity';
import { isAccessoryStock, normalizeIncludedAccessories } from '../producto/accessory-rules';
import { AppleCatalogService } from '../apple-catalog/apple-catalog.service';
import { validateInventoryValues, type InventoryValues } from '../apple-catalog/device-capabilities';

@Injectable()
export class InventarioService {
  constructor(
    @InjectRepository(Inventario)
    private readonly inventarioRepo: Repository<Inventario>,
    @InjectRepository(Producto)
    private readonly productoRepo: Repository<Producto>,
    private readonly configService: ConfigService,
    @Optional() private readonly appleCatalog?: AppleCatalogService,
  ) {
    const cloudinaryUrl = this.configService.get<string>('CLOUDINARY_URL') || '';
    if (cloudinaryUrl) {
      try {
        const parsed = new URL(cloudinaryUrl);
        cloudinary.config({
          cloud_name: parsed.hostname,
          api_key: decodeURIComponent(parsed.username),
          api_secret: decodeURIComponent(parsed.password),
          secure: true,
        });
      } catch {
        cloudinary.config({ secure: true });
      }
    }
  }

  async findDisponibles() {
    const productos = await this.productoRepo
      .createQueryBuilder('p')
      .leftJoinAndSelect('p.detalle', 'detalle')
      .leftJoinAndSelect('p.valor', 'valor')
      .leftJoinAndSelect('p.tracking', 'tracking')
      .where(
        `(LOWER(p.tipo) = 'accesorios' OR (
          EXISTS (
            SELECT 1 FROM tracking t
            WHERE t."productoId" = p.id
              AND (t.estado = :recogido OR t."fechaRecogido" IS NOT NULL)
          )
          AND NOT EXISTS (SELECT 1 FROM venta v WHERE v."productoId" = p.id AND ${ventaActivaSql()})
          AND NOT EXISTS (
            SELECT 1 FROM venta_adelanto va
            WHERE va."productoId" = p.id AND ${reservaActivaSql()}
          )
        ))`,
        { recogido: 'recogido' },
      )
      .andWhere('p."archivadoAt" IS NULL').andWhere("COALESCE(p.\"cierreMotivo\", '') <> 'no_comercializable'")
      .orderBy('p.id', 'DESC')
      .getMany();

    const ids = productos.map((producto) => producto.id);
    const fichas = ids.length
      ? await this.inventarioRepo.find({ where: { productoId: In(ids) } })
      : [];
    const fichaPorProducto = new Map(
      fichas.map((ficha) => [ficha.productoId, ficha]),
    );

    const reglas = await this.reglasPorProducto(productos);
    return productos.map((producto) => {
      const ficha = fichaPorProducto.get(producto.id) || null;
      return { producto, ficha, reglas: this.withCompleteness(reglas.get(producto.id), ficha) };
    });
  }

  /** Reglas de ficha calculadas en memoria con una sola carga del catálogo (sin consultas por fila). */
  private async reglasPorProducto(productos: Producto[]) {
    if (!this.appleCatalog || !productos.length) return new Map<number, any>();
    try {
      return await this.appleCatalog.inventoryRulesFor(productos.map((p) => ({ id: p.id, tipo: p.tipo, estado: p.estado, detalle: p.detalle as any })));
    } catch {
      return new Map<number, any>();
    }
  }

  private withCompleteness(reglas: any, ficha: Inventario | null) {
    if (!reglas || !this.appleCatalog) return reglas || null;
    return { ...reglas, completitud: this.appleCatalog.completeness((ficha || {}) as any, reglas) };
  }

  async findProductoByCode(productoId: number) {
    const producto = await this.productoRepo.findOne({
      where: { id: productoId },
      relations: ['detalle', 'valor', 'tracking'],
    });
    if (!producto) throw new NotFoundException(`Producto ${productoId} no encontrado.`);
    const ficha = await this.inventarioRepo.findOne({ where: { productoId } });
    const reglas = await this.reglasPorProducto([producto]);
    return { producto, ficha: ficha || null, reglas: this.withCompleteness(reglas.get(producto.id), ficha) };
  }

  async upsert(productoId: number, data: UpdateInventarioDto) {
    const producto = await this.assertProducto(productoId);
    let ficha = await this.inventarioRepo.findOne({ where: { productoId } });
    if (!ficha) {
      ficha = this.inventarioRepo.create({ productoId, accesorios: [] });
    }

    const cleanText = (value: unknown, max: number): string | null => {
      const cleaned = String(value ?? '').trim().slice(0, max);
      return cleaned || null;
    };
    const patch: Partial<Inventario> = {};
    if (data.cantidadStock !== undefined && isAccessoryStock(producto.tipo)) {
      const sold = Math.max(0, Number(producto.stockInicial || 0) - Number(producto.stockActual || 0));
      if (data.cantidadStock < sold) throw new BadRequestException(`No puedes bajar el total por debajo de ${sold} unidades vendidas.`);
      producto.stockInicial = data.cantidadStock;
      producto.stockActual = data.cantidadStock - sold;
      await this.productoRepo.save(producto);
    }
    if (data.enAlmacen !== undefined) patch.enAlmacen = data.enAlmacen;
    const avisos: string[] = [];
    const reglas = await this.reglasDeUnidad(producto);
    if (reglas) {
      // Validación semántica por modelo/conectividad: rechaza valores nuevos incompatibles
      // aunque el cliente esté manipulado y conserva los valores legados sin borrarlos.
      const input: InventoryValues = {
        serial: data.serial, imei: data.imei, imei2: data.imei2, color: data.color,
        saludBateria: data.saludBateria, ciclosBateria: data.ciclosBateria,
      };
      const stored: InventoryValues = {
        serial: ficha.serial, imei: ficha.imei, imei2: ficha.imei2, color: ficha.color,
        saludBateria: ficha.saludBateria, ciclosBateria: ficha.ciclosBateria,
      };
      const checked = validateInventoryValues(input, stored, reglas);
      if (checked.errors.length) throw new BadRequestException(checked.errors.join(' '));
      avisos.push(...checked.warnings);
      for (const key of Object.keys(checked.patch) as Array<keyof InventoryValues>) (patch as any)[key] = checked.patch[key];
      await this.assertIdentificadoresUnicos(productoId, { ...stored, ...checked.patch }, stored, avisos);
    } else {
      if (data.color !== undefined) patch.color = cleanText(data.color, 80);
      if (data.ciclosBateria !== undefined) patch.ciclosBateria = data.ciclosBateria;
      if (data.saludBateria !== undefined) patch.saludBateria = data.saludBateria;
      if (data.serial !== undefined) patch.serial = cleanText(data.serial, 120);
      if (data.imei !== undefined) patch.imei = cleanText(data.imei, 40);
      if (data.imei2 !== undefined) patch.imei2 = cleanText(data.imei2, 40);
    }
    if (data.primerPrecioSoles !== undefined) {
      patch.primerPrecioSoles = data.primerPrecioSoles;
    }
    if (data.ultimoPrecioSoles !== undefined) {
      patch.ultimoPrecioSoles = data.ultimoPrecioSoles;
    }
    if (data.garantiaHasta !== undefined) {
      patch.garantiaHasta = cleanText(data.garantiaHasta, 10);
    }
    if (data.tieneGarantia !== undefined) patch.tieneGarantia = data.tieneGarantia;
    if (data.tipoGarantia !== undefined) {
      patch.tipoGarantia = cleanText(data.tipoGarantia, 30);
    }
    if (data.garantiaDetalle !== undefined) {
      patch.garantiaDetalle = cleanText(data.garantiaDetalle, 180);
    }
    if (data.observaciones !== undefined) {
      patch.observaciones = cleanText(data.observaciones, 3000);
    }
    if (data.fotosTomadas !== undefined) patch.fotosTomadas = data.fotosTomadas;
    if (data.marketplaceSubido !== undefined) {
      patch.marketplaceSubido = data.marketplaceSubido;
    }
    if (data.accesorios !== undefined) {
      const accesorios = Array.from(
        new Set(data.accesorios.map((item) => cleanText(item, 80)).filter(Boolean)),
      ) as string[];
      patch.accesorios = isAccessoryStock(producto.tipo) ? [] : accesorios.some((item) => item.toLowerCase() === 'ninguno')
        ? ['Ninguno']
        : normalizeIncludedAccessories(producto.tipo, accesorios, (producto.detalle as any)?.modelo);
    }

    Object.assign(ficha, patch);
    if (!ficha.tieneGarantia) {
      ficha.tipoGarantia = null;
      ficha.garantiaHasta = null;
      ficha.garantiaDetalle = null;
    } else if (!['limitada', 'applecare'].includes(String(ficha.tipoGarantia || ''))) {
      throw new BadRequestException('Selecciona el tipo de garantia.');
    } else if (ficha.tipoGarantia === 'limitada' && !ficha.garantiaHasta) {
      throw new BadRequestException('La garantia limitada requiere una fecha de vencimiento.');
    }
    const completitud = reglas && this.appleCatalog ? this.appleCatalog.completeness(ficha as any, reglas) : null;
    if (data.exigirCompleta && completitud && !completitud.complete) {
      throw new BadRequestException(`Ficha incompleta: falta ${completitud.missing.join(', ') || 'resolver el modelo'}.`);
    }
    const importedReceipt = data.enAlmacen === true && producto.referenciaId && producto.origen === 'accesorio_importado';
    const saved = importedReceipt ? await this.inventarioRepo.manager.transaction(async (manager) => {
      // Receiving a newly referenced import releases that lot from transit.
      for (const tracking of producto.tracking || []) {
        if (!tracking.fechaRecogido && tracking.estado !== 'recogido') {
          await manager.getRepository(Tracking).update(tracking.id, { estado: 'recogido', fechaRecogido: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' }) });
        }
      }
      return manager.getRepository(Inventario).save(ficha);
    }) : await this.inventarioRepo.save(ficha);
    return Object.assign(saved, { avisos, ...(completitud ? { completitud } : {}) });
  }

  private async reglasDeUnidad(producto: Producto) {
    if (!this.appleCatalog || !producto?.tipo || isAccessoryStock(producto.tipo)) return null;
    const catalog = await this.appleCatalog.getCatalog();
    return this.appleCatalog.rulesWithCatalog(catalog, { tipo: producto.tipo, estado: producto.estado, detalle: producto.detalle as any });
  }

  /**
   * IMEI/serial repetidos entre unidades. No bloquea la misma ficha ni el reingreso legítimo
   * de una unidad cuyo registro anterior está vendido, archivado o cerrado.
   */
  private async assertIdentificadoresUnicos(productoId: number, next: InventoryValues, stored: InventoryValues, avisos: string[]) {
    const imeis = [next.imei, next.imei2].filter((value, index) => value && value !== [stored.imei, stored.imei2][index]) as string[];
    const serial = next.serial && next.serial !== stored.serial ? String(next.serial).toUpperCase() : null;
    if (!imeis.length && !serial) return;
    if (typeof (this.inventarioRepo as any).query !== 'function') return;
    const rows: Array<{ productoId: number; historico: boolean }> = await this.inventarioRepo.query(
      `SELECT i."productoId",
              (p."archivadoAt" IS NOT NULL OR COALESCE(p."cierreMotivo", '') <> ''
               OR EXISTS (SELECT 1 FROM venta v WHERE v."productoId" = p.id AND ${ventaActivaSql()})) AS historico
         FROM inventario i
         JOIN producto p ON p.id = i."productoId"
        WHERE i."productoId" <> $1
          AND (i.imei = ANY($2::text[]) OR i.imei2 = ANY($2::text[])
               OR ($3::text IS NOT NULL AND UPPER(REPLACE(i.serial, ' ', '')) = $3::text))
        LIMIT 5`,
      [productoId, imeis, serial],
    );
    const activos = rows.filter((row) => !row.historico);
    if (activos.length) {
      throw new ConflictException(`Identificador ya registrado en otra unidad activa (producto #${activos.map((r) => r.productoId).join(', #')}).`);
    }
    if (rows.length) avisos.push(`Identificador presente en registros históricos (producto #${rows.map((r) => r.productoId).join(', #')}); posible reingreso.`);
  }

  async uploadFoto(productoId: number, dataUrl: string) {
    await this.assertProducto(productoId);
    if (!this.configService.get<string>('CLOUDINARY_URL')) {
      throw new ServiceUnavailableException('Cloudinary no esta configurado.');
    }
    if (!/^data:image\/(?:jpeg|jpg|png|webp|heic|heif);base64,/i.test(dataUrl)) {
      throw new BadRequestException('La foto debe ser JPG, PNG, WEBP, HEIC o HEIF.');
    }
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const estimatedBytes = Math.ceil((base64.length * 3) / 4);
    if (estimatedBytes > 8 * 1024 * 1024) {
      throw new BadRequestException('La foto no puede superar 8 MB.');
    }

    let ficha = await this.inventarioRepo.findOne({ where: { productoId } });
    if (!ficha) ficha = this.inventarioRepo.create({ productoId, accesorios: [] });
    const anteriorPublicId = ficha.fotoPublicId;

    const uploaded = await cloudinary.uploader.upload(dataUrl, {
      folder: 'macsomenos/inventario',
      public_id: `producto-${productoId}-${Date.now()}`,
      resource_type: 'image',
      transformation: [
        { width: 2000, height: 2000, crop: 'limit', quality: 'auto:good' },
      ],
    });
    ficha.fotoUrl = uploaded.secure_url;
    ficha.fotoPublicId = uploaded.public_id;
    ficha.enAlmacen = true;
    const saved = await this.inventarioRepo.save(ficha);

    if (anteriorPublicId && anteriorPublicId !== uploaded.public_id) {
      await cloudinary.uploader.destroy(anteriorPublicId).catch(() => undefined);
    }
    return saved;
  }

  async findPhotoCovers(productoIds: number[]) {
    const ids = Array.from(new Set((productoIds || [])
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0)));
    if (!ids.length) throw new BadRequestException('Selecciona productos con foto.');

    const fichas = await this.inventarioRepo.find({
      where: { productoId: In(ids) },
    });
    const fichaByProducto = new Map(fichas.map((ficha) => [ficha.productoId, ficha]));
    return ids
      .map((productoId) => fichaByProducto.get(productoId))
      .filter((ficha): ficha is Inventario => Boolean(ficha?.fotoUrl));
  }

  async findAllAvailablePhotoCovers() {
    return this.inventarioRepo
      .createQueryBuilder('i')
      .innerJoin('i.producto', 'p')
      .where('i."fotosTomadas" = true')
      .andWhere(
        `EXISTS (
          SELECT 1 FROM tracking t
          WHERE t."productoId" = p.id
            AND (t.estado = :recogido OR t."fechaRecogido" IS NOT NULL)
        )`,
        { recogido: 'recogido' },
      )
      .andWhere(`NOT EXISTS (SELECT 1 FROM venta v WHERE v."productoId" = p.id AND ${ventaActivaSql()})`)
      .andWhere(
        `NOT EXISTS (
          SELECT 1 FROM venta_adelanto va
          WHERE va."productoId" = p.id AND ${reservaActivaSql()}
        )`,
      )
      .orderBy('i."productoId"', 'DESC')
      .getMany();
  }

  async deleteFoto(productoId: number) {
    const ficha = await this.inventarioRepo.findOne({ where: { productoId } });
    if (!ficha) throw new NotFoundException('Ficha de inventario no encontrada.');
    if (ficha.fotoPublicId && this.configService.get<string>('CLOUDINARY_URL')) {
      await cloudinary.uploader.destroy(ficha.fotoPublicId).catch(() => undefined);
    }
    ficha.fotoUrl = null;
    ficha.fotoPublicId = null;
    return this.inventarioRepo.save(ficha);
  }

  private async assertProducto(productoId: number): Promise<Producto> {
    if (typeof (this.productoRepo as any).findOne !== 'function') {
      const exists = await this.productoRepo.exist({ where: { id: productoId } });
      if (!exists) throw new NotFoundException(`Producto ${productoId} no encontrado.`);
      return { id: productoId } as Producto;
    }
    const producto = await this.productoRepo.findOne({ where: { id: productoId }, relations: ['detalle'] });
    if (!producto) throw new NotFoundException(`Producto ${productoId} no encontrado.`);
    return producto;
  }
}
