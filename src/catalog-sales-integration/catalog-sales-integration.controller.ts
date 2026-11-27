import { Body, Controller, Get, Headers, Param, Post, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CatalogEventGuard } from '../auth/guards/catalog-event.guard';
import { CatalogSalesIntegrationService } from './catalog-sales-integration.service';
import { UpdateAccesoriosStockDto } from '../inventario/dto/update-accesorios-stock.dto';

@Controller('integrations/catalog-sales')
export class CatalogSalesIntegrationController {
  constructor(private readonly service: CatalogSalesIntegrationService) {}

  @Post('events')
  @UseGuards(CatalogEventGuard)
  async receive(
    @Headers('x-macso-event-id') eventId: string,
    @Body() payload: any,
  ) {
    return this.service.receive(String(eventId || ''), payload);
  }

  @UseGuards(CatalogEventGuard)
  @Get('product-accessories/:sku')
  productAccessories(@Param('sku') sku: string) {
    return this.service.getProductAccessories(sku);
  }

  @UseGuards(CatalogEventGuard)
  @Put('product-accessories/:sku')
  updateProductAccessories(@Param('sku') sku: string, @Body() dto: UpdateAccesoriosStockDto) {
    return this.service.updateProductAccessories(sku, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Get('pending')
  pending() {
    return this.service.pending();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Get(':id/payment-options')
  paymentOptions(@Param('id') id: string) {
    return this.service.paymentOptions(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post(':id/confirm')
  confirm(@Param('id') id: string, @Body() body: any) {
    return this.service.confirm(id, body?.exchangeRate, body?.incomeBank, body?.paymentType, body?.incomeParts, {
      accesoriosStockIds: body?.accesoriosStockIds,
      accesoriosStockRevision: body?.accesoriosStockRevision,
    });
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post(':id/exchange-rate')
  setExchangeRate(@Param('id') id: string, @Body() body: any) {
    return this.service.setExchangeRate(id, body?.exchangeRate);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post(':id/reject')
  reject(@Param('id') id: string) {
    return this.service.reject(id);
  }
}
