import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class PrintPreviewDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class PrintConfirmationDto {
  @IsUUID('4')
  authorizationId: string;
}
