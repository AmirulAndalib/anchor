import * as fs from 'fs';

export default async function globalTeardown(): Promise<void> {
  await globalThis.__E2E_PG_CONTAINER__?.stop();

  const dataDir = globalThis.__E2E_DATA_DIR__;
  if (dataDir) {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
