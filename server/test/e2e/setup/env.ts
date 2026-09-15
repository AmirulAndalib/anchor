import * as path from 'path';

// ConfigModule.forRoot validates process.env when AppModule is imported, so
// the environment must be complete before any spec file's imports run.
// createE2EApp sets DATABASE_URL and DATA_DIR again before it compiles the app.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'anchor-e2e-jwt-secret-0123456789';
process.env.DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'postgresql://missing-global-setup';
if (process.env.E2E_DATA_DIR) {
  process.env.DATA_DIR = path.join(process.env.E2E_DATA_DIR, 'default');
}
