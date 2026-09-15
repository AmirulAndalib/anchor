import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from 'pg';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

const SERVER_ROOT = path.resolve(__dirname, '..', '..', '..');
const DATABASE = 'e2e';

declare global {
  var __E2E_PG_CONTAINER__: StartedPostgreSqlContainer | undefined;

  var __E2E_DATA_DIR__: string | undefined;
}

export default async function globalSetup(): Promise<void> {
  const container = await new PostgreSqlContainer('postgres:18-alpine').start();
  globalThis.__E2E_PG_CONTAINER__ = container;

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
  process.env.E2E_DATABASE_URL = databaseUrl;

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-e2e-'));
  globalThis.__E2E_DATA_DIR__ = dataDir;
  process.env.E2E_DATA_DIR = dataDir;
}
