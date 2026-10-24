import { Controller, Get, Post, Body, Request, Patch, Param, NotFoundException, Delete } from '@nestjs/common';
import { UsersService } from './users.service';
import * as bcrypt from 'bcrypt';
import { Roles } from '../auth/roles.decorator';
import { User, UserRole } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserAccessEventsService } from './user-access-events.service';

type PublicUser = Pick<User, 'id' | 'name' | 'username' | 'role' | 'isActive' | 'createdAt'>;

const toPublicUser = (user: User): PublicUser => ({
    id: user.id,
    name: user.name,
    username: user.username,
    role: user.role,
    isActive: user.isActive,
    createdAt: user.createdAt,
});

@Controller('users')
export class UsersController {
    constructor(
        private usersService: UsersService,
        private accessEvents: UserAccessEventsService,
    ) { }

    @Get()
    @Roles(UserRole.ADMIN, UserRole.SUPERVISOR)
    async findAll(): Promise<PublicUser[]> {
        return (await this.usersService.findAll()).map(toPublicUser);
    }

    @Post()
    @Roles(UserRole.ADMIN)
    async create(@Body() body: CreateUserDto, @Request() req: any) {
        // Hash password before saving
        const salt = await bcrypt.genSalt(12);
        const hashedPassword = await bcrypt.hash(body.password, salt);

        const created = await this.usersService.create({
            ...body,
            password: hashedPassword
        }, { userId: req.user?.userId, role: req.user?.role });
        return toPublicUser(created);
    }

    // Solo el admin modifica usuarios (decision del 2026-10-07): quien puede cambiar la clave de un
    // cajero puede entrar como el y tomar transferencias a su nombre. El supervisor solo ve la lista.
    @Patch(':id')
    @Roles(UserRole.ADMIN)
    async update(@Param('id') id: string, @Body() body: UpdateUserDto, @Request() req: any) {
        if (body.password) {
            const salt = await bcrypt.genSalt(12);
            body.password = await bcrypt.hash(body.password, salt);
        }
        const updated = await this.usersService.update(id, body, {
            userId: req.user?.userId,
            role: req.user?.role,
        });
        if (!updated) throw new NotFoundException('Usuario no encontrado');
        if (body.isActive === false || body.role !== undefined || body.password !== undefined) {
            this.accessEvents.emitAccessRevoked(id);
        }
        return toPublicUser(updated);
    }

    @Delete(':id')
    @Roles(UserRole.ADMIN)
    async remove(@Param('id') id: string, @Request() req: any) {
        await this.usersService.softDeleteUser(id, {
            userId: req.user?.userId,
            role: req.user?.role,
        });
        this.accessEvents.emitAccessRevoked(id);
        return { ok: true };
    }
}
