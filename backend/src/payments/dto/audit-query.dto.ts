import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, Max, Min, MaxLength } from 'class-validator';

export class AuditQueryDto {
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  action?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  actorUsername?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  userId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  paymentId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  movementId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  targetUserId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

