import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser, type JwtUserPayload } from '../auth/decorators/current-user.decorator';
import { AppleCatalogService } from './apple-catalog.service';

// Catálogo Apple propio. Lectura para usuarios autenticados; importar, publicar y corregir solo admin.
// No reemplaza /catalog/product-options ni los conceptos de gastos.
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('apple-catalog')
export class AppleCatalogController {
  constructor(private readonly svc: AppleCatalogService) {}

  /** Contrato completo de formularios (Productos e Inventario) en una sola respuesta cacheable por versión. */
  @Get('forms')
  forms(@Query('tipo') tipo?: string) {
    return this.svc.forms(tipo);
  }

  @Get('models')
  search(@Query('q') q?: string, @Query('tipo') tipo?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.svc.search({ q, tipo, page: Number(page), pageSize: Number(pageSize) });
  }

  @Get('models/:id')
  model(@Param('id') id: string) {
    return this.svc.getModel(id);
  }

  /** Candidatos a partir de Axxxx, códigos de pedido o identificadores de sistema en un texto. */
  @Get('identify')
  identify(@Query('q') q?: string) {
    return this.svc.identify(String(q || ''));
  }

  @Post('resolve')
  resolve(@Body() body: any) {
    return this.svc.resolve(String(body?.tipo || ''), body?.detalle || {});
  }

  @Roles('admin')
  @Get('sync/status')
  status() {
    return this.svc.status();
  }

  /** "Actualizar ahora": consulta AppleDB fuera de las lecturas y publica solo si el feed es válido. */
  @Roles('admin')
  @Post('sync')
  sync(@CurrentUser() user: JwtUserPayload) {
    return this.svc.syncNow('manual', user?.username || null);
  }

  @Roles('admin')
  @Get('coverage')
  coverage() {
    return this.svc.coverage();
  }

  @Roles('admin')
  @Get('reconcile')
  reconcile(@Query('limit') limit?: string) {
    return this.svc.reconcile(Number(limit) || 2000);
  }

  @Roles('admin')
  @Post('dataset/preview')
  previewDataset(@Body() body: any) {
    return this.svc.previewDataset(body?.dataset ?? body);
  }

  @Roles('admin')
  @Post('dataset/publish')
  publishDataset(@Body() body: any, @CurrentUser() user: JwtUserPayload) {
    return this.svc.publishDataset(body?.dataset ?? body, user?.username || null);
  }

  /** Vista previa de enlaces EveryMac (lee cada ficha una vez; no guarda). */
  @Roles('admin')
  @Post('everymac/preview')
  everymacPreview(@Body() body: any) {
    return this.svc.everymacImport(body?.urls, false);
  }

  /** Importa los enlaces: guarda las fichas en la BD y actualiza el catálogo de formularios. */
  @Roles('admin')
  @Post('everymac/import')
  everymacImport(@Body() body: any, @CurrentUser() user: JwtUserPayload) {
    return this.svc.everymacImport(body?.urls, true, user?.username || null);
  }

  @Roles('admin')
  @Get('everymac')
  everymacList() {
    return this.svc.everymacList();
  }

  @Roles('admin')
  @Delete('everymac/:id')
  everymacDisable(@Param('id', ParseIntPipe) id: number) {
    return this.svc.everymacDisable(id);
  }

  @Roles('admin')
  @Get('pending')
  pending() {
    return this.svc.pendingModels();
  }

  @Roles('admin')
  @Get('overrides')
  overrides() {
    return this.svc.listOverrides();
  }

  @Roles('admin')
  @Post('overrides')
  createOverride(@Body() body: any, @CurrentUser() user: JwtUserPayload) {
    return this.svc.createOverride(body, user?.username || null);
  }

  @Roles('admin')
  @Delete('overrides/:id')
  disableOverride(@Param('id', ParseIntPipe) id: number) {
    return this.svc.disableOverride(id);
  }
}
