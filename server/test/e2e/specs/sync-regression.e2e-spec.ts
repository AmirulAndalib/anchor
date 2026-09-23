import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  Actor,
  bodyOf,
  createE2EApp,
  E2EApp,
  entriesOf,
  idsOf,
} from '../support';
import type { SyncResponse } from '../support/wire';

/**
 * The sync failures users reported against the old protocol, replayed as whole
 * journeys.
 */
describe('sync regressions', () => {
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

  afterEach(() => {
    ctx.closeEventStreams();
  });

  const hoursFromNow = (hours: number) =>
    new Date(Date.now() + hours * 3_600_000);

  // Edits made on a phone whose clock disagreed with the server were dropped
  // and then overwritten: github.com/ZhFahim/anchor/issues/125
  describe('edits from a device whose clock is off', () => {
    it('applies an edit from a device an hour out of step with the server', async () => {
      const note = await user.notes.create({
        title: 'shopping',
        content: 'a',
      });
      const { cursor } = await user.sync.drain();

      // The device is an hour behind, so its copy looks older than the server's.
      await ctx.setNoteClocks(note.id, { updatedAt: hoursFromNow(1) });

      const pushed = await user.sync.push(
        [
          {
            type: 'note',
            id: note.id,
            baseVersion: 1,
            title: 'shopping',
            content: 'a b',
          },
        ],
        { cursor },
      );
      expect(pushed.results).toEqual([
        { type: 'note', id: note.id, status: 'applied', version: 2 },
      ]);
      expect(await user.notes.read(note.id)).toMatchObject({ content: 'a b' });
      expect(entriesOf(pushed.entries, 'note')[0].note).toMatchObject({
        id: note.id,
        content: 'a b',
        version: 2,
      });

      const next = await user.sync.drain({ cursor: pushed.nextCursor! });
      expect(entriesOf(next.entries, 'note')).toEqual([]);
      expect(await user.notes.read(note.id)).toMatchObject({ content: 'a b' });
    });

    it('has nowhere for a device clock to enter the protocol', async () => {
      const note = await user.notes.create({ title: 'shopping' });
      const backdated = hoursFromNow(-48).toISOString();

      await user.http
        .post('/api/sync')
        .send({
          changes: [
            {
              type: 'note',
              id: note.id,
              baseVersion: 1,
              title: 'shopping',
              updatedAt: backdated,
            },
          ],
        })
        .expect(200);

      expect((await user.notes.read(note.id)).updatedAt).not.toBe(backdated);

      // Nor can it filter the feed.
      const res = await user.http
        .post('/api/sync')
        .send({ lastSyncedAt: backdated })
        .expect(200);
      const feed = bodyOf<SyncResponse>(res);
      expect(idsOf(entriesOf(feed.entries, 'note'))).toContain(note.id);
    });

    it('hands a rejected edit back to be re-sent instead of dropping it', async () => {
      const note = await user.notes.create({
        title: 'shopping',
        content: 'a',
      });

      // Another device got there first, so this one is pushing against v1.
      await user.notes.update(note.id, { content: 'a b', baseVersion: 1 });

      const rejected = await user.sync.push([
        {
          type: 'note',
          id: note.id,
          baseVersion: 1,
          title: 'shopping',
          content: 'a c',
        },
      ]);
      expect(rejected.results[0]).toMatchObject({
        status: 'conflict',
        serverCopy: { version: 2, content: 'a b' },
      });

      const rebased = await user.sync.push([
        {
          type: 'note',
          id: note.id,
          baseVersion: 2,
          title: 'shopping',
          content: 'a c',
        },
      ]);
      expect(rebased.results[0]).toMatchObject({
        status: 'applied',
        version: 3,
      });
      expect(await user.notes.read(note.id)).toMatchObject({ content: 'a c' });

      expect(
        await ctx.prisma.noteRevision.findFirst({
          where: { noteId: note.id, cause: 'conflict' },
        }),
      ).toMatchObject({ content: 'a c', version: 1 });
    });
  });

  // Notes written in the browser reached the app hours late, or never:
  // github.com/ZhFahim/anchor/issues/138
  describe('server-side writes reaching a device', () => {
    it('gives a fresh install everything the browser wrote before it existed', async () => {
      const written = [
        await user.notes.create({ title: 'from browser 1', content: 'one' }),
        await user.notes.create({ title: 'from browser 2', content: 'two' }),
        await user.notes.create({ title: 'from browser 3', content: 'three' }),
      ];

      const { entries } = await user.sync.drain();

      const notes = entriesOf(entries, 'note');
      expect(idsOf(notes).sort()).toEqual(written.map((n) => n.id).sort());
      expect(notes.map((entry) => entry.note?.content).sort()).toEqual([
        'one',
        'three',
        'two',
      ]);
    });

    it('delivers a note stamped in the future without waiting for it', async () => {
      const { cursor } = await user.sync.drain();
      const note = await user.notes.create({ title: 'written in browser' });
      // What a server running east of UTC used to stamp on every note.
      await ctx.setNoteClocks(note.id, { updatedAt: hoursFromNow(6) });

      const delta = await user.sync.drain({ cursor });
      expect(idsOf(entriesOf(delta.entries, 'note'))).toEqual([note.id]);

      const snapshot = await user.sync.drain();
      expect(idsOf(entriesOf(snapshot.entries, 'note'))).toEqual([note.id]);
    });

    it('carries later browser writes down to a device that already synced', async () => {
      const existing = await user.notes.create({ title: 'already known' });
      const { cursor } = await user.sync.drain();

      const created = await user.notes.create({ title: 'written in browser' });
      await user.notes.update(existing.id, {
        content: 'edited in browser',
        baseVersion: 1,
      });

      const { entries } = await user.sync.drain({ cursor });
      const byId = new Map(
        entriesOf(entries, 'note').map((entry) => [entry.entityId, entry.note]),
      );
      expect(byId.get(created.id)).toMatchObject({
        title: 'written in browser',
      });
      expect(byId.get(existing.id)).toMatchObject({
        content: 'edited in browser',
      });
    });

    it('tells a listening device about a browser note right away', async () => {
      const stream = await user.openEventStream();
      expect(stream.status).toBe(200);

      await user.notes.create({ title: 'written in browser' });

      await stream.waitFor('event: sync');
    });
  });

  // A shared note edited from the browser reported "saved" and then lost the
  // edit: github.com/ZhFahim/anchor/issues/143
  describe('edits to a shared note', () => {
    let owner: Actor;
    let editor: Actor;
    let noteId: string;

    beforeEach(async () => {
      owner = user;
      editor = await ctx.registerUser();
      const note = await owner.notes.create({
        title: 'groceries',
        content: 'milk',
      });
      noteId = note.id;
      await owner.shares.grant(noteId, editor.id, 'editor');
    });

    it("keeps the editor's save and shows it to both of them", async () => {
      await editor.notes.update(noteId, {
        content: 'milk, eggs',
        baseVersion: 1,
      });

      expect(await editor.notes.read(noteId)).toMatchObject({
        content: 'milk, eggs',
      });
      expect(await owner.notes.read(noteId)).toMatchObject({
        content: 'milk, eggs',
      });

      const { entries } = await owner.sync.drain();
      expect(entriesOf(entries, 'note')[0].note).toMatchObject({
        id: noteId,
        content: 'milk, eggs',
        version: 2,
      });
    });

    it("refuses the other device's stale copy instead of undoing the save", async () => {
      // The owner's app synced before the editor typed, so it holds v1.
      const { cursor } = await owner.sync.drain();
      await editor.notes.update(noteId, {
        content: 'milk, eggs',
        baseVersion: 1,
      });

      const stale = await owner.sync.push(
        [
          {
            type: 'note',
            id: noteId,
            baseVersion: 1,
            title: 'groceries',
            content: 'milk',
          },
        ],
        { cursor },
      );
      expect(stale.results[0]).toMatchObject({ status: 'conflict' });
      expect(await editor.notes.read(noteId)).toMatchObject({
        content: 'milk, eggs',
      });

      // The browser gets the same answer on PATCH.
      const refused = await owner.http
        .patch(`/api/notes/${noteId}`)
        .send({ content: 'milk', baseVersion: 1 })
        .expect(409);
      expect(
        (refused.body as { serverNote: { content: string; version: number } })
          .serverNote,
      ).toMatchObject({ content: 'milk, eggs', version: 2 });
    });

    it("delivers the editor's save to the owner's open connection", async () => {
      const stream = await owner.openEventStream();

      await editor.notes.update(noteId, {
        content: 'milk, eggs',
        baseVersion: 1,
      });

      await stream.waitFor('event: sync');
    });
  });
});
