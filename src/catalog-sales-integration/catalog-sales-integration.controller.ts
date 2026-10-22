import { Body, Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CatalogEventGuard } from '../auth/guards/catalog-event.guard';
import { CatalogSalesIntegrationService } from './catalog-sales-integration.service';

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
    return this.service.confirm(id, body?.exchangeRate, body?.incomeBank, body?.paymentType, body?.incomeParts);
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
