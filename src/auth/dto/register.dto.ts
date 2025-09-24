import { IsString, MinLength, MaxLength, IsIn } from 'class-validator';
import { Role } from '../entities/user.entity';

export class RegisterDto {
  @IsString() @MinLength(3) @MaxLength(80)
  username: string;

  @IsString() @MinLength(4) @MaxLength(128)
  password: string;

  @IsIn(['admin','user'])
  role: Role;
}
