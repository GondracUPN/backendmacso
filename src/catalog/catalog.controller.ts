import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { CatalogService } from './catalog.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('catalog')
export class CatalogController {
  constructor(private readonly svc: CatalogService) {}

  @Get('product-options')
  productOptions() {
    return this.svc.listProductOptions();
  }

  @Get('expense-concepts')
  expenseConcepts() {
    return this.svc.listExpenseConcepts();
  }

  @Get()
  all() {
    return this.svc.listAll();
  }

  @Roles('admin')
  @Post('product-options')
  createProductOption(@Body() dto: any) {
    return this.svc.createProductOption(dto);
  }

  @Roles('admin')
  @Post('expense-concepts')
  createExpenseConcept(@Body() dto: any) {
    return this.svc.createExpenseConcept(dto);
  }

  @Roles('admin')
  @Delete('items/:id')
  disable(@Param('id', ParseIntPipe) id: number) {
    return this.svc.disable(id);
  }
}
