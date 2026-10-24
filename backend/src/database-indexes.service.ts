import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

const INDEX_STATEMENTS = [
  'CREATE INDEX IF NOT EXISTS "idx_payments_created_at" ON "payments" ("createdAt" DESC)',
  'CREATE INDEX IF NOT EXISTS "idx_payments_status_created_at" ON "payments" ("status", "createdAt" DESC)',
  'CREATE INDEX IF NOT EXISTS "idx_payments_created_by_created" ON "payments" ("createdById", "createdAt" DESC)',
  'CREATE INDEX IF NOT EXISTS "idx_payments_status_created_by" ON "payments" ("status", "createdById")',
  'CREATE INDEX IF NOT EXISTS "idx_payments_payment_ref" ON "payments" ("paymentRef")',
  'CREATE INDEX IF NOT EXISTS "idx_payments_file_hash" ON "payments" ("fileHash")',
  'CREATE INDEX IF NOT EXISTS "idx_payments_client_code_created" ON "payments" ("clientCode", "createdAt" DESC)',
  'CREATE INDEX IF NOT EXISTS "idx_payments_source_bank_created" ON "payments" ("sourceBank", "createdAt" DESC)',
  'CREATE INDEX IF NOT EXISTS "idx_payments_review_claim" ON "payments" ("reviewClaimedById", "reviewClaimExpiresAt")',
  'CREATE INDEX IF NOT EXISTS "idx_audit_timestamp" ON "audit_logs" ("timestamp" DESC)',
  'CREATE INDEX IF NOT EXISTS "idx_audit_action_ts" ON "audit_logs" ("action", "timestamp" DESC)',
  'CREATE INDEX IF NOT EXISTS "idx_audit_payment_ts" ON "audit_logs" ("paymentId", "timestamp" DESC)',
  'CREATE INDEX IF NOT EXISTS "idx_audit_user_ts" ON "audit_logs" ("userId", "timestamp" DESC)',
  'CREATE INDEX IF NOT EXISTS "idx_movements_reconciled_date" ON "movements" ("isReconciled", "date")',
];

@Injectable()
export class DatabaseIndexesService implements OnModuleInit {
  private readonly logger = new Logger(DatabaseIndexesService.name);

  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit() {
    for (const statement of INDEX_STATEMENTS) {
      try {
        await this.dataSource.query(statement);
      } catch (error: any) {
        this.logger.warn(`No se pudo asegurar un indice: ${error?.message || error}`);
      }
    }
  }
}
