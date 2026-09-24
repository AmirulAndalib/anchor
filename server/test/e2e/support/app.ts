import * as http from 'http';
import type { AddressInfo } from 'net';
import { INestApplication, Type } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from 'src/app.module';
import { setupApp } from 'src/app.setup';
import { StorageConfig } from 'src/config/configuration';
import { PrismaService } from 'src/prisma/prisma.service';
import { Actor, TestUser } from './actor';
import type { SyncEventStream } from './api/events.api';
import type { TestServer } from './http';

let userCounter = 0;

export interface NoteClocks {
  updatedAt?: Date;
  stateChangedAt?: Date;
}

/** One booted application per spec file, against the shared e2e database. */
export class E2EApp {
  private readonly streams: SyncEventStream[] = [];

  constructor(
    readonly app: INestApplication,
    readonly prisma: PrismaService,
  ) {}

  get http(): TestServer {
    return this.app.getHttpServer() as TestServer;
  }

  get address(): AddressInfo {
    const server = this.app.getHttpServer() as http.Server;
    return server.address() as AddressInfo;
  }

  get storage(): ConfigType<typeof StorageConfig> {
    return this.app.get<ConfigType<typeof StorageConfig>>(StorageConfig.KEY);
  }

  get<T>(token: Type<T>): T {
    return this.app.get(token);
  }

  async registerUser(name?: string): Promise<Actor> {
    userCounter += 1;
    const email = `user${userCounter}@e2e.test`;
    const userName = name ?? `User ${userCounter}`;
    const res = await request(this.http)
      .post('/api/auth/register')
      .send({ email, password: 'password-123', name: userName });
    if (res.status !== 201) {
      throw new Error(`registerUser -> ${res.status}: ${res.text}`);
    }

    const user: TestUser = {
      id: (res.body as { user: { id: string } }).user.id,
      email,
      name: userName,
      token: (res.body as { access_token: string }).access_token,
    };
    return new Actor(this.http, this.address, user, (stream) =>
      this.streams.push(stream),
    );
  }

  async resetDb(): Promise<void> {
    await this.prisma
      .$executeRaw`TRUNCATE TABLE "User", "Settings" RESTART IDENTITY CASCADE`;
  }

  // Backdates a note's clocks past Prisma, which would otherwise restamp
  // updatedAt.
  async setNoteClocks(noteId: string, clocks: NoteClocks): Promise<void> {
    const updatedAt = clocks.updatedAt?.toISOString() ?? null;
    const stateChangedAt = clocks.stateChangedAt?.toISOString() ?? null;

    await this.prisma.$executeRaw`
      UPDATE "Note" SET
        "updatedAt" = COALESCE(${updatedAt}::timestamptz AT TIME ZONE 'UTC', "updatedAt"),
        "stateChangedAt" = COALESCE(${stateChangedAt}::timestamptz AT TIME ZONE 'UTC', "stateChangedAt")
      WHERE id = ${noteId}`;
  }

  // Shifts a note's revisions a day into the past, keeping their order, so the
  // next edit by the same author falls outside the autosave collapse window.
  async ageNoteRevisions(noteId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "NoteRevision" SET "createdAt" = "createdAt" - interval '1 day'
      WHERE "noteId" = ${noteId}`;
  }

  closeEventStreams(): void {
    for (const stream of this.streams.splice(0)) stream.close();
  }

  async close(): Promise<void> {
    this.closeEventStreams();
    // Idle keep-alive sockets would hold close() open and outlive the port.
    (this.app.getHttpServer() as http.Server).closeAllConnections();
    await this.app.close();
    await this.prisma.$disconnect();
  }
}

export async function createE2EApp(): Promise<E2EApp> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({
    logger: false,
  });
  setupApp(app);
  await app.init();
  // Listen once on a stable port: supertest otherwise binds a fresh ephemeral
  // listener per request, and the recycled ports cross-talk between suites.
  const server: http.Server = app.getHttpServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return new E2EApp(app, app.get(PrismaService));
}
