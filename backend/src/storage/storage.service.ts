import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { v2 as cloudinary } from 'cloudinary';
import * as streamifier from 'streamifier';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import { extensionForProofKind, inspectStoredProof, MAX_PROOF_BYTES, validateProofFile } from '../payments/proof-file-policy';

const PRIVATE_CLOUDINARY_REF = /^cld-auth-raw:(transferencias\/[a-f0-9-]{36}\.(?:jpg|png|webp|gif|tif|heic|pdf))$/;
const PRIVATE_LOCAL_REF = /^local-private:([a-f0-9-]{36}\.(?:jpg|png|webp|gif|tif|heic|pdf))$/;
const LEGACY_LOCAL_REF = /^\/uploads\/([A-Za-z0-9._-]{1,220})$/;

@Injectable()
export class StorageService {
    private readonly logger = new Logger(StorageService.name);
    private readonly cloudinaryConfigured: boolean;
    private cloudName = '';
    private readonly uploadDir = path.join(__dirname, '..', '..', 'uploads');

    constructor() {
        this.cloudinaryConfigured = this.configureCloudinary();

        // We still create the local uploads dir just in case for legacy scripts
        if (!fs.existsSync(this.uploadDir)) {
            fs.mkdirSync(this.uploadDir, { recursive: true });
        }
    }

