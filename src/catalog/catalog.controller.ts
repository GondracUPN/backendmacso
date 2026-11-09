import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CatalogService } from './catalog.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import {
  CurrentUser,
  JwtUserPayload,
} from '../auth/decorators/current-user.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('catalog')
export class CatalogController {
  constructor(private readonly svc: CatalogService) {}

  @Get('product-options')
  productOptions() {
    return this.svc.listProductOptions();
  }

  @Get('expense-concepts')
  expenseConcepts(@CurrentUser() user: JwtUserPayload) {
    return this.svc.listExpenseConcepts(user?.userId);
  }

  @Get()
  all(@CurrentUser() user: JwtUserPayload) {
    return this.svc.listAll(user?.userId);
  }

  @Roles('admin')
  @Post('product-options')
  createProductOption(@Body() dto: any) {
    return this.svc.createProductOption(dto);
  }

  @Roles('admin')
  @Post('expense-concepts')
  createExpenseConcept(@Body() dto: any, @CurrentUser() user: JwtUserPayload) {
    return this.svc.createExpenseConcept(dto, user.userId);
  }

  @Roles('admin')
  @Delete('items/:id')
  disable(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: JwtUserPayload,
  ) {
    return this.svc.disable(id, user?.userId);
  }
}
