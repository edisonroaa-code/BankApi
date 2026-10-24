import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { User, UserRole } from './entities/user.entity';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

describe('Users security boundaries', () => {
  it('does not create a default admin when the users module starts on an empty database', async () => {
    const repository = {
      count: jest.fn().mockResolvedValue(0),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
    };
    const module = await Test.createTestingModule({
      providers: [UsersService, { provide: getRepositoryToken(User), useValue: repository }],
    }).compile();

    await module.init();

    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
    await module.close();
  });

  it('does not reactivate a disabled admin when the users module starts', async () => {
    const repository = {
      count: jest.fn().mockResolvedValue(0),
      findOne: jest.fn().mockResolvedValue({ id: 'disabled-admin', isActive: false }),
      create: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
    };
    const module = await Test.createTestingModule({
      providers: [UsersService, { provide: getRepositoryToken(User), useValue: repository }],
    }).compile();

    await module.init();

    expect(repository.update).not.toHaveBeenCalled();
    await module.close();
  });

  const storedUser = {
    id: 'user-1',
    name: 'Caja Uno',
    username: 'caja1',
    role: UserRole.CAJERO,
    isActive: true,
    password: 'hashed-secret-that-must-not-escape',
    createdAt: new Date('2026-09-24T12:00:00Z'),
  } as User;

  const controllerWithStoredUser = () => {
    const usersService = {
      create: jest.fn().mockResolvedValue(storedUser),
      update: jest.fn().mockResolvedValue(storedUser),
      findAll: jest.fn().mockResolvedValue([storedUser]),
      findOneById: jest.fn().mockResolvedValue(storedUser),
    };
    const accessEvents = { emitAccessRevoked: jest.fn() };
    const controller = new UsersController(usersService as any, accessEvents as any);
    return { controller, usersService, accessEvents };
  };

  it('never includes the password hash in the create response', async () => {
    const { controller, usersService } = controllerWithStoredUser();
    const result = await controller.create({
      name: storedUser.name,
      username: storedUser.username,
      role: storedUser.role,
      password: 'not-the-stored-hash',
    }, { user: { userId: 'admin-1', username: 'admin' } });

    expect(result).toMatchObject({ id: storedUser.id, role: UserRole.CAJERO });
    expect(result).not.toHaveProperty('password');
    expect(JSON.stringify(result)).not.toContain(storedUser.password);
    expect(usersService.create.mock.calls[0][0].password.split('$')[2]).toBe('12');
  });

  it('never includes the password hash in the update response', async () => {
    const { controller } = controllerWithStoredUser();
    const result = await controller.update(storedUser.id, { name: 'Caja Uno' }, {
      user: { userId: 'admin-1', username: 'admin', role: UserRole.ADMIN },
    });

    expect(result).toMatchObject({ id: storedUser.id, name: storedUser.name });
    expect(result).not.toHaveProperty('password');
    expect(JSON.stringify(result)).not.toContain(storedUser.password);
  });

  it('uses cost 12 when an administrator changes a password', async () => {
    const { controller, usersService } = controllerWithStoredUser();
    await controller.update(storedUser.id, { password: 'new-unique-test-password' }, {
      user: { userId: 'admin-1', username: 'admin', role: UserRole.ADMIN },
    });

    expect(usersService.update.mock.calls[0][1].password.split('$')[2]).toBe('12');
  });

  it('disconnects local websocket sessions after a successful password change', async () => {
    const { controller, accessEvents } = controllerWithStoredUser();

    await controller.update(storedUser.id, { password: 'new-unique-test-password' }, {
      user: { userId: 'admin-1', username: 'admin', role: UserRole.ADMIN },
    });

    expect(accessEvents.emitAccessRevoked).toHaveBeenCalledWith(storedUser.id);
  });

  it('never includes the password hash in the list response', async () => {
    const { controller } = controllerWithStoredUser();
    const result = await controller.findAll();

    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty('password');
    expect(JSON.stringify(result)).not.toContain(storedUser.password);
  });
});
