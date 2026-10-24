import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Pagos partidos: una transferencia puede cubrir varias consultas y una consulta puede cubrirse
 * con varias transferencias. Cambia la garantia contra el doble uso, sin debilitarla:
 * en vez de "una sola toma activa por transferencia" (indice unico) pasa a ser un saldo con
 * restriccion CHECK a los dos lados, verificado por la base en cada escritura.
 */
export class TomasParcialesTransferencias1789998997520 implements MigrationInterface {
    name = 'TomasParcialesTransferencias1789998997520'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TYPE "public"."bank_transfers_status_enum" ADD VALUE IF NOT EXISTS 'PARCIAL' BEFORE 'TOMADA'`);

        // Monto de cada toma. Lo ya registrado tomaba la transferencia entera.
        await queryRunner.query(`ALTER TABLE "bank_transfer_claims" ADD "amount" numeric(18,2)`);
        await queryRunner.query(`UPDATE "bank_transfer_claims" c SET "amount" = t."amount" FROM "bank_transfers" t WHERE t."id" = c."bankTransferId" AND c."amount" IS NULL`);
        await queryRunner.query(`ALTER TABLE "bank_transfer_claims" ALTER COLUMN "amount" SET NOT NULL`);

        // Con que evidencia se armo cada conciliacion: habilita la cola de revision del admin.
        await queryRunner.query(`ALTER TABLE "bank_transfer_claims" ADD "matchStrength" text`);
        await queryRunner.query(`ALTER TABLE "bank_transfer_claims" ADD "matchEvidence" text`);
        await queryRunner.query(`CREATE INDEX "idx_claims_match_strength" ON "bank_transfer_claims" ("matchStrength", "claimedAt") WHERE "status" = 'ACTIVA'`);

        // Saldo tomado de cada transferencia.
        await queryRunner.query(`ALTER TABLE "bank_transfers" ADD "allocatedAmount" numeric(18,2) NOT NULL DEFAULT '0'`);
        await queryRunner.query(`UPDATE "bank_transfers" t SET "allocatedAmount" = COALESCE((SELECT sum(c."amount") FROM "bank_transfer_claims" c WHERE c."bankTransferId" = t."id" AND c."status" = 'ACTIVA'), 0)`);
        await queryRunner.query(`ALTER TABLE "bank_transfers" ADD CONSTRAINT "ck_bank_transfers_allocated" CHECK ("allocatedAmount" >= 0 AND "allocatedAmount" <= "amount")`);

        // Saldo cubierto de cada consulta.
        await queryRunner.query(`ALTER TABLE "payments" ADD "allocatedAmount" numeric(18,2) NOT NULL DEFAULT '0'`);
        await queryRunner.query(`UPDATE "payments" p SET "allocatedAmount" = COALESCE((SELECT sum(c."amount") FROM "bank_transfer_claims" c WHERE c."paymentId" = p."id" AND c."status" = 'ACTIVA'), 0)`);
        await queryRunner.query(`ALTER TABLE "payments" ADD CONSTRAINT "ck_payments_allocated" CHECK ("allocatedAmount" >= 0 AND "allocatedAmount" <= "amount")`);

        // La unicidad de toma activa la reemplaza el saldo; el ticket repetido pasa a ser aviso, no impedimento.
        await queryRunner.query(`DROP INDEX "public"."ux_claims_one_active_transfer"`);
        await queryRunner.query(`DROP INDEX "public"."ux_claims_one_active_reference"`);
        await queryRunner.query(`CREATE INDEX "idx_claims_transfer_status" ON "bank_transfer_claims" ("bankTransferId", "status") `);
        await queryRunner.query(`CREATE INDEX "idx_claims_reference" ON "bank_transfer_claims" ("referenceType", "referenceValue", "status") `);

        // Con varias tomas activas por transferencia, el puntero a "la" toma activa deja de tener sentido.
        await queryRunner.query(`ALTER TABLE "bank_transfers" DROP COLUMN "activeClaimId"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const [{ count }] = await queryRunner.query(
            `SELECT count(*)::int AS count FROM (SELECT "bankTransferId" FROM "bank_transfer_claims" WHERE "status" = 'ACTIVA' GROUP BY "bankTransferId" HAVING count(*) > 1) x`,
        );
        if (count > 0) {
            throw new Error(`Hay ${count} transferencia(s) con mas de una toma activa: volver al modelo 1 a 1 perderia tomas registradas.`);
        }
        const [{ partial }] = await queryRunner.query(
            `SELECT count(*)::int AS partial FROM "bank_transfers" WHERE "allocatedAmount" > 0 AND "allocatedAmount" < "amount"`,
        );
        if (partial > 0) {
            throw new Error(`Hay ${partial} transferencia(s) tomadas en parte: el modelo anterior no puede representarlas.`);
        }

        await queryRunner.query(`ALTER TABLE "bank_transfers" ADD "activeClaimId" uuid`);
        await queryRunner.query(`UPDATE "bank_transfers" t SET "activeClaimId" = (SELECT c."id" FROM "bank_transfer_claims" c WHERE c."bankTransferId" = t."id" AND c."status" = 'ACTIVA' LIMIT 1)`);
        await queryRunner.query(`DROP INDEX "public"."idx_claims_reference"`);
        await queryRunner.query(`DROP INDEX "public"."idx_claims_transfer_status"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "ux_claims_one_active_reference" ON "bank_transfer_claims" ("referenceType", "referenceValue") WHERE "status" = 'ACTIVA'`);
        await queryRunner.query(`CREATE UNIQUE INDEX "ux_claims_one_active_transfer" ON "bank_transfer_claims" ("bankTransferId") WHERE "status" = 'ACTIVA'`);
        await queryRunner.query(`ALTER TABLE "payments" DROP CONSTRAINT "ck_payments_allocated"`);
        await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN "allocatedAmount"`);
        await queryRunner.query(`ALTER TABLE "bank_transfers" DROP CONSTRAINT "ck_bank_transfers_allocated"`);
        await queryRunner.query(`ALTER TABLE "bank_transfers" DROP COLUMN "allocatedAmount"`);
        await queryRunner.query(`DROP INDEX "public"."idx_claims_match_strength"`);
        await queryRunner.query(`ALTER TABLE "bank_transfer_claims" DROP COLUMN "matchEvidence"`);
        await queryRunner.query(`ALTER TABLE "bank_transfer_claims" DROP COLUMN "matchStrength"`);
        await queryRunner.query(`ALTER TABLE "bank_transfer_claims" DROP COLUMN "amount"`);
        // El valor PARCIAL del enum se conserva: Postgres no permite quitar valores de un enum.
    }

}
