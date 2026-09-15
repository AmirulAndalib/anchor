import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { INestApplication, Type } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from 'src/app.module';
import { PrismaService } from 'src/prisma/prisma.service';
import { AppValidationPipe } from 'src/common/pipes/app-validation.pipe';
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

  get port(): number {
    const server = this.app.getHttpServer() as http.Server;
    return (server.address() as AddressInfo).port;
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
    return new Actor(this.http, this.port, user, (stream) =>
      this.streams.push(stream),
    );
  }

  async resetDb(): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "User", "Settings" RESTART IDENTITY CASCADE',
    );
  }

  // Backdates a note's clocks past Prisma, which would otherwise restamp
  // updatedAt. Written as UTC wall time to match how Prisma reads the naive
  // columns.
  async setNoteClocks(noteId: string, clocks: NoteClocks): Promise<void> {
    const assignments: string[] = [];
    if (clocks.updatedAt) {
      assignments.push(`"updatedAt" = '${utcNaive(clocks.updatedAt)}'`);
    }
    if (clocks.stateChangedAt) {
      assignments.push(
        `"stateChangedAt" = '${utcNaive(clocks.stateChangedAt)}'`,
      );
    }
    if (assignments.length === 0) return;

    await this.prisma.$executeRawUnsafe(
      `UPDATE "Note" SET ${assignments.join(', ')} WHERE id = '${noteId}'`,
    );
  }

  // Backdates an attachment so the unused-attachment sweep can reach it.
  async ageAttachment(attachmentId: string, days: number): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `UPDATE "NoteAttachment" SET "createdAt" = "createdAt" - interval '${days} days' WHERE id = '${attachmentId}'`,
    );
  }

  // Shifts a note's revisions a day into the past, keeping their order, so the
  // next edit by the same author falls outside the autosave collapse window.
  async ageNoteRevisions(noteId: string): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `UPDATE "NoteRevision" SET "createdAt" = "createdAt" - interval '1 day' WHERE "noteId" = '${noteId}'`,
    );
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

/** Naive UTC timestamp literal for raw SQL against TIMESTAMP(3) columns. */
function utcNaive(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

export async function createE2EApp(): Promise<E2EApp> {
  const databaseUrl = process.env.E2E_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'Missing E2E_DATABASE_URL - is the e2e global setup running?',
    );
  }
  const dataRoot = process.env.E2E_DATA_DIR;
  if (!dataRoot) {
    throw new Error('Missing E2E_DATA_DIR - is the e2e global setup running?');
  }

  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = databaseUrl;
  process.env.JWT_SECRET ??= 'anchor-e2e-jwt-secret-0123456789';
  const dataDir = path.join(dataRoot, 'uploads-root');
  process.env.DATA_DIR = dataDir;
  fs.mkdirSync(dataDir, { recursive: true });

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({
    logger: false,
  });
  // Mirror the production bootstrap in src/main.ts.
  app.useBodyParser('json', { limit: '30mb' });
  app.useGlobalPipes(new AppValidationPipe());
  await app.init();
  // Listen once on a stable port: supertest otherwise binds a fresh ephemeral
  // listener per request, and the recycled ports cross-talk between suites.
  const server: http.Server = app.getHttpServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return new E2EApp(app, app.get(PrismaService));
}
