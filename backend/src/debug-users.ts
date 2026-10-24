import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { UsersService } from './users/users.service';

async function bootstrap() {
    const app = await NestFactory.createApplicationContext(AppModule);
    const usersService = app.get(UsersService);

    console.log('--- USER DATABASE DUMP ---');
    const users = await usersService.findAll();
    console.table(users.map(u => ({
        username: u.username,
        role: u.role,
        isActive: u.isActive,
        id: u.id
    })));
    console.log('--------------------------');

    await app.close();
}
bootstrap();
