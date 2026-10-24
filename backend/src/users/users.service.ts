import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { User, UserRole } from './entities/user.entity';
import { AuditLog } from '../payments/entities/audit-log.entity';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';

@Injectable()
export class UsersService {
    constructor(
        @InjectRepository(User)
        private usersRepository: Repository<User>,
    ) { }

    async findOneByUsername(username: string): Promise<User | null> {
        return this.usersRepository.findOne({
            where: { username },
            select: ['id', 'username', 'password', 'role', 'name', 'isActive', 'deletedAt', 'tokenVersion'], // Explicitly select password
        });
    }

    async findOneById(id: string): Promise<User | null> {
        return this.usersRepository.findOne({
            where: { id, deletedAt: IsNull() },
            select: ['id', 'username', 'role', 'name', 'isActive', 'deletedAt', 'createdAt', 'tokenVersion'],
        });
    }

    async create(user: Partial<User>, actor: { userId: string; role: UserRole }): Promise<User> {
        return this.withUserMutationLock(async (users, audit) => {
            const currentActor = await this.requireCurrentActor(users, actor, [UserRole.ADMIN]);
            // Sin esto la base rechaza el repetido con un error interno (500) que el admin no entiende.
            // Un usuario eliminado conserva su nombre: la auditoria lo sigue nombrando, y reusarlo
            // para otra persona mezclaria las dos historias.
            const existing = user.username
                ? await users.findOne({ where: { username: user.username }, select: ['id', 'deletedAt'] })
                : null;
            if (existing?.deletedAt) {
                throw new ConflictException('Ese nombre de usuario perteneció a un usuario eliminado y queda reservado para la auditoría. Elegí otro.');
            }
            if (existing) throw new ConflictException('El nombre de usuario ya existe');
            const created = await users.save(users.create(user));
            await audit.save(audit.create({
                action: 'USER_CREATED',
                userId: actor.userId,
                actorUsername: currentActor.username ?? null,
                targetUserId: created.id,
                metadata: JSON.stringify({ username: created.username, role: created.role }),
            }));
            return created;
        });
    }

    async findAll(): Promise<User[]> {
        return this.usersRepository.find({
            where: { deletedAt: IsNull() },
            select: ['id', 'username', 'role', 'name', 'isActive', 'createdAt'], // Exclude password
        });
    }

    async update(id: string, updateData: Partial<User>, actor: { userId: string; role: UserRole }): Promise<User | null> {
        return this.withUserMutationLock(async (users, audit) => {
            // Solo ADMIN: el supervisor ya no edita usuarios (ni claves ni roles) desde el 2026-10-07.
            const currentActor = await this.requireCurrentActor(users, actor, [UserRole.ADMIN]);

            const target = await users.findOne({
                where: { id, deletedAt: IsNull() },
                select: ['id', 'role', 'isActive'],
            });
            if (!target) return null;

            if (updateData.username) {
                const existing = await users.findOne({
                    where: { username: updateData.username },
                    select: ['id'],
                });
                if (existing && existing.id !== id) {
                    throw new ConflictException('El nombre de usuario ya existe');
                }
            }

            const removesActiveAdmin = target.role === UserRole.ADMIN && target.isActive &&
                (updateData.isActive === false || (updateData.role !== undefined && updateData.role !== UserRole.ADMIN));
            if (removesActiveAdmin) {
                const otherActiveAdmins = await users.count({
                    where: { role: UserRole.ADMIN, id: Not(id), isActive: true, deletedAt: IsNull() },
                });
                if (otherActiveAdmins === 0) {
                    throw new ForbiddenException('No se puede desactivar o cambiar el rol del último administrador activo');
                }
            }

            const result = await users.update(id, updateData);
            if (result.affected !== 1) throw new NotFoundException('Usuario no encontrado');
            if (updateData.password !== undefined) {
                const incremented = await users.increment({ id }, 'tokenVersion', 1);
                if (incremented.affected !== 1) throw new NotFoundException('Usuario no encontrado');
            }
            const updated = await users.findOne({
                where: { id, deletedAt: IsNull() },
                select: ['id', 'username', 'role', 'name', 'isActive', 'createdAt'],
            });
            if (!updated) throw new NotFoundException('Usuario no encontrado');
            await audit.save(audit.create({
                action: 'USER_UPDATED',
                userId: actor.userId,
                actorUsername: currentActor.username ?? null,
                targetUserId: id,
                metadata: JSON.stringify({ fields: Object.keys(updateData) }),
            }));
            return updated;
        });
    }

    async softDeleteUser(targetUserId: string, actor: { userId: string; role: UserRole }) {
        if (actor.userId === targetUserId) {
            throw new ForbiddenException('No puede eliminar su propio usuario');
        }

        return this.withUserMutationLock(async (users, audit) => {
            const currentActor = await this.requireCurrentActor(users, actor, [UserRole.ADMIN]);
            const target = await users.findOne({
                where: { id: targetUserId, deletedAt: IsNull() },
                select: ['id', 'username', 'role', 'name', 'isActive', 'deletedAt'],
            });
            if (!target) throw new NotFoundException('Usuario no encontrado');

            if (target.role === UserRole.ADMIN && target.isActive) {
                const otherActiveAdmins = await users.count({
                    where: {
                        role: UserRole.ADMIN,
                        id: Not(targetUserId),
                        isActive: true,
                        deletedAt: IsNull(),
                    },
                });
                if (otherActiveAdmins === 0) {
                    throw new ForbiddenException('No se puede eliminar el último administrador activo');
                }
            }

            // Defense-in-depth: invalidate password even if auth checks are misconfigured later.
            const randomPassword = crypto.randomBytes(32).toString('hex');
            const hashedPassword = await bcrypt.hash(randomPassword, 12);

            const deletedAt = new Date();
            const result = await users.update(targetUserId, {
                isActive: false,
                deletedAt,
                password: hashedPassword,
            });
            if (result.affected !== 1) throw new NotFoundException('Usuario no encontrado');
            const incremented = await users.increment({ id: targetUserId }, 'tokenVersion', 1);
            if (incremented.affected !== 1) throw new NotFoundException('Usuario no encontrado');

            await audit.save(audit.create({
                action: 'USER_DELETED',
                userId: actor.userId,
                actorUsername: currentActor.username ?? null,
                targetUserId,
                metadata: JSON.stringify({ username: target.username, name: target.name, role: target.role }),
            }));

            return { ...target, isActive: false, deletedAt };
        });
    }

    private async requireCurrentActor(
        users: Repository<User>,
        actor: { userId: string; role: UserRole },
        allowedRoles: UserRole[],
    ): Promise<User> {
        if (!actor?.userId || !allowedRoles.includes(actor.role)) {
            throw new ForbiddenException('No autorizado para modificar usuarios');
        }
        const currentActor = await users.findOne({
            where: { id: actor.userId, deletedAt: IsNull() },
            select: ['id', 'role', 'isActive'],
        });
        if (!currentActor?.isActive || currentActor.role !== actor.role) {
            throw new ForbiddenException('El acceso del operador cambió; vuelva a iniciar la operación');
        }
        return currentActor;
    }

    private async withUserMutationLock<T>(
        operation: (users: Repository<User>, audit: Repository<AuditLog>) => Promise<T>,
    ): Promise<T> {
        return this.usersRepository.manager.transaction(async (manager) => {
            // Shared by create, update and delete across all API instances: two admins cannot both
            // remove the other as the final admin in concurrent requests.
            await manager.query('SELECT pg_advisory_xact_lock(251719, 1)');
            return operation(manager.getRepository(User), manager.getRepository(AuditLog));
        });
    }
}
