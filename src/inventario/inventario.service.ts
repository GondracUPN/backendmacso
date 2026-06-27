import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { In, Repository } from 'typeorm';
import { Producto } from '../producto/producto.entity';
import { UpdateInventarioDto } from './dto/update-inventario.dto';
import { Inventario } from './inventario.entity';

@Injectable()
export class InventarioService {
  constructor(
    @InjectRepository(Inventario)
    private readonly inventarioRepo: Repository<Inventario>,
    @InjectRepository(Producto)
    private readonly productoRepo: Repository<Producto>,
    private readonly configService: ConfigService,
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
        `EXISTS (
          SELECT 1 FROM tracking t
          WHERE t."productoId" = p.id
            AND (t.estado = :recogido OR t."fechaRecogido" IS NOT NULL)
        )`,
        { recogido: 'recogido' },
      )
      .andWhere(
        'NOT EXISTS (SELECT 1 FROM venta v WHERE v."productoId" = p.id)',
      )
      .andWhere(
        `NOT EXISTS (
          SELECT 1 FROM venta_adelanto va
          WHERE va."productoId" = p.id AND va."completadoAt" IS NULL
        )`,
      )
      .orderBy('p.id', 'DESC')
      .getMany();

    const ids = productos.map((producto) => producto.id);
    const fichas = ids.length
      ? await this.inventarioRepo.find({ where: { productoId: In(ids) } })
      : [];
    const fichaPorProducto = new Map(
      fichas.map((ficha) => [ficha.productoId, ficha]),
    );

    return productos.map((producto) => ({
      producto,
      ficha: fichaPorProducto.get(producto.id) || null,
    }));
  }

  async findProductoByCode(productoId: number) {
    const producto = await this.productoRepo.findOne({
      where: { id: productoId },
      relations: ['detalle', 'valor', 'tracking'],
    });
    if (!producto) throw new NotFoundException(`Producto ${productoId} no encontrado.`);
    const ficha = await this.inventarioRepo.findOne({ where: { productoId } });
    return { producto, ficha: ficha || null };
  }

  async upsert(productoId: number, data: UpdateInventarioDto) {
    await this.assertProducto(productoId);
    let ficha = await this.inventarioRepo.findOne({ where: { productoId } });
    if (!ficha) {
      ficha = this.inventarioRepo.create({ productoId, accesorios: [] });
    }

    const cleanText = (value: unknown, max: number): string | null => {
      const cleaned = String(value ?? '').trim().slice(0, max);
      return cleaned || null;
    };
    const patch: Partial<Inventario> = {};
    if (data.enAlmacen !== undefined) patch.enAlmacen = data.enAlmacen;
    if (data.color !== undefined) patch.color = cleanText(data.color, 80);
    if (data.ciclosBateria !== undefined) patch.ciclosBateria = data.ciclosBateria;
    if (data.saludBateria !== undefined) patch.saludBateria = data.saludBateria;
    if (data.primerPrecioSoles !== undefined) {
      patch.primerPrecioSoles = data.primerPrecioSoles;
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
    if (data.serial !== undefined) patch.serial = cleanText(data.serial, 120);
    if (data.imei !== undefined) patch.imei = cleanText(data.imei, 40);
    if (data.imei2 !== undefined) patch.imei2 = cleanText(data.imei2, 40);
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
      patch.accesorios = accesorios.some((item) => item.toLowerCase() === 'ninguno')
        ? ['Ninguno']
        : accesorios;
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
    return this.inventarioRepo.save(ficha);
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
    ficha.fotosTomadas = true;
    const saved = await this.inventarioRepo.save(ficha);

    if (anteriorPublicId && anteriorPublicId !== uploaded.public_id) {
      await cloudinary.uploader.destroy(anteriorPublicId).catch(() => undefined);
    }
    return saved;
  }

  async deleteFoto(productoId: number) {
    const ficha = await this.inventarioRepo.findOne({ where: { productoId } });
    if (!ficha) throw new NotFoundException('Ficha de inventario no encontrada.');
    if (ficha.fotoPublicId && this.configService.get<string>('CLOUDINARY_URL')) {
      await cloudinary.uploader.destroy(ficha.fotoPublicId).catch(() => undefined);
    }
    ficha.fotoUrl = null;
    ficha.fotoPublicId = null;
    ficha.fotosTomadas = false;
    return this.inventarioRepo.save(ficha);
  }

  private async assertProducto(productoId: number) {
    const exists = await this.productoRepo.exist({ where: { id: productoId } });
    if (!exists) throw new NotFoundException(`Producto ${productoId} no encontrado.`);
  }
}
