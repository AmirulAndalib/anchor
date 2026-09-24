import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NotesService } from 'src/notes/services/notes.service';
import { Actor, createE2EApp, DAY_MS, E2EApp, entryFor } from '../support';

/**
 * Importing notes from another install: id remapping, the clocks it may
 * backdate, and how imported rows reach the feed.
 */
describe('note import', () => {
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

  it('preserves backdated updatedAt (second precision) and is immediately syncable', async () => {
    const { cursor } = await user.sync.drain();
    const backdated = '2024-03-05T10:20:30.456Z';

    const { results } = await user.notes.import({
      notes: [
        {
          ref: 'n1',
          title: 'imported',
          content: JSON.stringify({ ops: [{ insert: 'hello\n' }] }),
          updatedAt: backdated,
        },
      ],
    });

    const [result] = results;
    expect(result).toMatchObject({ ref: 'n1', status: 'created' });

    const row = await ctx.prisma.note.findUnique({
      where: { id: result.noteId! },
    });
    // Sub-second precision is deliberately truncated on import.
    expect(row!.updatedAt.toISOString()).toBe('2024-03-05T10:20:30.000Z');

    const { entries } = await user.sync.drain({ cursor });
    const entry = entryFor(entries, 'note', result.noteId!);
    expect(entry.note!.title).toBe('imported');
    expect(entry.note!.updatedAt).toBe('2024-03-05T10:20:30.000Z');
  });

  it('gives an imported trashed note a full retention window', async () => {
    const { results } = await user.notes.import({
      notes: [
        {
          ref: 'old',
          title: 'trashed long ago',
          isTrashed: true,
          updatedAt: new Date(Date.now() - 400 * DAY_MS).toISOString(),
        },
      ],
    });

    const [result] = results;
    expect(result.status).toBe('created');
    expect(
      (await ctx.get(NotesService).autoDeleteExpiredTrash(30)).convertedCount,
    ).toBe(0);
    expect(
      (await ctx.prisma.note.findUnique({ where: { id: result.noteId! } }))!
        .state,
    ).toBe('trashed');
  });

  it('skipExisting skips own live notes and remaps foreign ids', async () => {
    const existing = await user.notes.create({ title: 'already here' });
    const other = await ctx.registerUser();
    const foreign = await other.notes.create({ title: 'foreign' });

    const { results } = await user.notes.import({
      skipExisting: true,
      notes: [
        { ref: 'own', id: existing.id, title: 'dup of mine' },
        { ref: 'foreign', id: foreign.id, title: 'dup of theirs' },
      ],
    });

    expect(results.find((r) => r.ref === 'own')).toMatchObject({
      status: 'skipped',
    });
    const remapped = results.find((r) => r.ref === 'foreign')!;
    expect(remapped.status).toBe('remapped');
    expect(remapped.noteId).not.toBe(foreign.id);
  });

  it('drops non-delta content with a warning', async () => {
    const { results } = await user.notes.import({
      notes: [{ ref: 'bad', title: 'plain text', content: 'not a delta' }],
    });

    const [result] = results;
    expect(result.status).toBe('created');
    expect(result.warning).toBeDefined();
    const row = await ctx.prisma.note.findUnique({
      where: { id: result.noteId! },
    });
    expect(row!.content).toBeNull();
  });
});
