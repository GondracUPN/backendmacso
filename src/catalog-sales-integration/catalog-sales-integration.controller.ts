import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import { CatalogSalesIntegrationService } from './catalog-sales-integration.service';

@Controller('integrations/catalog-sales')
export class CatalogSalesIntegrationController {
  constructor(private readonly service: CatalogSalesIntegrationService) {}

  @Post('events')
  async receive(
    @Headers('x-macso-event-id') eventId: string,
    @Body() payload: any,
  ) {
    return this.service.receive(String(eventId || ''), payload);
  }

  @Get('pending')
  pending() {
    return this.service.pending();
  }

  @Post(':id/confirm')
  confirm(@Param('id') id: string, @Body() body: any) {
    return this.service.confirm(id, body?.exchangeRate);
  }

  @Post(':id/exchange-rate')
  setExchangeRate(@Param('id') id: string, @Body() body: any) {
    return this.service.setExchangeRate(id, body?.exchangeRate);
  }

  @Post(':id/reject')
  reject(@Param('id') id: string) {
    return this.service.reject(id);
  }
}
