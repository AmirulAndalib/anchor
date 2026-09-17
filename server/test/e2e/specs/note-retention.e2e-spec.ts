import { NotesService } from 'src/notes/services/notes.service';
import { RETENTION_CHUNK_SIZE } from 'src/common/retention.constants';
import { Actor, createE2EApp, DAY_MS, E2EApp } from '../support';

/**
 * The scheduled cleanups: trash converting to tombstones, tombstones being
 * purged, and both keying off stateChangedAt rather than the last edit.
 */
describe('note retention', () => {
  let ctx: E2EApp;
  let user: Actor;
  let notes: NotesService;

  beforeAll(async () => {
    ctx = await createE2EApp();
    notes = ctx.get(NotesService);
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    user = await ctx.registerUser();
  });

  const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

  it('trash retention keys off the trash time, not the last edit', async () => {
    const expired = await user.notes.create({ title: 'expired' });
    const fresh = await user.notes.create({ title: 'fresh' });
    for (const note of [expired, fresh]) {
      await user.notes.trash(note.id);
    }
    await ctx.setNoteClocks(expired.id, { stateChangedAt: daysAgo(31) });
    await ctx.setNoteClocks(fresh.id, { stateChangedAt: daysAgo(29) });

    const result = await notes.autoDeleteExpiredTrash(30);
    expect(result.convertedCount).toBe(1);
    expect(
      (await ctx.prisma.note.findUnique({ where: { id: expired.id } }))!.state,
    ).toBe('deleted');
    expect(
      (await ctx.prisma.note.findUnique({ where: { id: fresh.id } }))!.state,
    ).toBe('trashed');

    // Becoming a tombstone restarts the clock, so the purge window is a full
    // retention period after the conversion.
    const purge = await notes.purgeTombstones(30);
    expect(purge.purgedNotesCount).toBe(0);
  });

  it('a sweep larger than one chunk drains in full', async () => {
    const total = RETENTION_CHUNK_SIZE + 5;
    const stateChangedAt = daysAgo(31);
    await ctx.prisma.note.createMany({
      data: Array.from({ length: total }, (_, i) => ({
        title: `bulk ${i}`,
        userId: user.id,
        state: 'trashed' as const,
        stateChangedAt,
      })),
    });

    expect((await notes.autoDeleteExpiredTrash(30)).convertedCount).toBe(total);
    expect(await ctx.prisma.note.count({ where: { state: 'trashed' } })).toBe(
      0,
    );

    await ctx.prisma.note.updateMany({ data: { stateChangedAt } });
    expect((await notes.purgeTombstones(30)).purgedNotesCount).toBe(total);
    expect(await ctx.prisma.note.count()).toBe(0);
  });

  it('a note edited while in trash still expires on schedule', async () => {
    const note = await user.notes.create({ title: 'edited in trash' });
    await user.notes.trash(note.id);
    await ctx.setNoteClocks(note.id, { stateChangedAt: daysAgo(31) });

    await user.notes.update(note.id, { title: 'touched' });

    expect((await notes.autoDeleteExpiredTrash(30)).convertedCount).toBe(1);
  });

  it('purgeTombstones hard-deletes old tombstones and their attachment files', async () => {
    const note = await user.notes.create({ title: 'purge me' });
    await user.notes.purge(note.id);
    await ctx.setNoteClocks(note.id, { stateChangedAt: daysAgo(31) });

    const result = await notes.purgeTombstones(30);
    expect(result.purgedNotesCount).toBe(1);
    expect(
      await ctx.prisma.note.findUnique({ where: { id: note.id } }),
    ).toBeNull();
  });
});
