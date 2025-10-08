import { PartialType } from '@nestjs/mapped-types';
import { CreateScheduledDto } from './create-scheduled.dto';

export class UpdateScheduledDto extends PartialType(CreateScheduledDto) {}

