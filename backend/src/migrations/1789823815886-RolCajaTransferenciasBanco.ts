import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Fase 1 del rol CAJA: rol CAJERO, transferencias vistas en el banco, tomas con bloqueo
 * (1 transferencia <-> 1 ticket por indices unicos parciales) y columna de auditoria.
 */
export class RolCajaTransferenciasBanco1789823815886 implements MigrationInterface {
    name = 'RolCajaTransferenciasBanco1789823815886'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."bank_transfers_source_enum" AS ENUM('ATLAS', 'MOCK')`);
        await queryRunner.query(`CREATE TYPE "public"."bank_transfers_status_enum" AS ENUM('DISPONIBLE', 'TOMADA', 'REVERSADA', 'BLOQUEADA')`);
        await queryRunner.query(`CREATE TABLE "bank_transfers" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "fingerprint" text NOT NULL, "source" "public"."bank_transfers_source_enum" NOT NULL, "accountNumber" text NOT NULL, "bankDocNumber" text, "bancardTxId" text, "amount" numeric(18,2) NOT NULL, "currency" text NOT NULL, "movementAt" TIMESTAMP WITH TIME ZONE NOT NULL, "processDate" date, "concept" text NOT NULL, "senderName" text, "senderDoc" text, "senderAccount" text, "senderNote" text, "senderBankCode" text, "senderBankName" text, "channel" text, "sipapReference" text, "sipapReason" text, "enrichedAt" TIMESTAMP WITH TIME ZONE, "txCode" text, "txDescription" text, "status" "public"."bank_transfers_status_enum" NOT NULL DEFAULT 'DISPONIBLE', "activeClaimId" uuid, "reversedAt" TIMESTAMP WITH TIME ZONE, "blockedReason" text, "rawPayload" jsonb NOT NULL, "firstSeenAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "lastSeenAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "UQ_22a75e944e9ee38b47378aab910" UNIQUE ("fingerprint"), CONSTRAINT "PK_f8e16aece70460615b4a80d0749" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_bank_transfers_amount_movement_at" ON "bank_transfers" ("amount", "movementAt") `);
        await queryRunner.query(`CREATE INDEX "idx_bank_transfers_status_movement_at" ON "bank_transfers" ("status", "movementAt") `);
        await queryRunner.query(`CREATE INDEX "idx_bank_transfers_movement_at" ON "bank_transfers" ("movementAt") `);
        await queryRunner.query(`CREATE TYPE "public"."bank_transfer_claims_referencetype_enum" AS ENUM('TICKET', 'CLIENTE', 'CONSULTA')`);
        await queryRunner.query(`CREATE TYPE "public"."bank_transfer_claims_status_enum" AS ENUM('ACTIVA', 'ANULADA')`);
        await queryRunner.query(`CREATE TABLE "bank_transfer_claims" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "bankTransferId" uuid NOT NULL, "receiptNumber" text NOT NULL, "referenceType" "public"."bank_transfer_claims_referencetype_enum" NOT NULL, "referenceValue" text NOT NULL, "paymentId" uuid, "note" text, "claimedById" text NOT NULL, "claimedByUsername" text, "claimedByName" text, "claimedByRole" text NOT NULL, "claimedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "status" "public"."bank_transfer_claims_status_enum" NOT NULL DEFAULT 'ACTIVA', "voidedById" text, "voidedByUsername" text, "voidedByName" text, "voidedAt" TIMESTAMP WITH TIME ZONE, "voidReason" text, "printCount" integer NOT NULL DEFAULT '0', "lastPrintedAt" TIMESTAMP WITH TIME ZONE, "idempotencyKey" uuid NOT NULL, CONSTRAINT "UQ_c8717634f36595b12092f73d6d0" UNIQUE ("receiptNumber"), CONSTRAINT "UQ_ba8bc5da39b039c85f3f7c6e105" UNIQUE ("idempotencyKey"), CONSTRAINT "PK_0cede355b2a41e7fdc9ace0826f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_claims_payment" ON "bank_transfer_claims" ("paymentId") `);
        await queryRunner.query(`CREATE INDEX "idx_claims_claimed_by" ON "bank_transfer_claims" ("claimedById", "claimedAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "ux_claims_one_active_reference" ON "bank_transfer_claims" ("referenceType", "referenceValue") WHERE "status" = 'ACTIVA'`);
        await queryRunner.query(`CREATE UNIQUE INDEX "ux_claims_one_active_transfer" ON "bank_transfer_claims" ("bankTransferId") WHERE "status" = 'ACTIVA'`);
        await queryRunner.query(`ALTER TABLE "audit_logs" ADD "bankTransferId" uuid`);
        // Agregar el valor sin recrear el tipo: no reescribe la tabla users en produccion.
        await queryRunner.query(`ALTER TYPE "public"."users_role_enum" ADD VALUE IF NOT EXISTS 'CAJERO'`);
        await queryRunner.query(`CREATE INDEX "idx_audit_bank_transfer_ts" ON "audit_logs" ("bankTransferId", "timestamp") `);
        await queryRunner.query(`ALTER TABLE "bank_transfer_claims" ADD CONSTRAINT "FK_f83c805d142eaeea823d61a5ed6" FOREIGN KEY ("bankTransferId") REFERENCES "bank_transfers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        // Numeracion de comprobantes de toma (TR-000001...).
        await queryRunner.query(`CREATE SEQUENCE IF NOT EXISTS "bank_transfer_receipt_seq"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Las tomas son historial auditable: no se revierte si ya hay alguna registrada.
        const [{ count }] = await queryRunner.query(`SELECT count(*)::int AS count FROM "bank_transfer_claims"`);
        if (count > 0) {
            throw new Error('Hay tomas de transferencias registradas: revertir esta migracion borraria historial auditable.');
        }
        // El valor CAJERO del enum de roles se conserva: Postgres no permite quitar valores de un enum.
        await queryRunner.query(`DROP SEQUENCE IF EXISTS "bank_transfer_receipt_seq"`);
        await queryRunner.query(`ALTER TABLE "bank_transfer_claims" DROP CONSTRAINT "FK_f83c805d142eaeea823d61a5ed6"`);
        await queryRunner.query(`DROP INDEX "public"."idx_audit_bank_transfer_ts"`);
        await queryRunner.query(`ALTER TABLE "audit_logs" DROP COLUMN "bankTransferId"`);
        await queryRunner.query(`DROP INDEX "public"."ux_claims_one_active_transfer"`);
        await queryRunner.query(`DROP INDEX "public"."ux_claims_one_active_reference"`);
        await queryRunner.query(`DROP INDEX "public"."idx_claims_claimed_by"`);
        await queryRunner.query(`DROP INDEX "public"."idx_claims_payment"`);
        await queryRunner.query(`DROP TABLE "bank_transfer_claims"`);
        await queryRunner.query(`DROP TYPE "public"."bank_transfer_claims_status_enum"`);
        await queryRunner.query(`DROP TYPE "public"."bank_transfer_claims_referencetype_enum"`);
        await queryRunner.query(`DROP INDEX "public"."idx_bank_transfers_movement_at"`);
        await queryRunner.query(`DROP INDEX "public"."idx_bank_transfers_status_movement_at"`);
        await queryRunner.query(`DROP INDEX "public"."idx_bank_transfers_amount_movement_at"`);
        await queryRunner.query(`DROP TABLE "bank_transfers"`);
        await queryRunner.query(`DROP TYPE "public"."bank_transfers_status_enum"`);
        await queryRunner.query(`DROP TYPE "public"."bank_transfers_source_enum"`);
    }

}
