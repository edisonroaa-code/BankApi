import { MigrationInterface, QueryRunner } from 'typeorm';

export class UserTokenVersion1790264302905 implements MigrationInterface {
  name = 'UserTokenVersion1790264302905';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Existing users start at version 0. Tokens issued by old code have no
    // version claim and are rejected by the new strategy until login again.
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "tokenVersion" integer NOT NULL DEFAULT 0`);
  }

  public async down(): Promise<void> {
    // Dropping this column could restore previously revoked sessions.
    throw new Error('No se revierte tokenVersion: perdería el historial de revocación de sesiones.');
  }
}
