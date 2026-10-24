import { v2 as cloudinary } from 'cloudinary';
import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

const requiredEnv = (name: string): string => {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
};

const configureCloudinary = () => {
    const cloudinaryUrl = process.env.CLOUDINARY_URL?.trim();
    if (cloudinaryUrl) {
        const parsed = new URL(cloudinaryUrl);
        if (parsed.protocol !== 'cloudinary:' || !parsed.hostname || !parsed.username || !parsed.password) {
            throw new Error('CLOUDINARY_URL has an invalid format');
        }
        cloudinary.config({
            cloud_name: parsed.hostname,
            api_key: decodeURIComponent(parsed.username),
            api_secret: decodeURIComponent(parsed.password),
            secure: true,
        });
        return;
    }

    cloudinary.config({
        cloud_name: requiredEnv('CLOUDINARY_CLOUD_NAME'),
        api_key: requiredEnv('CLOUDINARY_API_KEY'),
        api_secret: requiredEnv('CLOUDINARY_API_SECRET'),
        secure: true,
    });
};

async function run() {
    configureCloudinary();

    console.log('Conectando a la base de datos Neon...');
    const client = new Client({
        connectionString: requiredEnv('DATABASE_URL'),
    });
    await client.connect();
    console.log('DB conectada.');

    try {
        const uploadsDir = path.join(__dirname, '..', 'uploads');
        if (!fs.existsSync(uploadsDir)) {
            console.log('No existe la carpeta uploads, nada que migrar.');
            return;
        }

        const files = fs.readdirSync(uploadsDir);
        let migratedCount = 0;

        for (const file of files) {
            if (file === '.gitkeep' || file.startsWith('.')) continue;

            const filePath = path.join(uploadsDir, file);
            const oldUrl = `/uploads/${file}`;
            const result = await client.query('SELECT id FROM payments WHERE "proofUrl" = $1', [oldUrl]);

            if (result.rowCount && result.rowCount > 0) {
                console.log(`Subiendo ${file} a Cloudinary...`);
                try {
                    const uploadResult = await cloudinary.uploader.upload(filePath, {
                        folder: 'transferencias',
                    });
                    const newUrl = uploadResult.secure_url;

                    await client.query('UPDATE payments SET "proofUrl" = $1 WHERE "proofUrl" = $2', [newUrl, oldUrl]);
                    console.log(`Migrado: ${oldUrl} -> ${newUrl}`);
                    migratedCount++;
                } catch (error) {
                    console.error(`Error subiendo ${file}:`, error);
                }
            }
        }

        console.log(`Migracion terminada. Se migraron ${migratedCount} imagenes.`);
    } finally {
        await client.end();
    }
}

run().catch((error) => {
    console.error('La migracion fallo:', error);
    process.exitCode = 1;
});
