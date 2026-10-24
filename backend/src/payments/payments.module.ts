import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Payment } from './entities/payment.entity';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { ReportsService } from './reports.service';
import { ReportsController } from './reports.controller';
import { AuditLog } from './entities/audit-log.entity';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { PaymentsGateway } from './payments.gateway';

@Module({
    imports: [TypeOrmModule.forFeature([Payment, AuditLog]), AuthModule, UsersModule],
    controllers: [PaymentsController, ReportsController],
    providers: [PaymentsService, PaymentsGateway, ReportsService],
    exports: [PaymentsService, PaymentsGateway, ReportsService],
})
export class PaymentsModule { }
