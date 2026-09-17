import { NotesService } from 'src/notes/services/notes.service';
import { Actor, createE2EApp, E2EApp } from '../support';
import type { ReminderOnWire, SyncEntry } from '../support/wire';

describe('sync reminders', () => {
  const AT = '2026-09-04T09:00';
  const LATER = '2026-09-05T18:30';

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
    owner = await ctx.registerUser();
  });

  const reminderChange = (
    noteId: string,
    overrides: Record<string, unknown> = {},
  ) => ({ type: 'reminder', id: noteId, remindAt: AT, ...overrides });

  const storedReminder = (userId: string, noteId: string) =>
    ctx.prisma.noteReminder.findUnique({
      where: { userId_noteId: { userId, noteId } },
    });

  const entriesFor = (entries: SyncEntry[], entityId: string) =>
    entries.filter(
      (e) => e.entityType === 'reminder' && e.entityId === entityId,
    );

  it('sets, carries and clears a reminder through the feed', async () => {
    const note = await owner.notes.create({ title: 'water the plants' });
    const caughtUp = await owner.sync.drain();

    const set = await owner.sync.push([reminderChange(note.id)]);
    expect(set.results).toEqual([
      { type: 'reminder', id: note.id, status: 'applied', version: 1 },
    ]);

    const feed = await owner.sync.drain({ cursor: caughtUp.cursor });
    const entry = entriesFor(feed.entries, note.id).at(-1);
    expect(entry?.op).toBe('upsert');
    expect(entry?.reminder).toEqual<ReminderOnWire>({
      remindAt: AT,
      recurrence: 'none',
      version: 1,
    });

    const note2 = await owner.notes.read(note.id);
    expect(note2.reminder).toMatchObject({ remindAt: AT });

    const cleared = await owner.sync.push([
      reminderChange(note.id, { remindAt: null, baseVersion: 1 }),
    ]);
    expect(cleared.results[0].status).toBe('applied');
    expect(await storedReminder(owner.id, note.id)).toBeNull();

    const after = await owner.sync.drain({ cursor: feed.cursor });
    expect(entriesFor(after.entries, note.id).at(-1)?.op).toBe('remove');
    expect((await owner.notes.read(note.id)).reminder).toBeNull();
  });

  it('does not bump the note version or record a revision', async () => {
    const note = await owner.notes.create({ title: 'quiet' });

    await owner.sync.push([reminderChange(note.id)]);

    const row = await ctx.prisma.note.findUniqueOrThrow({
      where: { id: note.id },
    });
    expect(row.version).toBe(1);
    expect(
      await ctx.prisma.noteRevision.count({ where: { noteId: note.id } }),
    ).toBe(0);
  });

  it('lets a viewer keep their own reminder on a shared note', async () => {
    const viewer = await ctx.registerUser();
    const note = await owner.notes.create({ title: 'shared' });
    await owner.shares.grant(note.id, viewer.id, 'viewer');

    const mine = await owner.sync.push([reminderChange(note.id)]);
    const theirs = await viewer.sync.push([
      reminderChange(note.id, { remindAt: LATER }),
    ]);

    expect(mine.results[0].status).toBe('applied');
    expect(theirs.results[0].status).toBe('applied');

    // Each side sees only its own.
    expect((await owner.notes.read(note.id)).reminder).toMatchObject({
      remindAt: AT,
    });
    expect((await viewer.notes.read(note.id)).reminder).toMatchObject({
      remindAt: LATER,
    });
  });

  it('refuses a stale clear and hands back the newer reminder', async () => {
    const note = await owner.notes.create({ title: 'contested' });
    await owner.sync.push([reminderChange(note.id)]);
    await owner.sync.push([
      reminderChange(note.id, { remindAt: LATER, baseVersion: 1 }),
    ]);

    const stale = await owner.sync.push([
      reminderChange(note.id, { remindAt: null, baseVersion: 1 }),
    ]);

    expect(stale.results[0]).toMatchObject({
      type: 'reminder',
      status: 'conflict',
      serverCopy: { remindAt: LATER, version: 2 },
    });
    expect(await storedReminder(owner.id, note.id)).not.toBeNull();
  });

  it('takes a reminder set after another device cleared the old one', async () => {
    const note = await owner.notes.create({ title: 'rebooked' });
    await owner.sync.push([reminderChange(note.id)]);
    // Cleared from the web while this device was offline.
    await owner.notes.update(note.id, { reminder: null });

    const reset = await owner.sync.push([
      reminderChange(note.id, { remindAt: LATER, baseVersion: 1 }),
    ]);

    expect(reset.results[0]).toMatchObject({ status: 'applied' });
    expect(await storedReminder(owner.id, note.id)).toMatchObject({
      remindAt: LATER,
    });
  });

  it('leaves the reminder alone unless the update carries the field', async () => {
    const note = await owner.notes.create({ title: 'plants' });
    // The version a web editor holds from the moment it loaded the note.
    const opened = await owner.notes.read(note.id);

    await owner.sync.push([reminderChange(note.id)]);

    const saved = await owner.notes.update(note.id, {
      title: 'water the plants',
      baseVersion: opened.version,
    });
    expect(saved.reminder).toMatchObject({ remindAt: AT });

    // Carrying the field overrules whatever is stored.
    const cleared = await owner.notes.update(note.id, {
      title: 'plants',
      reminder: null,
      baseVersion: opened.version + 1,
    });
    expect(cleared.reminder).toBeNull();
    expect(await storedReminder(owner.id, note.id)).toBeNull();
  });

  it('acks a redelivered push instead of conflicting against itself', async () => {
    const note = await owner.notes.create({ title: 'repeat' });
    await owner.sync.push([reminderChange(note.id)]);

    const again = await owner.sync.push([reminderChange(note.id)]);

    expect(again.results[0]).toMatchObject({ status: 'applied', version: 1 });
  });

  it('drops the sharee reminder when their share is revoked', async () => {
    const viewer = await ctx.registerUser();
    const note = await owner.notes.create({ title: 'revoked' });
    const share = await owner.shares.grant(note.id, viewer.id, 'viewer');
    await viewer.sync.push([reminderChange(note.id)]);
    expect(await storedReminder(viewer.id, note.id)).not.toBeNull();

    await owner.shares.revoke(note.id, share.id);

    expect(await storedReminder(viewer.id, note.id)).toBeNull();
    const rows = await ctx.prisma.changeLog.findMany({
      where: { recipientUserId: viewer.id, entityType: 'reminder' },
    });
    expect(rows).toEqual([]);
  });

  it('denies a reminder on a note the caller cannot see', async () => {
    const stranger = await ctx.registerUser();
    const note = await owner.notes.create({ title: 'private' });

    const res = await stranger.sync.push([reminderChange(note.id)]);

    expect(res.results[0].status).toBe('denied');
    expect(await storedReminder(stranger.id, note.id)).toBeNull();
  });

  it('purges reminders when the tombstone is hard-deleted', async () => {
    const note = await owner.notes.create({ title: 'doomed' });
    await owner.sync.push([reminderChange(note.id)]);

    await owner.notes.trash(note.id);
    await owner.notes.purge(note.id);
    expect(await storedReminder(owner.id, note.id)).not.toBeNull();

    await ctx.prisma.note.update({
      where: { id: note.id },
      data: { stateChangedAt: new Date(Date.now() - 31 * 86_400_000) },
    });
    await ctx.get(NotesService).purgeTombstones(30);

    expect(await storedReminder(owner.id, note.id)).toBeNull();
  });
});
