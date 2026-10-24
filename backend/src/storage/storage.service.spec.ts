import { v2 as cloudinary } from 'cloudinary';
import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { StorageService } from './storage.service';
import { PassThrough } from 'stream';
import * as fs from 'fs';

jest.mock('cloudinary', () => ({
  v2: {
    config: jest.fn(),
    uploader: { upload_stream: jest.fn(), destroy: jest.fn() },
    utils: { private_download_url: jest.fn() },
  },
}));

describe('StorageService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, NODE_ENV: 'production' };
    delete process.env.CLOUDINARY_CLOUD_NAME;
    delete process.env.CLOUDINARY_API_KEY;
    delete process.env.CLOUDINARY_API_SECRET;
    delete process.env.CLOUDINARY_URL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('configures Cloudinary from CLOUDINARY_URL', () => {
    process.env.CLOUDINARY_URL = `cloudinary:${'//'}api-key:api-secret@cloud-name`;

    new StorageService();

    expect(cloudinary.config).toHaveBeenCalledWith({
      api_key: 'api-key',
      api_secret: 'api-secret',
      cloud_name: 'cloud-name',
      secure: true,
    });
  });

  it('also accepts separate Render credential variables', () => {
    process.env.CLOUDINARY_CLOUD_NAME = 'cloud-name';
    process.env.CLOUDINARY_API_KEY = 'api-key';
    process.env.CLOUDINARY_API_SECRET = 'api-secret';

    new StorageService();

    expect(cloudinary.config).toHaveBeenCalledWith({
      api_key: 'api-key',
      api_secret: 'api-secret',
      cloud_name: 'cloud-name',
      secure: true,
    });
  });

  it('refuses production uploads when no persistent file storage is configured', async () => {
    const service = new StorageService();

    await expect(service.saveFile({} as Express.Multer.File)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('stores a new proof as authenticated raw data and returns an opaque reference', async () => {
    process.env.CLOUDINARY_CLOUD_NAME = 'cloud-name';
    process.env.CLOUDINARY_API_KEY = 'api-key';
    process.env.CLOUDINARY_API_SECRET = 'api-secret';
    (cloudinary.uploader.upload_stream as jest.Mock).mockImplementation((options, done) => {
      const stream = new PassThrough();
      stream.on('finish', () => done(null, {
        public_id: options.public_id,
        type: 'authenticated',
        resource_type: 'raw',
      }));
      return stream;
    });

    const service = new StorageService();
    const ref = await service.saveFile({
      buffer: Buffer.from('%PDF-1.7\n'), size: 9, mimetype: 'application/pdf', originalname: 'secret.pdf',
    } as Express.Multer.File);

    expect(cloudinary.uploader.upload_stream).toHaveBeenCalledWith(expect.objectContaining({
      type: 'authenticated', resource_type: 'raw', overwrite: false,
      public_id: expect.stringMatching(/^transferencias\/[a-f0-9-]+\.pdf$/),
    }), expect.any(Function));
    expect(ref).toMatch(/^cld-auth-raw:transferencias\/[a-f0-9-]+\.pdf$/);
    expect(ref).not.toContain('secret');
    expect(ref).not.toContain('http');
  });

  it('reads a private proof only through the backend and bounds its response', async () => {
    process.env.CLOUDINARY_CLOUD_NAME = 'cloud-name';
    process.env.CLOUDINARY_API_KEY = 'api-key';
    process.env.CLOUDINARY_API_SECRET = 'api-secret';
    (cloudinary.utils.private_download_url as jest.Mock).mockReturnValue('https://api.cloudinary.com/v1_1/cloud-name/raw/download?signature=test');
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(Buffer.from('%PDF-1.7\n'), { status: 200, headers: { 'content-type': 'application/pdf' } }),
    );
    try {
      const service = new StorageService();
      const result = await service.readFile('cld-auth-raw:transferencias/12345678-1234-1234-1234-123456789abc.pdf');
      expect(result.mimeType).toBe('application/pdf');
      expect(result.buffer.toString()).toBe('%PDF-1.7\n');
      expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining('api.cloudinary.com'), expect.objectContaining({ redirect: 'error' }));
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('can compensate only a newly created authenticated proof', async () => {
    process.env.CLOUDINARY_CLOUD_NAME = 'cloud-name';
    process.env.CLOUDINARY_API_KEY = 'api-key';
    process.env.CLOUDINARY_API_SECRET = 'api-secret';
    (cloudinary.uploader.destroy as jest.Mock).mockResolvedValue({ result: 'ok' });
    const service = new StorageService();
    await service.deleteNewFile('cld-auth-raw:transferencias/12345678-1234-1234-1234-123456789abc.pdf');
    expect(cloudinary.uploader.destroy).toHaveBeenCalledWith(
      'transferencias/12345678-1234-1234-1234-123456789abc.pdf',
      { resource_type: 'raw', type: 'authenticated', invalidate: true },
    );
    await expect(service.deleteNewFile('https://res.cloudinary.com/cloud-name/image/upload/old.jpg')).rejects.toThrow();
  });

  it('does not follow a local uploads symlink', async () => {
    const lstat = jest.spyOn(fs.promises, 'lstat').mockResolvedValue({
      isFile: () => false, isSymbolicLink: () => true, size: 9,
    } as fs.Stats);
    try {
      const service = new StorageService();
      await expect(service.readFile('/uploads/old-proof.pdf')).rejects.toBeInstanceOf(NotFoundException);
      expect(lstat).toHaveBeenCalled();
    } finally {
      lstat.mockRestore();
    }
  });

  it('refuses an arbitrary legacy URL without fetching it', async () => {
    process.env.CLOUDINARY_CLOUD_NAME = 'cloud-name';
    process.env.CLOUDINARY_API_KEY = 'api-key';
    process.env.CLOUDINARY_API_SECRET = 'api-secret';
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    try {
      const service = new StorageService();
      await expect(service.readFile('https://attacker.example/proof.pdf')).rejects.toBeInstanceOf(NotFoundException);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('rejects an unexpected signed-download host before any network request', async () => {
    process.env.CLOUDINARY_CLOUD_NAME = 'cloud-name';
    process.env.CLOUDINARY_API_KEY = 'api-key';
    process.env.CLOUDINARY_API_SECRET = 'api-secret';
    (cloudinary.utils.private_download_url as jest.Mock).mockReturnValue('https://attacker.example/download');
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    try {
      const service = new StorageService();
      await expect(service.readFile('cld-auth-raw:transferencias/12345678-1234-1234-1234-123456789abc.pdf'))
        .rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('serves a local fallback only through its private reference', async () => {
    process.env.NODE_ENV = 'test';
    const service = new StorageService();
    const reference = await service.saveFile({ buffer: Buffer.from('%PDF-1.7\n'), size: 9, mimetype: 'application/pdf' } as Express.Multer.File);
    try {
      expect(reference).toMatch(/^local-private:[a-f0-9-]+\.pdf$/);
      const read = await service.readFile(reference);
      expect(read.mimeType).toBe('application/pdf');
      expect(read.buffer.toString()).toBe('%PDF-1.7\n');
    } finally {
      await service.deleteNewFile(reference);
    }
  });

  it('rejects remote files bigger than the proof limit before accepting their bytes', async () => {
    process.env.CLOUDINARY_CLOUD_NAME = 'cloud-name';
    process.env.CLOUDINARY_API_KEY = 'api-key';
    process.env.CLOUDINARY_API_SECRET = 'api-secret';
    (cloudinary.utils.private_download_url as jest.Mock).mockReturnValue('https://api.cloudinary.com/v1_1/cloud-name/raw/download?signature=test');
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('%PDF-1.7\n', {
      status: 200, headers: { 'content-length': String(10 * 1024 * 1024 + 1) },
    }));
    try {
      const service = new StorageService();
      await expect(service.readFile('cld-auth-raw:transferencias/12345678-1234-1234-1234-123456789abc.pdf'))
        .rejects.toBeInstanceOf(ServiceUnavailableException);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
