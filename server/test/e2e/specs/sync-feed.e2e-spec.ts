import { ANCHOR_PROTOCOL } from 'src/common/protocol/protocol.constants';
import { encodeCursor } from 'src/sync/sync-cursor.util';
import {
  Actor,
  createE2EApp,
  E2EApp,
  entriesOf,
  entryFor,
  idsOf,
  shapeOf,
  SyncEntry,
} from '../support';

/**
 * The pull half of the sync endpoint: the opening snapshot, the delta feed that
 * follows it, and the cursor that ties them together.
 */
describe('sync feed', () => {
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

  it('first pull snapshots in phase order and hands out a delta cursor that drains empty', async () => {
    const tag = await user.tags.create({ name: 'work' });
    const pinned = await user.notes.create({ title: 'pinned', isPinned: true });
    const withFile = await user.notes.create({ title: 'with file' });
    await user.attachments.upload(withFile.id, 'a.png');

    const first = await user.sync.pull();
    expect(first.protocol).toBe(ANCHOR_PROTOCOL);
    expect(first.hasMore).toBe(true);
    expect(shapeOf(first.entries)).toEqual([
      ['tag', tag.id],
      ...[pinned.id, withFile.id].sort().map((id) => ['note', id]),
      ['attachments', withFile.id],
      ['pin', pinned.id],
    ]);
    // Snapshot entries are synthesized, not from the feed index.
    expect(first.entries.every((e) => e.seq === '0')).toBe(true);
    expect(first.entries.every((e) => e.op === 'upsert')).toBe(true);

    expect(entryFor(first.entries, 'tag', tag.id).tag).toMatchObject({
      id: tag.id,
      name: 'work',
      version: 1,
    });
    expect(entryFor(first.entries, 'note', pinned.id).note).toMatchObject({
      title: 'pinned',
      version: 1,
      isPinned: true,
    });
    const attachments = entryFor(first.entries, 'attachments', withFile.id);
    expect(attachments.attachments).toHaveLength(1);
    expect(attachments.attachments![0]).toMatchObject({
      noteId: withFile.id,
      originalFilename: 'a.png',
      type: 'image',
    });

    // The delta pull that follows the snapshot drains to empty.
    const second = await user.sync.pull({ cursor: first.nextCursor! });
    expect(second.entries).toEqual([]);
    expect(second.hasMore).toBe(false);
  });

  it('an empty account snapshots straight through to an empty delta', async () => {
    const { entries } = await user.sync.drain();
    expect(entries).toEqual([]);
  });

  it('snapshot pagination with limit=1 covers everything without gaps or duplicates', async () => {
    await user.tags.create({ name: 'a' });
    await user.tags.create({ name: 'b' });
    const notes = await Promise.all([
      user.notes.create({ title: 'one' }),
      user.notes.create({ title: 'two', isPinned: true }),
      user.notes.create({ title: 'three' }),
    ]);

    const { entries } = await user.sync.drain({ limit: 1 });
    const keys = entries.map((e) => `${e.entityType}:${e.entityId}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(entriesOf(entries, 'tag')).toHaveLength(2);
    expect(entriesOf(entries, 'note')).toHaveLength(3);
    expect(idsOf(entriesOf(entries, 'pin'))).toEqual([notes[1].id]);
  });

  it('delta pull returns hydrated entries past the cursor and advances it', async () => {
    const note = await user.notes.create({ title: 'original' });
    const { cursor } = await user.sync.drain();

    await user.notes.update(note.id, { title: 'edited' });

    const delta = await user.sync.pull({ cursor });
    expect(delta.hasMore).toBe(false);
    expect(delta.entries).toHaveLength(1);
    expect(delta.entries[0]).toMatchObject({
      entityType: 'note',
      entityId: note.id,
      op: 'upsert',
    });
    expect(BigInt(delta.entries[0].seq)).toBeGreaterThan(0n);
    expect(delta.entries[0].note).toMatchObject({
      title: 'edited',
      version: 2,
    });

    const again = await user.sync.pull({ cursor: delta.nextCursor! });
    expect(again.entries).toEqual([]);
  });

  it('a cursor behind the prune horizon or past the feed gets resetRequired', async () => {
    const note = await user.notes.create({ title: 'n' });
    const { cursor } = await user.sync.drain();

    await user.notes.update(note.id, { title: 'n2' });
    const state = await ctx.prisma.syncState.findUniqueOrThrow({
      where: { userId: user.id },
    });
    await ctx.prisma.syncState.update({
      where: { userId: user.id },
      data: { prunedThroughSeq: state.lastSeq },
    });

    const pruned = await user.sync.pull({ cursor });
    expect(pruned).toMatchObject({
      resetRequired: true,
      hasMore: false,
      nextCursor: null,
      entries: [],
    });

    // A cursor beyond lastSeq (server restored from backup) also resets.
    const beyond = await user.sync.pull({
      cursor: encodeCursor({ mode: 'delta', seq: 999_999n }),
    });
    expect(beyond.resetRequired).toBe(true);
  });

  it('an index row whose entity vanished hydrates as a remove', async () => {
    const { cursor } = await user.sync.drain();
    await ctx.prisma.changeLog.create({
      data: {
        recipientUserId: user.id,
        entityType: 'note',
        entityId: crypto.randomUUID(),
        op: 'upsert',
        seq: 1n,
      },
    });
    await ctx.prisma.syncState.upsert({
      where: { userId: user.id },
      create: { userId: user.id, lastSeq: 1n },
      update: { lastSeq: 1n },
    });

    const delta = await user.sync.pull({ cursor });
    expect(delta.entries).toEqual([
      expect.objectContaining({ entityType: 'note', op: 'remove' }),
    ]);
    expect(delta.entries[0].note).toBeUndefined();
  });

  it('rejects malformed cursors, oversized limits, and unknown change types', async () => {
    await user.http.post('/api/sync').send({ cursor: 'garbage' }).expect(400);
    await user.http.post('/api/sync').send({ limit: 501 }).expect(400);
    await user.http
      .post('/api/sync')
      .send({ changes: [{ type: 'share', id: 'x' }] })
      .expect(400);
  });

  it('writes landing mid-snapshot re-arrive as deltas and the feed converges', async () => {
    for (let i = 0; i < 5; i++) {
      await user.notes.create({ title: `pre-${i}` });
    }
    const edited = await user.notes.create({ title: 'before edit' });

    // Start the snapshot but stop while it is still mid-flight.
    let page = await user.sync.pull({ limit: 3 });
    expect(page.hasMore).toBe(true);

    // Writes racing the snapshot: a brand-new note and an edit of one the
    // snapshot may or may not have already emitted.
    const midway = await user.notes.create({ title: 'created mid-snapshot' });
    await user.notes.update(edited.id, { title: 'edited mid-snapshot' });

    const entries = [...page.entries];
    let pulls = 1;
    while (page.hasMore) {
      page = await user.sync.pull({ cursor: page.nextCursor!, limit: 3 });
      entries.push(...page.entries);
      pulls += 1;
      expect(pulls).toBeLessThan(50);
    }

    // Both racing writes came through the post-snapshot delta with real seqs.
    const deltaIds = idsOf(entries.filter((e) => e.seq !== '0'));
    expect(deltaIds).toContain(midway.id);
    expect(deltaIds).toContain(edited.id);
    // Last-entry-wins leaves the client with the edited title.
    const lastEdited = entries.filter((e) => e.entityId === edited.id).at(-1)!;
    expect(lastEdited.note).toMatchObject({ title: 'edited mid-snapshot' });
    // The feed is drained: nothing left behind the cursor.
    const settle = await user.sync.pull({ cursor: page.nextCursor! });
    expect(settle.entries).toEqual([]);
    expect(settle.hasMore).toBe(false);
  });

  it('pages 500+ entries gap- and dup-free while concurrent writers keep landing', async () => {
    const createdIds: string[] = [];
    // Enough concurrent writers to race the SyncState lock.
    const createBatch = async (count: number, prefix: string) => {
      for (let done = 0; done < count; done += 10) {
        const size = Math.min(10, count - done);
        const notes = await Promise.all(
          Array.from({ length: size }, (_, i) =>
            user.notes.create({ title: `${prefix}-${done + i}` }),
          ),
        );
        createdIds.push(...notes.map((n) => n.id));
      }
    };

    // 400 notes up front: the SyncState row lock must serialize seq
    // allocation so no writer commits a seq a reader already paged past.
    await createBatch(400, 'wave');

    const entries: SyncEntry[] = [];
    let page = await user.sync.pull({ limit: 150 });
    entries.push(...page.entries);
    let pulls = 1;
    // More writers land between pages.
    await createBatch(50, 'interleaved-a');
    while (page.hasMore) {
      page = await user.sync.pull({ cursor: page.nextCursor!, limit: 150 });
      entries.push(...page.entries);
      pulls += 1;
      if (pulls === 3) {
        await createBatch(50, 'interleaved-b');
      }
      expect(pulls).toBeLessThan(50);
    }

    // Every one of the 500 notes arrived.
    const seen = new Set(idsOf(entriesOf(entries, 'note')));
    for (const id of createdIds) {
      expect(seen.has(id)).toBe(true);
    }
    expect(createdIds).toHaveLength(500);

    // Delta pages are strictly seq-ascending with no duplicate entities.
    const deltaEntries = entries.filter((e) => e.seq !== '0');
    const seqs = deltaEntries.map((e) => BigInt(e.seq));
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i] > seqs[i - 1]).toBe(true);
    }
    const deltaIds = idsOf(deltaEntries);
    expect(new Set(deltaIds).size).toBe(deltaIds.length);
  }, 120_000);

  it('feeds are strictly per-user: nothing leaks across accounts', async () => {
    const other = await ctx.registerUser();
    const mine = await user.notes.create({ title: 'mine' });
    const myTag = await user.tags.create({ name: 'my-tag' });
    const theirs = await other.notes.create({ title: 'theirs' });
    const theirTag = await other.tags.create({ name: 'their-tag' });

    const myFeed = await user.sync.drain();
    const theirFeed = await other.sync.drain();

    expect(new Set(idsOf(myFeed.entries))).toEqual(
      new Set([mine.id, myTag.id]),
    );
    expect(new Set(idsOf(theirFeed.entries))).toEqual(
      new Set([theirs.id, theirTag.id]),
    );
  });
});
