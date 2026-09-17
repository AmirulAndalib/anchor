import { Actor, createE2EApp, E2EApp, entryFor } from '../support';

/**
 * The note lifecycle over the REST API: what each state transition does to the
 * listings, to the row, and to the feed.
 */
describe('notes', () => {
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

  it('trash and restore round-trip through listings', async () => {
    const note = await user.notes.create({ title: 'trash me' });
    await user.notes.trash(note.id);

    expect((await user.notes.listTrashed()).map((n) => n.id)).toEqual([
      note.id,
    ]);
    expect(await user.notes.list()).toEqual([]);

    await user.notes.restore(note.id);
    const row = await ctx.prisma.note.findUnique({ where: { id: note.id } });
    expect(row!.state).toBe('active');

    await user.http.patch(`/api/notes/${note.id}/restore`).expect(404);
  });

  it('permanent delete hides the note from reads and removes it from the feed', async () => {
    const note = await user.notes.create({ title: 'tombstone' });
    const { cursor } = await user.sync.drain();

    await user.notes.purge(note.id);

    await user.http.get(`/api/notes/${note.id}`).expect(404);

    const { entries } = await user.sync.drain({ cursor });
    expect(entryFor(entries, 'note', note.id)).toMatchObject({ op: 'remove' });
  });

  it('a tombstone stays gone across every write path', async () => {
    const note = await user.notes.create({ title: 'tombstone' });
    await user.notes.purge(note.id);

    await user.http
      .patch(`/api/notes/${note.id}`)
      .send({ title: 'back from the dead' })
      .expect(404);
    await user.http.delete(`/api/notes/${note.id}`).expect(404);
    await user.http
      .post('/api/notes/bulk/delete')
      .send({ noteIds: [note.id] })
      .expect(404);

    expect(
      await ctx.prisma.note.findUniqueOrThrow({ where: { id: note.id } }),
    ).toMatchObject({ state: 'deleted', title: 'tombstone' });
  });

  it('state transitions stamp stateChangedAt; other edits leave it alone', async () => {
    const note = await user.notes.create({ title: 'clock' });
    const created = await ctx.prisma.note.findUniqueOrThrow({
      where: { id: note.id },
    });

    await user.notes.update(note.id, { title: 'edited' });
    const edited = await ctx.prisma.note.findUniqueOrThrow({
      where: { id: note.id },
    });
    expect(edited.stateChangedAt).toEqual(created.stateChangedAt);

    await user.notes.trash(note.id);
    const trashed = await ctx.prisma.note.findUniqueOrThrow({
      where: { id: note.id },
    });
    expect(trashed.stateChangedAt.getTime()).toBeGreaterThan(
      created.stateChangedAt.getTime(),
    );
  });

  it('pins are per-user on shared notes', async () => {
    const sharee = await ctx.registerUser();
    const note = await user.notes.create({ title: 'shared pin' });
    await user.shares.grant(note.id, sharee.id, 'viewer');
    await sharee.notes.bulkPin([note.id], true);

    const shareeView = await sharee.sync.drain();
    expect(entryFor(shareeView.entries, 'note', note.id).note!.isPinned).toBe(
      true,
    );

    const ownerView = await user.sync.drain();
    expect(entryFor(ownerView.entries, 'note', note.id).note!.isPinned).toBe(
      false,
    );
  });

  it('bulk trash propagates through the delta feed', async () => {
    const note = await user.notes.create({ title: 'bulk trashed' });
    const { cursor } = await user.sync.drain();

    await user.notes.bulkTrash([note.id]);

    const { entries } = await user.sync.drain({ cursor });
    expect(entryFor(entries, 'note', note.id).note).toMatchObject({
      state: 'trashed',
    });
  });

  it('notes trashed together come back in a stable order', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      ids.push((await user.notes.create({ title: `note ${i}` })).id);
    }

    await user.notes.bulkTrash(ids);

    const stamps = await ctx.prisma.note.findMany({
      where: { id: { in: ids } },
      select: { updatedAt: true },
    });
    expect(new Set(stamps.map((n) => n.updatedAt.getTime())).size).toBe(1);

    const trashOrder = async () =>
      (await user.notes.listTrashed()).map((n) => n.id);

    const expected = [...ids].sort().reverse();
    expect(await trashOrder()).toEqual(expected);
    expect(await trashOrder()).toEqual(expected);
  });

  it('notes archived together come back in a stable order', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      ids.push((await user.notes.create({ title: `note ${i}` })).id);
    }

    await user.notes.bulkArchive(ids);

    expect((await user.notes.listArchived()).map((n) => n.id)).toEqual(
      [...ids].sort().reverse(),
    );
  });
});
