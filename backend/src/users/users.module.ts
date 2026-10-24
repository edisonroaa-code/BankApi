import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { UserAccessEventsService } from './user-access-events.service';
import { AuditLog } from '../payments/entities/audit-log.entity';

@Module({
    imports: [TypeOrmModule.forFeature([User, AuditLog])],
    providers: [UsersService, UserAccessEventsService],
    controllers: [UsersController],
    exports: [TypeOrmModule, UsersService, UserAccessEventsService],
})
export class UsersModule { }
