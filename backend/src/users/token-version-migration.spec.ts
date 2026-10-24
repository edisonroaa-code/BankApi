import { UserTokenVersion1790264302905 } from '../migrations/1790264302905-UserTokenVersion';

describe('UserTokenVersion migration', () => {
  it('adds a non-null persistent version initialized to zero', async () => {
    const queryRunner = { query: jest.fn().mockResolvedValue(undefined) };

    await new UserTokenVersion1790264302905().up(queryRunner as any);

    expect(queryRunner.query).toHaveBeenCalledWith(expect.stringMatching(
      /ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "tokenVersion" integer NOT NULL DEFAULT 0/,
    ));
  });

  it('blocks down migration to preserve revocation history', async () => {
    await expect(new UserTokenVersion1790264302905().down({} as any))
      .rejects.toThrow(/revocaci/i);
  });
});
