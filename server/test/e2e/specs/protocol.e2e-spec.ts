import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  ANCHOR_PROTOCOL,
  MIN_ANCHOR_PROTOCOL,
  SUPPORTED_PROTOCOLS,
} from 'src/common/protocol/protocol.constants';
import { ANCHOR_PROTOCOL_HEADER } from 'src/common/protocol/protocol.guard';
import { Actor, bodyOf, createE2EApp, E2EApp } from '../support';

interface ProtocolRefusal {
  statusCode: number;
  code: string;
  message: string;
  protocols: number[];
}

const UNSERVABLE = `${MIN_ANCHOR_PROTOCOL - 1}`;

/** Every `/api` route the server has registered, with params filled in. */
function apiRoutes(app: E2EApp): { method: string; path: string }[] {
  const express = (app.app as NestExpressApplication)
    .getHttpAdapter()
    .getInstance() as {
    router: { stack: { route?: { path: string; methods: object } }[] };
  };

  const routes: { method: string; path: string }[] = [];
  for (const layer of express.router.stack) {
    if (!layer.route?.path?.startsWith('/api')) continue;
    const path = layer.route.path.replace(/:[^/]+/g, 'e2e-probe');
    for (const [method, enabled] of Object.entries(layer.route.methods)) {
      if (enabled && method !== '_all') routes.push({ method, path });
    }
  }
  return routes;
}

describe('protocol compatibility', () => {
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

  const sync = (protocol?: string) => {
    const req = user.http.post('/api/sync').send({});
    return protocol === undefined
      ? req
      : req.set(ANCHOR_PROTOCOL_HEADER, protocol);
  };

  it('advertises the servable protocols unauthenticated', async () => {
    const res = await request(ctx.http).get('/api/health').expect(200);
    const body = bodyOf<{ protocols: number[] }>(res);

    expect(res.body).toMatchObject({ status: 'ok', app: 'anchor' });
    expect(body.protocols).toEqual(SUPPORTED_PROTOCOLS);
  });

  it('answers health even to a client it will not serve', async () => {
    await request(ctx.http)
      .get('/api/health')
      .set(ANCHOR_PROTOCOL_HEADER, UNSERVABLE)
      .expect(200);
  });

  it('syncs for a client speaking the current protocol', async () => {
    const res = await sync(`${ANCHOR_PROTOCOL}`).expect(200);

    expect(bodyOf<{ protocol: number }>(res).protocol).toBe(ANCHOR_PROTOCOL);
  });

  it('syncs for a client that sends no protocol at all', async () => {
    await sync().expect(200);
  });

  it('refuses an app older than the oldest servable protocol', async () => {
    const res = await sync(UNSERVABLE).expect(426);

    expect(res.body).toMatchObject({
      statusCode: 426,
      code: 'APP_OUTDATED',
      protocols: SUPPORTED_PROTOCOLS,
    });
    expect(bodyOf<ProtocolRefusal>(res).message).toContain('app is too old');
  });

  it('refuses a client newer than the server and names the server as behind', async () => {
    const res = await sync(`${ANCHOR_PROTOCOL + 1}`).expect(426);

    expect(res.body).toMatchObject({ code: 'SERVER_OUTDATED' });
    expect(bodyOf<ProtocolRefusal>(res).message).toContain('server is too old');
  });

  it('gates the event stream on the same protocol', async () => {
    await user.http
      .get('/api/sync/events')
      .set(ANCHOR_PROTOCOL_HEADER, `${ANCHOR_PROTOCOL + 1}`)
      .expect(426);
  });

  it('refuses before authenticating, so an outdated app is told so', async () => {
    await request(ctx.http)
      .post('/api/sync')
      .set(ANCHOR_PROTOCOL_HEADER, UNSERVABLE)
      .send({})
      .expect(426);
  });

  describe('every api route', () => {
    it('is registered, so the sweep below is not vacuous', () => {
      expect(apiRoutes(ctx).length).toBeGreaterThan(20);
    });

    it('refuses an unservable protocol, health aside', async () => {
      const served: string[] = [];

      for (const { method, path } of apiRoutes(ctx)) {
        if (path.startsWith('/api/health')) continue;

        const res = await request(ctx.http)
          [method as 'get'](path)
          .set(ANCHOR_PROTOCOL_HEADER, UNSERVABLE)
          .send();
        if (res.status !== 426)
          served.push(`${method} ${path} -> ${res.status}`);
      }

      expect(served).toEqual([]);
    });
  });

  describe('tolerance for a newer client', () => {
    it('ignores an unknown top-level field', async () => {
      await user.http
        .post('/api/sync')
        .send({ someNewField: true })
        .expect(200);
    });

    it('ignores an unknown field inside a change', async () => {
      const res = await user.http
        .post('/api/sync')
        .send({
          changes: [{ type: 'tag', id: 'tag-1', name: 'kept', someNewFlag: 1 }],
        })
        .expect(200);

      expect(bodyOf<{ results: { status: string }[] }>(res).results).toEqual([
        expect.objectContaining({ status: 'applied' }),
      ]);
    });

    it('ignores an unknown field on an ordinary endpoint', async () => {
      await user.http
        .post('/api/tags')
        .send({ name: 'x', someNewField: true })
        .expect(201);
    });

    it('still rejects a declared field of the wrong type', async () => {
      await user.http.post('/api/sync').send({ limit: 'lots' }).expect(400);
    });

    it('keeps the admin api strict, since it ships with the server', async () => {
      await user.http
        .patch('/api/admin/settings/registration')
        .send({ mode: 'enabled', someNewField: true })
        .expect(400);
    });
  });
});
