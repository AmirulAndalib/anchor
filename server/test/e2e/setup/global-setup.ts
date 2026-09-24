import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

const SERVER_ROOT = path.resolve(__dirname, '..', '..', '..');
const DATABASE = 'e2e';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    dataDir: string;
  }
}

export default async function globalSetup(project: TestProject) {
  const container = await new PostgreSqlContainer('postgres:18-alpine').start();

  const admin = new Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DATABASE}`);
  await admin.end();

  const url = new URL(container.getConnectionUri());
  url.pathname = `/${DATABASE}`;
  const databaseUrl = url.toString();

  execSync('pnpm exec prisma migrate deploy', {
    cwd: SERVER_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-e2e-'));

  project.provide('databaseUrl', databaseUrl);
  project.provide('dataDir', dataDir);

  return async () => {
    await container.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
}
