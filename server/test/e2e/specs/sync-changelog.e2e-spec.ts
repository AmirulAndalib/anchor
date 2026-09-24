import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SyncMaintenanceService } from 'src/sync/sync-maintenance.service';
import { Actor, createE2EApp, E2EApp } from '../support';

/**
 * Every write path emits ChangeLog rows, bumps versions on guarded fields, and
 * preserves replaced content as revisions. Read from the tables directly.
 */
describe('sync changelog', () => {
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

  function changeLog(recipientUserId: string) {
    return ctx.prisma.changeLog.findMany({
      where: { recipientUserId },
      orderBy: { seq: 'asc' },
    });
  }

  async function noteVersion(noteId: string): Promise<number> {
    const row = await ctx.prisma.note.findUniqueOrThrow({
      where: { id: noteId },
    });
    return row.version;
  }

  it('note create emits a note upsert to the owner at seq 1, version 1', async () => {
    const note = await user.notes.create({ title: 'first' });

    const rows = await changeLog(user.id);
    expect(rows).toEqual([
      expect.objectContaining({
        entityType: 'note',
        entityId: note.id,
        op: 'upsert',
        seq: 1n,
      }),
    ]);
    expect(await noteVersion(note.id)).toBe(1);
  });

  it('note edit re-stamps the same row with a fresh seq, bumps version, and preserves a revision', async () => {
    const note = await user.notes.create({ title: 'original', content: 'one' });

    await user.notes.update(note.id, { title: 'edited', content: 'two' });

    const rows = await changeLog(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].seq).toBe(2n);
    expect(await noteVersion(note.id)).toBe(2);

    const revisions = await ctx.prisma.noteRevision.findMany({
      where: { noteId: note.id },
    });
    expect(revisions).toEqual([
      expect.objectContaining({
        title: 'original',
        content: 'one',
        version: 1,
        authorUserId: user.id,
        cause: 'edit',
      }),
    ]);

    // A rapid same-author follow-up collapses into the same revision.
    await user.notes.update(note.id, { content: 'three' });
    expect(await ctx.prisma.noteRevision.count()).toBe(1);
    expect(await noteVersion(note.id)).toBe(3);
  });

  it('pin toggles emit pin rows without bumping the note version', async () => {
    const note = await user.notes.create({ title: 'pinnable' });

    await user.notes.update(note.id, { isPinned: true });

    const rows = await changeLog(user.id);
    const pinRow = rows.find((r) => r.entityType === 'pin');
    expect(pinRow).toMatchObject({ entityId: note.id, op: 'upsert' });
    expect(await noteVersion(note.id)).toBe(1);

    await user.notes.update(note.id, { isPinned: false });
    const after = await changeLog(user.id);
    expect(after.find((r) => r.entityType === 'pin')).toMatchObject({
      op: 'remove',
    });
  });

  it('share grant fans out to the sharee; a sharee edit reaches both feeds', async () => {
    const sharee = await ctx.registerUser();
    const note = await user.notes.create({ title: 'shared' });

    await user.shares.grant(note.id, sharee.id, 'editor');

    const shareeRows = await changeLog(sharee.id);
    expect(shareeRows.map((r) => r.entityType).sort()).toEqual([
      'attachments',
      'note',
    ]);

    await sharee.notes.update(note.id, { title: 'sharee edit' });

    const ownerNoteRow = (await changeLog(user.id)).find(
      (r) => r.entityType === 'note',
    )!;
    const shareeNoteRow = (await changeLog(sharee.id)).find(
      (r) => r.entityType === 'note',
    )!;
    // Both rows re-stamped past their initial seqs by the sharee's edit.
    expect(ownerNoteRow.seq).toBeGreaterThan(1n);
    expect(shareeNoteRow.seq).toBeGreaterThan(shareeRows[0].seq);
    expect(await noteVersion(note.id)).toBe(2);
  });

  it('revoke flips the sharee row to remove and drops their pin/attachments rows', async () => {
    const sharee = await ctx.registerUser();
    const note = await user.notes.create({ title: 'revocable' });
    const share = await user.shares.grant(note.id, sharee.id, 'viewer');

    // Sharee pins the note so a pin index row exists to clean up.
    await ctx.prisma.notePin.create({
      data: { userId: sharee.id, noteId: note.id },
    });
    await ctx.prisma.changeLog.create({
      data: {
        recipientUserId: sharee.id,
        entityType: 'pin',
        entityId: note.id,
        op: 'upsert',
        seq: 999n,
      },
    });

    await user.shares.revoke(note.id, share.id);

    const shareeRows = await changeLog(sharee.id);
    expect(shareeRows).toEqual([
      expect.objectContaining({ entityType: 'note', op: 'remove' }),
    ]);
  });

  it('trash stays an upsert; permanent delete becomes a remove for everyone', async () => {
    const sharee = await ctx.registerUser();
    const note = await user.notes.create({ title: 'doomed' });
    await user.shares.grant(note.id, sharee.id, 'viewer');

    await user.notes.trash(note.id);
    expect(
      (await changeLog(user.id)).find((r) => r.entityType === 'note')!.op,
    ).toBe('upsert');

    await user.notes.purge(note.id);
    for (const recipient of [user.id, sharee.id]) {
      expect(
        (await changeLog(recipient)).find((r) => r.entityType === 'note')!.op,
      ).toBe('remove');
    }
  });

  it('tag lifecycle: create/rename upsert with version bumps, delete removes', async () => {
    const tag = await user.tags.create({ name: 'work' });

    await user.tags.update(tag.id, { name: 'renamed' });

    let row = (await changeLog(user.id)).find((r) => r.entityType === 'tag')!;
    expect(row).toMatchObject({ entityId: tag.id, op: 'upsert', seq: 2n });
    expect(
      (await ctx.prisma.tag.findUniqueOrThrow({ where: { id: tag.id } }))
        .version,
    ).toBe(2);

    await user.tags.remove(tag.id);
    row = (await changeLog(user.id)).find((r) => r.entityType === 'tag')!;
    expect(row.op).toBe('remove');
    expect(row.seq).toBe(3n);
  });

  it('an applied push bumps version, writes a revision, and re-stamps the feed', async () => {
    const note = await user.notes.create({ title: 'server copy' });

    await user.sync.push([
      {
        type: 'note',
        id: note.id,
        title: 'pushed from device',
        baseVersion: 1,
      },
    ]);

    expect(await noteVersion(note.id)).toBe(2);
    expect(
      await ctx.prisma.noteRevision.findFirst({ where: { noteId: note.id } }),
    ).toMatchObject({ title: 'server copy', cause: 'edit' });
    const rows = await changeLog(user.id);
    expect(rows.find((r) => r.entityType === 'note')!.seq).toBe(2n);
  });

  it('attachment upload emits an attachments upsert without touching version', async () => {
    const note = await user.notes.create({ title: 'with file' });

    await user.attachments.upload(note.id, 'a.png');

    const rows = await changeLog(user.id);
    expect(rows.find((r) => r.entityType === 'attachments')).toMatchObject({
      entityId: note.id,
      op: 'upsert',
    });
    expect(await noteVersion(note.id)).toBe(1);
  });

  it('import emits one contiguous block covering notes, pins, and created tags', async () => {
    await user.notes.import({
      notes: [
        { ref: 'r1', title: 'a', isPinned: true, tagNames: ['imported'] },
        { ref: 'r2', title: 'b' },
      ],
    });

    const rows = await changeLog(user.id);
    const byType = (type: string) =>
      rows.filter((r) => r.entityType === type).length;
    expect(byType('note')).toBe(2);
    expect(byType('pin')).toBe(1);
    expect(byType('tag')).toBe(1);
    // Contiguous seqs from one next_sync_seq block.
    expect(rows.map((r) => r.seq)).toEqual([1n, 2n, 3n, 4n]);
  });

  describe('prune', () => {
    let maintenance: SyncMaintenanceService;

    beforeAll(() => {
      maintenance = ctx.get(SyncMaintenanceService);
    });

    async function ageChangeLog(days: number) {
      await ctx.prisma.$executeRaw`
        UPDATE "ChangeLog" SET "updatedAt" = "updatedAt" - make_interval(days => ${days}::int)`;
    }

    async function syncState(userId: string) {
      return ctx.prisma.syncState.findUniqueOrThrow({ where: { userId } });
    }

    async function makeRemoveRow(actor: Actor = user): Promise<string> {
      const note = await actor.notes.create({ title: 'doomed' });
      await actor.notes.purge(note.id);
      return note.id;
    }

    it('drops aged remove rows and advances prunedThroughSeq past them', async () => {
      const noteId = await makeRemoveRow();
      const removeSeq = (await changeLog(user.id)).find(
        (r) => r.entityId === noteId,
      )!.seq;
      await ageChangeLog(120);

      expect(await maintenance.pruneChangeLog()).toEqual({
        prunedChangeLogCount: 1,
      });
      expect(await changeLog(user.id)).toEqual([]);
      expect((await syncState(user.id)).prunedThroughSeq).toBe(removeSeq);
    });

    it('keeps upsert rows and remove rows inside the retention window', async () => {
      await user.notes.create({ title: 'kept' });
      await makeRemoveRow();
      await ageChangeLog(30);

      expect(await maintenance.pruneChangeLog()).toEqual({
        prunedChangeLogCount: 0,
      });
      expect(await changeLog(user.id)).toHaveLength(2);
      expect((await syncState(user.id)).prunedThroughSeq).toBe(0n);
    });

    it('prunes each recipient against their own seq space', async () => {
      const other = await ctx.registerUser();
      await makeRemoveRow();
      await makeRemoveRow(other);
      await ageChangeLog(120);

      expect(await maintenance.pruneChangeLog()).toEqual({
        prunedChangeLogCount: 2,
      });
      for (const recipient of [user.id, other.id]) {
        expect(await changeLog(recipient)).toEqual([]);
        expect((await syncState(recipient)).prunedThroughSeq).toBe(2n);
      }
    });
  });
});
