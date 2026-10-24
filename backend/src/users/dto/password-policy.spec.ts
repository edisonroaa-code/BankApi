import { validate } from 'class-validator';
import { CreateUserDto } from './create-user.dto';
import { UpdateUserDto } from './update-user.dto';
import { LoginDto } from '../../auth/dto/login.dto';

describe('Password policy for user administration', () => {
  it.each(['12345', '1234567', 'LongPassphrase16!'])('rejects a new password outside six characters: %s', async (password) => {
    const create = Object.assign(new CreateUserDto(), {
      name: 'Test', username: 'test', role: 'COBRADOR', password,
    });
    const update = Object.assign(new UpdateUserDto(), { password });
    expect((await validate(create)).some((error) => error.property === 'password')).toBe(true);
    expect((await validate(update)).some((error) => error.property === 'password')).toBe(true);
  });

  it('accepts a six-character password on create and update', async () => {
    const create = Object.assign(new CreateUserDto(), {
      name: 'Test', username: 'test', role: 'COBRADOR', password: 'Ab3#xy',
    });
    expect((await validate(create)).find((error) => error.property === 'password')).toBeUndefined();
    expect((await validate(Object.assign(new UpdateUserDto(), { password: 'Ab3#xy' })))).toHaveLength(0);
  });

  it('preserves existing longer passwords at login and permits updates without changing a password', async () => {
    const login = Object.assign(new LoginDto(), { username: 'existing', password: 'LongPassphrase16!' });
    expect(await validate(login)).toHaveLength(0);
    expect(await validate(Object.assign(new UpdateUserDto(), { name: 'Existing' }))).toHaveLength(0);
  });
});