    private configureCloudinary(): boolean {
        const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
        const apiKey = process.env.CLOUDINARY_API_KEY?.trim();
        const apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();

        if (cloudName && apiKey && apiSecret) {
            cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });
            this.cloudName = cloudName;
            return true;
        }

        const cloudinaryUrl = process.env.CLOUDINARY_URL?.trim();
        if (!cloudinaryUrl) return false;

        try {
            const parsed = new URL(cloudinaryUrl);
            if (parsed.protocol !== 'cloudinary:' || !parsed.hostname || !parsed.username || !parsed.password) {
                this.logger.error('CLOUDINARY_URL tiene un formato inválido.');
                return false;
            }
            cloudinary.config({
                cloud_name: parsed.hostname,
                api_key: decodeURIComponent(parsed.username),
                api_secret: decodeURIComponent(parsed.password),
                secure: true,
            });
            this.cloudName = parsed.hostname;
            return true;
        } catch {
            this.logger.error('CLOUDINARY_URL tiene un formato inválido.');
            return false;
        }
    }

    async saveFile(file: Express.Multer.File): Promise<string> {
        if (!this.cloudinaryConfigured) {
            if (process.env.NODE_ENV === 'production') {
                throw new ServiceUnavailableException(
                    'No se pudo guardar el comprobante: el almacenamiento de archivos no está configurado.',
                );
            }
        }
        const kind = validateProofFile(file);
        if (!this.cloudinaryConfigured) {
            this.logger.warn('CLOUDINARY_URL no está configurado, usando almacenamiento local de fallback.');
            // La extensión nunca se toma del nombre proporcionado por el cliente.
            const fileName = `${randomUUID()}${extensionForProofKind(kind)}`;
            const filePath = path.join(this.uploadDir, fileName);
            await fs.promises.writeFile(filePath, file.buffer);
            return `local-private:${fileName}`;
        }

        return new Promise((resolve, reject) => {
            const publicId = `transferencias/${randomUUID()}${extensionForProofKind(kind)}`;
            const uploadStream = cloudinary.uploader.upload_stream(
                {
                    public_id: publicId,
                    resource_type: 'raw',
                    type: 'authenticated',
                    overwrite: false,
                    unique_filename: false,
                },
                (error, result) => {
                    if (error || !result) {
                        this.logger.error(`Cloudinary no pudo guardar el comprobante (HTTP ${error?.http_code ?? 'desconocido'}).`);
                        return reject(new ServiceUnavailableException('No se pudo guardar el comprobante. Intentá nuevamente.'));
                    }
                    if (result.public_id !== publicId || result.type !== 'authenticated' || result.resource_type !== 'raw') {
                        this.logger.error('Cloudinary devolvió metadatos inesperados para un comprobante.');
                        return reject(new ServiceUnavailableException('No se pudo guardar el comprobante. Intentá nuevamente.'));
                    }
                    resolve(`cld-auth-raw:${publicId}`);
                },
            );

            // Read the buffer and pipe it to Cloudinary
            streamifier.createReadStream(file.buffer).pipe(uploadStream);
        });
    }

    /** Nunca admite una URL arbitraria: las fuentes históricas quedan restringidas al cloud propio. */
    async readFile(reference: string): Promise<{ buffer: Buffer; mimeType: string; extension: string }> {
        const privateCloudinary = PRIVATE_CLOUDINARY_REF.exec(reference);
        const privateLocal = PRIVATE_LOCAL_REF.exec(reference);
        const legacyLocal = LEGACY_LOCAL_REF.exec(reference);
        let buffer: Buffer;

        if (privateCloudinary) {
            if (!this.cloudinaryConfigured) throw new ServiceUnavailableException('El almacenamiento no está disponible.');
            const publicId = privateCloudinary[1];
            const format = path.extname(publicId).slice(1);
            const signedUrl = cloudinary.utils.private_download_url(publicId, format, {
                resource_type: 'raw', type: 'authenticated', expires_at: Math.floor(Date.now() / 1000) + 60,
            });
            const parsed = new URL(signedUrl);
            if (parsed.protocol !== 'https:' || parsed.hostname !== 'api.cloudinary.com' ||
                parsed.pathname !== `/v1_1/${this.cloudName}/raw/download`) {
                throw new ServiceUnavailableException('El almacenamiento no está disponible.');
            }
            buffer = await this.fetchBounded(signedUrl);
        } else if (privateLocal || legacyLocal) {
            const filename = (privateLocal || legacyLocal)![1];
            if (filename === '.' || filename === '..' || filename.includes('..')) throw new NotFoundException('Comprobante no disponible.');
            try {
                const rootStat = await fs.promises.lstat(this.uploadDir);
                if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('unsafe upload directory');
                const uploadRoot = await fs.promises.realpath(this.uploadDir);
                const filePath = path.join(this.uploadDir, filename);
                const stat = await fs.promises.lstat(filePath);
                if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PROOF_BYTES) throw new Error('unsafe upload file');
                const resolved = await fs.promises.realpath(filePath);
                if (path.dirname(resolved) !== uploadRoot) throw new Error('unsafe upload path');
                buffer = await fs.promises.readFile(filePath);
            } catch {
                throw new NotFoundException('Comprobante no disponible.');
            }
        } else {
            const legacyUrl = this.parseLegacyCloudinaryUrl(reference);
            if (!legacyUrl) throw new NotFoundException('Comprobante no disponible.');
            buffer = await this.fetchBounded(legacyUrl);
        }

        const inspected = inspectStoredProof(buffer);
        if (!inspected) throw new ServiceUnavailableException('El comprobante no tiene un formato seguro para visualizar.');
        return { buffer, mimeType: inspected.mimeType, extension: extensionForProofKind(inspected.kind) };
    }

    /** Compensación limitada a objetos recién creados por este esquema; nunca borra históricos. */
    async deleteNewFile(reference: string): Promise<void> {
        const cloud = PRIVATE_CLOUDINARY_REF.exec(reference);
        const local = PRIVATE_LOCAL_REF.exec(reference);
        if (cloud && this.cloudinaryConfigured) {
            const result = await cloudinary.uploader.destroy(cloud[1], { resource_type: 'raw', type: 'authenticated', invalidate: true });
            if (result.result !== 'ok' && result.result !== 'not found') throw new Error('No se pudo compensar la carga del comprobante.');
            return;
        }
        if (local) {
            await fs.promises.unlink(path.join(this.uploadDir, local[1]));
            return;
        }
        throw new Error('No se puede compensar un comprobante histórico o desconocido.');
    }

    private parseLegacyCloudinaryUrl(reference: string): string | null {
        if (!this.cloudinaryConfigured) return null;
        try {
            const parsed = new URL(reference);
            if (parsed.protocol !== 'https:' || parsed.hostname !== 'res.cloudinary.com' || parsed.username || parsed.password ||
                parsed.search || parsed.hash || !parsed.pathname.startsWith(`/${this.cloudName}/`)) return null;
            if (!/^\/(?:image|raw)\/upload\//.test(parsed.pathname.slice(this.cloudName.length + 1))) return null;
            return parsed.toString();
        } catch {
            return null;
        }
    }

    private async fetchBounded(url: string): Promise<Buffer> {
        try {
            const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
            if (!response.ok || !response.body) throw new Error('remote response not available');
            const length = Number(response.headers.get('content-length'));
            if (Number.isFinite(length) && length > MAX_PROOF_BYTES) throw new Error('remote proof too large');
            const reader = response.body.getReader();
            const chunks: Buffer[] = [];
            let total = 0;
            try {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    total += value.byteLength;
                    if (total > MAX_PROOF_BYTES) throw new Error('remote proof too large');
                    chunks.push(Buffer.from(value));
                }
            } finally {
                if (total > MAX_PROOF_BYTES) await reader.cancel().catch(() => undefined);
            }
            return Buffer.concat(chunks);
        } catch {
            throw new ServiceUnavailableException('No se pudo recuperar el comprobante. Intentá nuevamente.');
        }
    }
}
