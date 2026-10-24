import { IsOptional, IsString, MaxLength } from 'class-validator';

export class PaymentActionDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
