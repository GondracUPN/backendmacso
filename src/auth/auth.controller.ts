// src/auth/auth.controller.ts
import { Body, Controller, Get, Post, UseGuards, Patch, Param, Delete } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { Roles } from './decorators/roles.decorator';
import { RolesGuard } from './guards/roles.guard';
import {
  CurrentUser,
  JwtUserPayload,
} from './decorators/current-user.decorator';
import { UpdateUserDto } from './dto/update-user.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly svc: AuthService) {}

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.svc.login(dto); // devuelve { access_token, user }
  }

  // Solo ADMIN crea cuentas
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.svc.register(dto);
  }

  // Solo ADMIN ve usuarios
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Get('users')
  listUsers() {
    return this.svc.listUsers();
  }

  // Cualquiera autenticado
  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentUser() user: JwtUserPayload) {
    return user;
  }

  // ADMIN: actualizar rol o password
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Patch('users/:id')
  updateUser(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.svc.updateUser(+id, dto);
  }

  // ADMIN: eliminar usuario
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Delete('users/:id')
  deleteUser(@Param('id') id: string) {
    return this.svc.deleteUser(+id);
  }
}
