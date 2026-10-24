import { MigrationInterface, QueryRunner } from 'typeorm';

export class AtlasAccountClassification1790264091600 implements MigrationInterface {
  name = 'AtlasAccountClassification1790264091600';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // No inferir el banco receptor de sourceBank: ese texto describe el banco de origen.
    // Los históricos quedan NULL hasta ser revisados uno por uno.
    await queryRunner.query(`ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "isAtlasAccount" boolean`);
  }

  public async down(): Promise<void> {
    throw new Error('No se revierte isAtlasAccount: eliminarlo destruiría la clasificación manual de las consultas.');
  }
}
