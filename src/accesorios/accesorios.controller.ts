import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AccesoriosService } from './accesorios.service';
import { EditReferenciaDto, IngresoAccesorioDto, ReferenciaDto } from './accesorios.dto';
import { CurrentUser, JwtUserPayload } from '../auth/decorators/current-user.decorator';
import { VinculosService } from './vinculos.service';
import { AplicarVinculosDto, CambioInformativoDto, DeshacerVinculosDto, RechazarVinculoDto } from './vinculos.dto';

@Controller('accesorios')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AccesoriosController {
  constructor(private readonly svc: AccesoriosService, private readonly links: VinculosService) {}
  private actor(user: JwtUserPayload) { return `${user.userId}:${user.username}`; }
  @Roles('admin') @Post('vinculos/generar') generar() { return this.links.generar(); }
  @Roles('admin') @Get('vinculos') listar(@Query() query: any) { return this.links.listar(query); }
  @Roles('admin') @Get('vinculos/auditoria') auditoria(@Query() query: any) { return this.links.auditoria(query); }
  @Roles('admin') @Post('vinculos/aplicar') aplicar(@Body() dto: AplicarVinculosDto, @CurrentUser() user: JwtUserPayload) { return this.links.aplicar(dto, this.actor(user)); }
  @Roles('admin') @Post('vinculos/deshacer') deshacer(@Body() dto: DeshacerVinculosDto, @CurrentUser() user: JwtUserPayload) { return this.links.deshacer(dto, this.actor(user)); }
  @Roles('admin') @Post('vinculos/:id/rechazar') rechazar(@Param('id', ParseIntPipe) id: number, @Body() dto: RechazarVinculoDto, @CurrentUser() user: JwtUserPayload) { return this.links.rechazar(id, this.actor(user), dto.motivo); }
  @Roles('admin') @Patch('lotes/:id/tipo-cambio-informativo') cambio(@Param('id', ParseIntPipe) id: number, @Body() dto: CambioInformativoDto) { return this.links.cambioInformativo(id, dto.tipoCambioCompra); }
  @Get('referencias') search(@Query() params: any) { return this.svc.searchReferences(params); }
  @Get('referencias/:id') get(@Param('id', ParseIntPipe) id: number) { return this.svc.getReference(id); }
  @Roles('admin') @Post('referencias') create(@Body() dto: ReferenciaDto) { return this.svc.createReference(dto); }
  @Roles('admin') @Patch('referencias/:id') update(@Param('id', ParseIntPipe) id: number, @Body() dto: EditReferenciaDto) { return this.svc.updateReference(id, dto); }
  @Roles('admin') @Delete('referencias/:id') deactivate(@Param('id', ParseIntPipe) id: number) { return this.svc.deactivateReference(id); }
  @Roles('admin') @Post('ingresos') ingreso(@Body() dto: IngresoAccesorioDto) { return this.svc.ingreso(dto); }
  @Get('operativo') operativo() { return this.svc.operativo(); }
}
