# End-to-end tests

`pnpm test:e2e` boots the real `AppModule` against a throwaway Postgres
(testcontainers) with every migration applied, and drives it over HTTP.

## Layout

```
setup/     vitest global setup: the container, the migrations, the environment
support/   everything specs are built from
  app.ts     E2EApp: boots the app, registers actors, resets the database
  actor.ts   a registered user together with the API they can drive
  api/       one client per area of the API, plus the SSE stream
  feed.ts    selectors over sync feed entries
  wire.ts    the response shapes these tests pin
  zip.ts     reads an exported archive back
specs/     the tests, one file per area
```

## Writing a spec

Boot one app per file, reset the database between tests, and go through actors
rather than supertest:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Actor, createE2EApp, E2EApp } from '../support';

describe('notes', () => {
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

  it('trashes a note', async () => {
    const note = await user.notes.create({ title: 'trash me' });
    await user.notes.trash(note.id);
    expect(await user.notes.listTrashed()).toHaveLength(1);
  });
});
```

Conventions:

- API client methods cover the successful path and return the parsed body. To
  assert a rejection, use `user.http.<verb>(path)` and expect the status.
- The app boots through `setupApp` in `src/app.setup.ts`, the same setup
  `main.ts` uses. Server-wide setup (middleware, CORS, static files) goes there,
  not in `main.ts`, so these tests run it too.
- Reach past the API with `ctx.prisma` for rows, and `ctx.get(Service)` for the
  paths that have no HTTP entry point (retention sweeps, prune jobs).
  `ctx.storage` says where uploaded files live on disk.
- Add a new endpoint to the matching client in `support/api` instead of calling
  supertest from a spec.
- The global setup hands the database URL and data folder to the tests; read
  them with `inject('databaseUrl')` and `inject('dataDir')` from `vitest`.
