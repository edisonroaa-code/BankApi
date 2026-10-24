import { MigrationInterface, QueryRunner } from 'typeorm';

export class UniqueActivePaymentProofAndReference1790264091518 implements MigrationInterface {
  name = 'UniqueActivePaymentProofAndReference1790264091518';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Detener la migración antes de tocar índices si el historial ya viola la regla.
    // No imprimir referencias ni huellas: podrían revelar datos sensibles.
    const duplicateReferences = await queryRunner.query(`
      SELECT 1 FROM "payments"
      WHERE "paymentRef" IS NOT NULL AND "paymentRef" <> '' AND "status" <> 'RECHAZADO'
      GROUP BY "paymentRef" HAVING COUNT(*) > 1 LIMIT 1
    `);
    if (duplicateReferences.length > 0) {
      throw new Error('Hay referencias activas duplicadas: revisar el historial antes de crear el índice único.');
    }
    const duplicateProofs = await queryRunner.query(`
      SELECT 1 FROM "payments"
      WHERE "fileHash" IS NOT NULL AND "fileHash" <> '' AND "status" <> 'RECHAZADO'
      GROUP BY "fileHash" HAVING COUNT(*) > 1 LIMIT 1
    `);
    if (duplicateProofs.length > 0) {
      throw new Error('Hay comprobantes activos duplicados: revisar el historial antes de crear el índice único.');
    }

    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "uq_payments_payment_ref_active" ON "payments" ("paymentRef") WHERE "paymentRef" IS NOT NULL AND "paymentRef" <> '' AND "status" <> 'RECHAZADO'`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "uq_payments_file_hash_active" ON "payments" ("fileHash") WHERE "fileHash" IS NOT NULL AND "fileHash" <> '' AND "status" <> 'RECHAZADO'`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_payments_payment_ref"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_payments_file_hash"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_payments_payment_ref" ON "payments" ("paymentRef")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_payments_file_hash" ON "payments" ("fileHash")`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_payments_payment_ref_active"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_payments_file_hash_active"`);
  }
}
