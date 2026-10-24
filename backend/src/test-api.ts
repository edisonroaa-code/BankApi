import axios from 'axios';

type SmokeEnvironment = Record<string, string | undefined>;

export const readLocalSmokeConfig = (env: SmokeEnvironment) => {
    const username = env.TEST_API_USERNAME?.trim();
    if (!username) throw new Error('TEST_API_USERNAME es obligatorio');
    const password = env.TEST_API_PASSWORD;
    if (!password) throw new Error('TEST_API_PASSWORD es obligatorio');

    const url = new URL(env.TEST_API_BASE_URL || 'http://127.0.0.1:3000');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('El smoke test solo se admite contra una API local');
    }
    return { baseUrl: url.origin, username, password };
};

const testApi = async () => {
    const { baseUrl, username, password } = readLocalSmokeConfig(process.env);
    const login = await axios.post(`${baseUrl}/auth/login`, { username, password });
    const token = login.data.access_token;
    if (!token) throw new Error('No se recibió token');

    const headers = { Authorization: `Bearer ${token}` };
    const users = await axios.get(`${baseUrl}/users`, { headers });
    const summary = await axios.get(`${baseUrl}/payments/summary?startDate=2024-01-01&endDate=2025-12-31`, { headers });
    console.info('Smoke local completado', {
        login: login.status,
        users: users.status,
        summary: summary.status,
    });
};

if (require.main === module) {
    testApi().catch(() => {
        // Never print tokens, credentials, or server response bodies.
        console.error('Smoke local fallido; revisar la API y las credenciales suministradas.');
        process.exitCode = 1;
    });
}
