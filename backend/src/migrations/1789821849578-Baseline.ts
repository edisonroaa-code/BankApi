import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Linea base del esquema al 2026-09-19 (usuarios, pagos, movimientos, auditoria).
 *
 * - En una base existente (produccion Neon o una base local creada con synchronize) no hace
 *   nada: solo queda registrada en la tabla `migrations` para que las siguientes migraciones
 *   partan de aqui.
 * - En una base vacia crea el esquema completo.
 * - No se revierte: revertirla borraria todas las tablas con sus datos.
 */
export class Baseline1789821849578 implements MigrationInterface {
    name = 'Baseline1789821849578'

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('users')) {
            return;
        }
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
        await queryRunner.query(`CREATE TYPE "public"."users_role_enum" AS ENUM('ADMIN', 'SUPERVISOR', 'COBRADOR')`);
        await queryRunner.query(`CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, "username" text NOT NULL, "role" "public"."users_role_enum" NOT NULL, "password" character varying NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "isActive" boolean NOT NULL DEFAULT true, "deletedAt" TIMESTAMP, "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_fe0bb3f6520ee0469504521e710" UNIQUE ("username"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "movements" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "date" TIMESTAMP NOT NULL, "amount" numeric(15,0) NOT NULL, "description" character varying NOT NULL, "transactionId" character varying NOT NULL, "isReconciled" boolean NOT NULL DEFAULT false, CONSTRAINT "UQ_e1182df04db849a40d7ca92573a" UNIQUE ("transactionId"), CONSTRAINT "PK_5a8e3da15ab8f2ce353e7f58f67" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_movements_reconciled_date" ON "movements" ("isReconciled", "date") `);
        await queryRunner.query(`CREATE TYPE "public"."payments_status_enum" AS ENUM('PENDIENTE_VERIFICACION', 'EN_REVISION', 'CONFIRMADO', 'CONFIRMADO_MANUAL', 'RECHAZADO')`);
        await queryRunner.query(`CREATE TABLE "payments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "amount" numeric(15,0) NOT NULL, "currency" character varying NOT NULL DEFAULT 'PYG', "clientName" character varying, "clientCode" character varying, "paymentRef" character varying, "sourceBank" character varying, "observation" text, "fileHash" text, "proofUrl" text, "proofDhash" text, "status" "public"."payments_status_enum" NOT NULL DEFAULT 'PENDIENTE_VERIFICACION', "rejectionReason" text, "decisionReason" text, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "createdById" uuid NOT NULL, "matchedMovementId" uuid, "printedAt" TIMESTAMP, "cashPaidAt" TIMESTAMP, "cashPaidById" text, "cashPaidByUsername" text, "cashPaidByName" text, "reviewClaimedById" text, "reviewClaimedByUsername" text, "reviewClaimedByName" text, "reviewClaimedAt" TIMESTAMP, "reviewClaimExpiresAt" TIMESTAMP, "verifiedById" text, "verifiedByUsername" text, "verifiedByName" text, "verifiedAt" TIMESTAMP, CONSTRAINT "REL_91d155380b127f85d15366691c" UNIQUE ("matchedMovementId"), CONSTRAINT "PK_197ab7af18c93fbb0c9b28b4a59" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_payments_review_claim" ON "payments" ("reviewClaimedById", "reviewClaimExpiresAt") `);
        await queryRunner.query(`CREATE INDEX "idx_payments_source_bank_created" ON "payments" ("sourceBank", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "idx_payments_client_code_created" ON "payments" ("clientCode", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "idx_payments_file_hash" ON "payments" ("fileHash") `);
        await queryRunner.query(`CREATE INDEX "idx_payments_payment_ref" ON "payments" ("paymentRef") `);
        await queryRunner.query(`CREATE INDEX "idx_payments_status_created_by" ON "payments" ("status", "createdById") `);
        await queryRunner.query(`CREATE INDEX "idx_payments_created_by_created" ON "payments" ("createdById", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "idx_payments_status_created_at" ON "payments" ("status", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "idx_payments_created_at" ON "payments" ("createdAt") `);
        await queryRunner.query(`CREATE TYPE "public"."audit_logs_beforestate_enum" AS ENUM('PENDIENTE_VERIFICACION', 'EN_REVISION', 'CONFIRMADO', 'CONFIRMADO_MANUAL', 'RECHAZADO')`);
        await queryRunner.query(`CREATE TYPE "public"."audit_logs_afterstate_enum" AS ENUM('PENDIENTE_VERIFICACION', 'EN_REVISION', 'CONFIRMADO', 'CONFIRMADO_MANUAL', 'RECHAZADO')`);
        await queryRunner.query(`CREATE TABLE "audit_logs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "paymentId" uuid, "movementId" uuid, "targetUserId" uuid, "userId" character varying NOT NULL, "actorUsername" text, "action" character varying NOT NULL, "beforeState" "public"."audit_logs_beforestate_enum", "afterState" "public"."audit_logs_afterstate_enum", "metadata" text, "timestamp" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_1bb179d048bbc581caa3b013439" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_audit_target_user_ts" ON "audit_logs" ("targetUserId", "timestamp") `);
        await queryRunner.query(`CREATE INDEX "idx_audit_actor_ts" ON "audit_logs" ("actorUsername", "timestamp") `);
        await queryRunner.query(`CREATE INDEX "idx_audit_user_ts" ON "audit_logs" ("userId", "timestamp") `);
        await queryRunner.query(`CREATE INDEX "idx_audit_movement_ts" ON "audit_logs" ("movementId", "timestamp") `);
        await queryRunner.query(`CREATE INDEX "idx_audit_payment_ts" ON "audit_logs" ("paymentId", "timestamp") `);
        await queryRunner.query(`CREATE INDEX "idx_audit_action_ts" ON "audit_logs" ("action", "timestamp") `);
        await queryRunner.query(`CREATE INDEX "idx_audit_timestamp" ON "audit_logs" ("timestamp") `);
        await queryRunner.query(`ALTER TABLE "payments" ADD CONSTRAINT "FK_8b8ddc119cf77e4a8968f47a703" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "payments" ADD CONSTRAINT "FK_91d155380b127f85d15366691c8" FOREIGN KEY ("matchedMovementId") REFERENCES "movements"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(): Promise<void> {
        throw new Error('La migracion base no se revierte: borraria todas las tablas y sus datos.');
    }
}
