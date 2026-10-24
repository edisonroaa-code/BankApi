import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { PaymentState } from '../entities/payment.entity';

const toBoolean = ({ value }: { value: unknown }) => {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
};

const toStatuses = ({ value }: { value: unknown }) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
};

export class ListPaymentsQueryDto {
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  workOpen?: boolean;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  pendingAdminReview?: boolean;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2000)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  pageSize?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2000)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  lite?: boolean;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  globalScope?: boolean;

  @IsOptional()
  @IsEnum(PaymentState)
  status?: PaymentState;

  @IsOptional()
  @Transform(toStatuses)
  @IsEnum(PaymentState, { each: true })
  statuses?: PaymentState[];

  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  sourceBank?: string;

  @IsOptional()
  @Transform(({ value }) => value === 'true' ? true : value === 'false' ? false : value)
  @IsBoolean()
  isAtlasAccount?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  clientCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  clientName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  createdById?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;
}
