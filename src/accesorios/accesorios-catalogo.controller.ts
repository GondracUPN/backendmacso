import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AccesoriosCatalogoService } from './accesorios-catalogo.service';
import { CatalogEventGuard } from '../auth/guards/catalog-event.guard';

export class SeleccionCatalogoDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @IsString({ each: true }) @MaxLength(100, { each: true }) keys: string[];
  @IsBoolean() seleccionado: boolean;
}
@Controller('accesorios/catalogo')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class AccesoriosCatalogoController {
  constructor(private readonly svc: AccesoriosCatalogoService) {}
  @Get() list() { return this.svc.list(); }
  @Post('seleccion') select(@Body() dto: SeleccionCatalogoDto) { return this.svc.select(dto.keys, dto.seleccionado); }
  @Post('sincronizar') async synchronize() { await this.svc.synchronize(); return this.svc.list(); }
}

export class RetiroAccesorioDto {
  @IsString() @MaxLength(100) sku: string;
}

@Controller('integrations/catalog-accessories')
@UseGuards(CatalogEventGuard)
export class AccesoriosCatalogoSyncController {
  constructor(private readonly svc: AccesoriosCatalogoService) {}
  @Post('withdraw') withdraw(@Body() dto: RetiroAccesorioDto) { return this.svc.withdrawFromCatalog(dto.sku); }
}
