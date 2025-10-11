import { Controller, Get, Query } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly svc: AnalyticsService) {}

  @Get('summary')
  async summary(
    @Query('fromCompra') fromCompra?: string,
    @Query('toCompra') toCompra?: string,
    @Query('fromVenta') fromVenta?: string,
    @Query('toVenta') toVenta?: string,
    @Query('tipo') tipo?: string,
    @Query('estadoTracking') estadoTracking?: string,
    @Query('vendedor') vendedor?: string,
    @Query('transportista') transportista?: string,
    @Query('casillero') casillero?: string,
    @Query('lateDays') lateDays?: string,
    @Query('aging15') aging15?: string,
    @Query('aging30') aging30?: string,
    @Query('aging60') aging60?: string,
    @Query('marginThreshold') marginThreshold?: string,
  ) {
    return this.svc.summary({
      fromCompra,
      toCompra,
      fromVenta,
      toVenta,
      tipo,
      estadoTracking,
      vendedor,
      transportista,
      casillero,
      lateDays: lateDays ? Number(lateDays) : undefined,
      aging15: aging15 ? Number(aging15) : undefined,
      aging30: aging30 ? Number(aging30) : undefined,
      aging60: aging60 ? Number(aging60) : undefined,
      marginThreshold: marginThreshold ? Number(marginThreshold) : undefined,
    });
  }
}

