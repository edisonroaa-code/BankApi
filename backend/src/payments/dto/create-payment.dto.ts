import { IsBoolean, IsDefined, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, MaxLength, Min, ValidateIf } from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class CreatePaymentDto {
  @IsNumber()
  @Type(() => Number)
  @Min(1)
  amount: number;

  @IsString()
  @ValidateIf((_, value) => value !== undefined)
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toUpperCase() : value)
  @IsIn(['PYG'])
  currency?: string;

  @IsString()
  @IsOptional()
  @MaxLength(120)
  clientName?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  clientCode: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  paymentRef: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  sourceBank: string;

  /** Cuenta receptora: Atlas Connect tiene feed API; otras cuentas siguen revisión manual. */
  @IsDefined()
  @Transform(({ value }) => value === 'true' ? true : value === 'false' ? false : value)
  @IsBoolean()
  isAtlasAccount: boolean;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  observation?: string;

}
