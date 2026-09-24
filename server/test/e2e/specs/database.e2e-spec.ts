import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { Client } from 'pg';

describe('database schema and sync sequences', () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: inject('databaseUrl') });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  it('has all migrations applied', async () => {
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL`,
    );
    expect(Number(rows[0].count)).toBeGreaterThan(0);

    const { rows: tables } = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    const names = tables.map((t) => t.tablename);
    expect(names).toEqual(
      expect.arrayContaining([
        'User',
        'Note',
        'Tag',
        'NoteShare',
        'SyncState',
        'ChangeLog',
        'NoteRevision',
      ]),
    );
  });

  it('leaves no sync watermark column or trigger on Note', async () => {
    const { rows: columns } = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'Note'`,
    );
    expect(columns.map((c) => c.column_name)).not.toContain('syncedAt');

    const { rows: triggers } = await client.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal`,
    );
    expect(triggers.map((t) => t.tgname)).not.toContain('note_set_synced_at');
  });

  it('next_sync_seq allocates contiguous per-user blocks', async () => {
    await client.query(
      `INSERT INTO "User" (id, email, password, name, "updatedAt")
       VALUES ('seq-user-a', 'seq-a@example.com', 'x', 'A', now()),
              ('seq-user-b', 'seq-b@example.com', 'x', 'B', now())`,
    );

    const seq = async (uid: string, n: number): Promise<number> => {
      const { rows } = await client.query<{ seq: string }>(
        `SELECT next_sync_seq($1, $2) AS seq`,
        [uid, n],
      );
      return Number(rows[0].seq);
    };

    // Returns the last seq of the block [result - n + 1, result].
    expect(await seq('seq-user-a', 1)).toBe(1);
    expect(await seq('seq-user-a', 5)).toBe(6);
    expect(await seq('seq-user-a', 1)).toBe(7);
    // Counters are independent per user.
    expect(await seq('seq-user-b', 1)).toBe(1);

    await client.query(
      `DELETE FROM "User" WHERE id IN ('seq-user-a', 'seq-user-b')`,
    );
  });

  it('next_sync_seq serializes concurrent writers on the SyncState row lock', async () => {
    await client.query(
      `INSERT INTO "User" (id, email, password, name, "updatedAt")
       VALUES ('seq-lock-user', 'seq-lock@example.com', 'x', 'Lock', now())`,
    );
    const rival = new Client({
      connectionString: inject('databaseUrl'),
    });
    await rival.connect();

    try {
      await client.query('BEGIN');
      await client.query(`SELECT next_sync_seq('seq-lock-user', 3)`);

      let rivalDone = false;
      const rivalSeq = rival
        .query<{
          seq: string;
        }>(`SELECT next_sync_seq('seq-lock-user', 1) AS seq`)
        .then(({ rows }) => {
          rivalDone = true;
          return Number(rows[0].seq);
        });

      // The rival blocks on the uncommitted row lock...
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(rivalDone).toBe(false);

      // ...and only gets its seq (after the full block) once we commit.
      await client.query('COMMIT');
      expect(await rivalSeq).toBe(4);
    } finally {
      await rival.end();
      await client.query(`DELETE FROM "User" WHERE id = 'seq-lock-user'`);
    }
  });
});
