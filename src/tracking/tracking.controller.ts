// src/tracking/tracking.controller.ts
import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Param,
  Body,
  ParseIntPipe,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { TrackingService } from './tracking.service';
import { CreateTrackingDto } from './dto/create-tracking.dto';
import { UpdateTrackingDto } from './dto/update-tracking.dto';

@Controller('tracking')
export class TrackingController {
  constructor(private readonly svc: TrackingService) {}

  // Obtener tracking por Producto
  @Get('producto/:pid')
  getByProducto(@Param('pid', ParseIntPipe) pid: number) {
    return this.svc.findByProducto(pid);
  }

  // Obtener tracking por ID
  @Get(':id')
  async getOne(@Param('id', ParseIntPipe) id: number) {
    const t = await this.svc['repo'].findOne({ where: { id } });
    if (!t) throw new NotFoundException(`Tracking ${id} no encontrado`);
    return t;
  }

  // Crear tracking (requiere productoId en el body)
  @Post()
  create(
    @Body(new ValidationPipe({ whitelist: true })) dto: CreateTrackingDto,
  ) {
    return this.svc.create(dto);
  }

  // Upsert por producto: si existe lo actualiza, si no crea uno nuevo
  @Put('producto/:pid')
  async upsertByProducto(
    @Param('pid', ParseIntPipe) pid: number,
    @Body(new ValidationPipe({ whitelist: true }))
    body: Omit<CreateTrackingDto, 'productoId'>,
  ) {
    const existing = await this.svc.findByProducto(pid);
    if (existing) {
      return this.svc.update(existing.id, body as UpdateTrackingDto);
    }
    return this.svc.create({ ...(body as CreateTrackingDto), productoId: pid });
  }

  // Actualizar por ID
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ValidationPipe({ whitelist: true })) dto: UpdateTrackingDto,
  ) {
    return this.svc.update(id, dto);
  }
}
