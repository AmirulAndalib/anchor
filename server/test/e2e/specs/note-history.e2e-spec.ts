import { Actor, createE2EApp, E2EApp, entriesOf } from '../support';

describe('note history', () => {
  let ctx: E2EApp;
  let owner: Actor;

  beforeAll(async () => {
    ctx = await createE2EApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    owner = await ctx.registerUser('Owner');
  });

  // Each edit by the same author collapses into the newest revision for ten
  // minutes, so the writes are spread out to leave a trail.
  const editTrail = async (noteId: string, contents: string[]) => {
    for (const content of contents) {
      await owner.notes.update(noteId, { content });
      await ctx.ageNoteRevisions(noteId);
    }
  };

  describe('listing', () => {
    it('keeps what each edit replaced, newest first', async () => {
      const note = await owner.notes.create({
        title: 'groceries',
        content: 'milk',
      });
      await editTrail(note.id, ['milk, eggs', 'milk, eggs, bread']);

      const { revisions, nextCursor } = await owner.revisions.list(note.id);

      expect(revisions.map((r) => r.title)).toEqual(['groceries', 'groceries']);
      expect(revisions.map((r) => r.version)).toEqual([2, 1]);
      expect(revisions.every((r) => r.cause === 'edit')).toBe(true);
      expect(nextCursor).toBeNull();
    });

    it('leaves the content out of the list', async () => {
      const note = await owner.notes.create({ content: 'milk' });
      await editTrail(note.id, ['milk, eggs']);

      const { revisions } = await owner.revisions.list(note.id);

      expect(revisions[0]).not.toHaveProperty('content');
      expect(revisions[0].author).toMatchObject({ name: 'Owner' });
    });

    it('hands over the content when a client asks to keep the page', async () => {
      const note = await owner.notes.create({ content: 'milk' });
      await editTrail(note.id, ['milk, eggs']);

      const { revisions } = await owner.revisions.list(
        note.id,
        '?withContent=true',
      );

      expect(revisions[0].content).toBe('milk');
    });

    it('pages through a long history with the cursor', async () => {
      const note = await owner.notes.create({ content: 'a' });
      await editTrail(note.id, ['b', 'c', 'd']);

      const first = await owner.revisions.list(note.id, '?limit=2');
      expect(first.revisions).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();

      const second = await owner.revisions.list(
        note.id,
        `?limit=2&cursor=${first.nextCursor!}`,
      );
      expect(second.revisions).toHaveLength(1);
      expect(second.nextCursor).toBeNull();

      const ids = [...first.revisions, ...second.revisions].map((r) => r.id);
      expect(new Set(ids).size).toBe(3);
    });

    it('rejects a page size beyond the cap', async () => {
      const note = await owner.notes.create({});

      await owner.http
        .get(`/api/notes/${note.id}/revisions?limit=500`)
        .expect(400);
    });

    it('shows a rejected edit alongside the accepted ones', async () => {
      const note = await owner.notes.create({ content: 'milk' });
      await editTrail(note.id, ['milk, eggs']);

      await owner.http
        .patch(`/api/notes/${note.id}`)
        .send({ content: 'milk, bread', baseVersion: 1 })
        .expect(409);

      const { revisions } = await owner.revisions.list(note.id);
      expect(revisions.map((r) => r.cause)).toEqual(['conflict', 'edit']);
      expect(
        await owner.revisions.read(note.id, revisions[0].id),
      ).toMatchObject({ content: 'milk, bread' });
    });

    it('is readable by an editor, but not by a viewer', async () => {
      const editor = await ctx.registerUser('Editor');
      const viewer = await ctx.registerUser('Viewer');
      const stranger = await ctx.registerUser('Stranger');
      const note = await owner.notes.create({ content: 'milk' });
      await editTrail(note.id, ['milk, eggs']);
      await owner.shares.grant(note.id, editor.id, 'editor');
      await owner.shares.grant(note.id, viewer.id, 'viewer');

      expect((await editor.revisions.list(note.id)).revisions).toHaveLength(1);
      await viewer.http.get(`/api/notes/${note.id}/revisions`).expect(403);
      await stranger.http.get(`/api/notes/${note.id}/revisions`).expect(404);
    });

    it('is gone once the note is permanently deleted', async () => {
      const note = await owner.notes.create({ content: 'milk' });
      await editTrail(note.id, ['milk, eggs']);
      await owner.notes.trash(note.id);
      await owner.notes.purge(note.id);

      await owner.http.get(`/api/notes/${note.id}/revisions`).expect(404);
    });
  });

  describe('reading one revision', () => {
    it('carries the content it holds', async () => {
      const note = await owner.notes.create({
        title: 'groceries',
        content: 'milk',
      });
      await editTrail(note.id, ['milk, eggs']);

      const { revisions } = await owner.revisions.list(note.id);
      expect(
        await owner.revisions.read(note.id, revisions[0].id),
      ).toMatchObject({
        noteId: note.id,
        title: 'groceries',
        content: 'milk',
        cause: 'edit',
      });
    });

    it('will not read a revision belonging to another note', async () => {
      const note = await owner.notes.create({ content: 'milk' });
      const other = await owner.notes.create({ content: 'other' });
      await editTrail(note.id, ['milk, eggs']);
      const { revisions } = await owner.revisions.list(note.id);

      await owner.http
        .get(`/api/notes/${other.id}/revisions/${revisions[0].id}`)
        .expect(404);
    });
  });

  describe('restoring', () => {
    it('puts the old content back and keeps the content it replaced', async () => {
      const note = await owner.notes.create({
        title: 'groceries',
        content: 'milk',
      });
      await editTrail(note.id, ['milk, eggs']);
      const { revisions } = await owner.revisions.list(note.id);

      const restored = await owner.revisions.restore(note.id, revisions[0].id);

      expect(restored).toMatchObject({ content: 'milk', version: 3 });
      expect(await owner.notes.read(note.id)).toMatchObject({
        content: 'milk',
      });

      const after = await owner.revisions.list(note.id);
      expect(after.revisions[0]).toMatchObject({
        cause: 'restore',
        version: 2,
      });
      expect(
        await owner.revisions.read(note.id, after.revisions[0].id),
      ).toMatchObject({ content: 'milk, eggs' });
    });

    it('sends the restored note to every device it belongs to', async () => {
      const editor = await ctx.registerUser('Editor');
      const note = await owner.notes.create({ content: 'milk' });
      await owner.shares.grant(note.id, editor.id, 'editor');
      await editTrail(note.id, ['milk, eggs']);
      const { revisions } = await owner.revisions.list(note.id);
      const { cursor } = await editor.sync.drain();

      await owner.revisions.restore(note.id, revisions[0].id);

      const { entries } = await editor.sync.drain({ cursor });
      expect(entriesOf(entries, 'note')[0].note).toMatchObject({
        id: note.id,
        content: 'milk',
      });
    });

    it('recovers the content a conflict rejected', async () => {
      const editor = await ctx.registerUser('Editor');
      const note = await owner.notes.create({ content: 'milk' });
      await owner.shares.grant(note.id, editor.id, 'editor');
      await owner.notes.update(note.id, {
        content: 'milk, eggs',
        baseVersion: 1,
      });

      await editor.http
        .patch(`/api/notes/${note.id}`)
        .send({ content: 'milk, bread', baseVersion: 1 })
        .expect(409);

      const { revisions } = await owner.revisions.list(note.id);
      const lost = revisions.find((r) => r.cause === 'conflict')!;
      expect(lost.author).toMatchObject({ name: 'Editor' });

      const restored = await editor.revisions.restore(note.id, lost.id);
      expect(restored).toMatchObject({ content: 'milk, bread' });
    });

    it('changes nothing when the note already says that', async () => {
      const note = await owner.notes.create({ content: 'milk' });
      await editTrail(note.id, ['milk, eggs']);
      const { revisions } = await owner.revisions.list(note.id);
      await owner.revisions.restore(note.id, revisions[0].id);

      const again = await owner.revisions.restore(note.id, revisions[0].id);

      expect(again).toMatchObject({ content: 'milk', version: 3 });
      expect((await owner.revisions.list(note.id)).revisions).toHaveLength(2);
    });

    it('is refused to a viewer', async () => {
      const viewer = await ctx.registerUser('Viewer');
      const note = await owner.notes.create({ content: 'milk' });
      await editTrail(note.id, ['milk, eggs']);
      await owner.shares.grant(note.id, viewer.id, 'viewer');
      const { revisions } = await owner.revisions.list(note.id);

      await viewer.http
        .post(`/api/notes/${note.id}/revisions/${revisions[0].id}/restore`)
        .expect(403);
    });

    it('is refused on a note sitting in the trash', async () => {
      const note = await owner.notes.create({ content: 'milk' });
      await editTrail(note.id, ['milk, eggs']);
      const { revisions } = await owner.revisions.list(note.id);
      await owner.notes.trash(note.id);

      await owner.http
        .post(`/api/notes/${note.id}/revisions/${revisions[0].id}/restore`)
        .expect(400);
    });
  });

  // A device that edits offline keeps its own trail and sends it up with the
  // note, so the history holds every step and not just the last one.
  describe('versions recorded on a device', () => {
    const recorded = (
      id: string,
      content: string,
      at: string,
      cause: 'edit' | 'restore' = 'edit',
    ) => ({
      id,
      version: 1,
      title: 'groceries',
      content,
      cause,
      createdAt: at,
    });

    const push = (
      noteId: string,
      baseVersion: number,
      content: string,
      revisions: ReturnType<typeof recorded>[],
    ) =>
      owner.sync.push([
        {
          type: 'note',
          id: noteId,
          baseVersion,
          title: 'groceries',
          content,
          revisions,
        },
      ]);

    it('keeps every step the device took, not just the one the server saw', async () => {
      const note = await owner.notes.create({
        title: 'groceries',
        content: 'milk',
      });

      const result = await push(note.id, 1, 'milk, eggs, bread', [
        recorded('rev-1', 'milk', '2026-08-01T10:00:00.000Z'),
        recorded('rev-2', 'milk, eggs', '2026-08-01T10:30:00.000Z'),
      ]);
      expect(result.results[0]).toMatchObject({ status: 'applied' });

      const { revisions } = await owner.revisions.list(
        note.id,
        '?withContent=true',
      );
      expect(revisions.map((r) => r.id)).toEqual(['rev-2', 'rev-1']);
      expect(revisions.map((r) => r.content)).toEqual(['milk, eggs', 'milk']);
      expect(revisions[0].author).toMatchObject({ name: 'Owner' });
    });

    it('lands a version once, however often the device re-sends it', async () => {
      const note = await owner.notes.create({
        title: 'groceries',
        content: 'milk',
      });

      await push(note.id, 1, 'milk, eggs', [
        recorded('rev-1', 'milk', '2026-08-01T10:00:00.000Z'),
      ]);
      await push(note.id, 2, 'milk, eggs, bread', [
        recorded('rev-1', 'milk', '2026-08-01T10:00:00.000Z'),
        recorded('rev-2', 'milk, eggs', '2026-08-01T10:30:00.000Z'),
      ]);

      const { revisions } = await owner.revisions.list(note.id);
      expect(revisions.map((r) => r.id)).toEqual(['rev-2', 'rev-1']);
    });

    it('a push carrying only versions lands them, even against a moved note', async () => {
      const note = await owner.notes.create({
        title: 'groceries',
        content: 'milk',
      });
      // Another device moved the note on; this one only has history to bring.
      await owner.notes.update(note.id, { content: 'milk, eggs' });

      const result = await owner.sync.push([
        {
          type: 'note',
          id: note.id,
          baseVersion: 1,
          title: 'groceries',
          content: 'milk',
          revisionsOnly: true,
          revisions: [recorded('rev-1', 'milk', '2026-08-01T10:00:00.000Z')],
        },
      ]);

      expect(result.results[0]).toMatchObject({
        status: 'applied',
        version: 2,
      });
      const { revisions } = await owner.revisions.list(note.id);
      expect(revisions.map((r) => r.id)).toContain('rev-1');
      expect(revisions.map((r) => r.cause)).not.toContain('conflict');
      expect(
        (await ctx.prisma.note.findUniqueOrThrow({ where: { id: note.id } }))
          .content,
      ).toBe('milk, eggs');
    });

    it('an ack for a push that already landed keeps the versions it carried', async () => {
      const note = await owner.notes.create({
        title: 'groceries',
        content: 'milk',
      });
      await owner.notes.update(note.id, { content: 'milk, eggs' });

      const result = await push(note.id, 1, 'milk, eggs', [
        recorded('rev-1', 'milk', '2026-08-01T10:00:00.000Z'),
      ]);

      expect(result.results[0]).toMatchObject({
        status: 'applied',
        version: 2,
      });
      const { revisions } = await owner.revisions.list(note.id);
      expect(revisions.map((r) => r.id)).toContain('rev-1');
    });

    it('holds back the versions of a rejected push', async () => {
      const note = await owner.notes.create({
        title: 'groceries',
        content: 'milk',
      });

      const result = await push(note.id, 7, 'milk, eggs', [
        recorded('rev-1', 'milk', '2026-08-01T10:00:00.000Z'),
      ]);

      expect(result.results[0].status).toBe('conflict');
      const { revisions } = await owner.revisions.list(note.id);
      expect(revisions.map((r) => r.cause)).toEqual(['conflict']);
    });

    it('keeps the copy a winning rebase overwrote', async () => {
      const note = await owner.notes.create({
        title: 'groceries',
        content: 'milk',
      });
      // Another device moved the note on while this one held its edit.
      await owner.notes.update(note.id, { content: 'milk, eggs' });

      const trail = [recorded('rev-1', 'milk', '2026-08-01T10:00:00.000Z')];
      const rejected = await push(note.id, 1, 'milk, bread', trail);
      expect(rejected.results[0].status).toBe('conflict');

      const rebased = await push(note.id, 2, 'milk, bread', trail);
      expect(rebased.results[0].status).toBe('applied');

      const { revisions } = await owner.revisions.list(
        note.id,
        '?withContent=true',
      );
      const overwritten = revisions.find((r) => r.content === 'milk, eggs');
      expect(overwritten).toMatchObject({ cause: 'edit' });
      expect(
        (await ctx.prisma.note.findUniqueOrThrow({ where: { id: note.id } }))
          .content,
      ).toBe('milk, bread');
    });

    it('refuses more versions than one push may carry', async () => {
      const note = await owner.notes.create({ title: 'groceries' });

      await owner.http
        .post('/api/sync')
        .send({
          changes: [
            {
              type: 'note',
              id: note.id,
              baseVersion: 1,
              title: 'groceries',
              revisions: Array.from({ length: 21 }, (_, i) =>
                recorded(`rev-${i}`, 'milk', '2026-08-01T10:00:00.000Z'),
              ),
            },
          ],
        })
        .expect(400);
    });
  });
});
