import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { REFRESH_TOKEN_REUSE_WINDOW_MS } from 'src/auth/constants/auth.constants';
import { Actor, bodyOf, createE2EApp, E2EApp } from '../support';

interface TokenPair {
  access_token: string;
  refresh_token: string;
}

describe('auth token refresh', () => {
  let ctx: E2EApp;
  let user: Actor;

  beforeAll(async () => {
    ctx = await createE2EApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    user = await ctx.registerUser();
  });

  const login = async (): Promise<TokenPair> => {
    const res = await request(ctx.http)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'password-123' })
      .expect(200);
    return bodyOf<TokenPair>(res);
  };

  const refresh = (refreshToken: string) =>
    request(ctx.http)
      .post('/api/auth/refresh')
      .send({ refresh_token: refreshToken });

  it('hands out a new pair that works', async () => {
    const { refresh_token } = await login();

    const res = await refresh(refresh_token).expect(200);
    const next = bodyOf<TokenPair>(res);

    expect(next.refresh_token).not.toBe(refresh_token);
    await request(ctx.http)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${next.access_token}`)
      .expect(200);
    await refresh(next.refresh_token).expect(200);
  });

  it('accepts the old token again when the first reply was lost', async () => {
    const { refresh_token } = await login();
    await refresh(refresh_token).expect(200);

    const res = await refresh(refresh_token).expect(200);
    await refresh(bodyOf<TokenPair>(res).refresh_token).expect(200);

    const old = await ctx.prisma.refreshToken.findUniqueOrThrow({
      where: { token: refresh_token },
    });
    expect(old.expiresAt.getTime()).toBeLessThanOrEqual(
      Date.now() + REFRESH_TOKEN_REUSE_WINDOW_MS,
    );
  });

  it('rejects the old token after the reuse window', async () => {
    const { refresh_token } = await login();
    await refresh(refresh_token).expect(200);

    await ctx.prisma.refreshToken.update({
      where: { token: refresh_token },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await refresh(refresh_token).expect(401);
  });

  it('answers two refreshes with the same token at once', async () => {
    const { refresh_token } = await login();

    const [a, b] = await Promise.all([
      refresh(refresh_token),
      refresh(refresh_token),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
});
