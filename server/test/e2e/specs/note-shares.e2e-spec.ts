import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Actor,
  createE2EApp,
  E2EApp,
  entryFor,
  SharePermission,
  ShareOnWire,
  TagOnWire,
} from '../support';

/**
 * What a share puts on each side's feed: the sharee's view of a note they do
 * not own, and what changes for them on permission changes and revokes.
 */
describe('note shares', () => {
  let ctx: E2EApp;
  let owner: Actor;
  let sharee: Actor;

  beforeAll(async () => {
    ctx = await createE2EApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    owner = await ctx.registerUser('Owner');
    sharee = await ctx.registerUser('Sharee');
  });

  const share = (
    noteId: string,
    permission: SharePermission,
  ): Promise<ShareOnWire> => owner.shares.grant(noteId, sharee.id, permission);

  it('grant reaches the sharee feed with permission and sharedBy', async () => {
    const note = await owner.notes.create({ title: 'shared note' });
    await share(note.id, 'viewer');

    const { entries } = await sharee.sync.drain();
    const change = entryFor(entries, 'note', note.id).note!;
    expect(change).toMatchObject({
      title: 'shared note',
      permission: 'viewer',
      userId: owner.id,
      sharedBy: {
        id: owner.id,
        name: owner.name,
        email: owner.email,
        profileImage: null,
      },
    });
    // Sharees never receive the owner's shareIds.
    expect(change.shareIds).toBeUndefined();
  });

  it('a grant after the sharee has synced arrives as a delta', async () => {
    const note = await owner.notes.create({ title: 'shared later' });
    const { cursor } = await sharee.sync.drain();

    await share(note.id, 'editor');

    const { entries } = await sharee.sync.drain({ cursor });
    expect(entries.map((e) => e.entityType).sort()).toEqual([
      'attachments',
      'note',
    ]);
    expect(entryFor(entries, 'note', note.id).note!.permission).toBe('editor');
  });

  it('owner content edits reach the sharee delta feed', async () => {
    const note = await owner.notes.create({ title: 'will change' });
    await share(note.id, 'viewer');
    const { cursor } = await sharee.sync.drain();

    await owner.notes.update(note.id, { title: 'changed by owner' });

    const { entries } = await sharee.sync.drain({ cursor });
    expect(entryFor(entries, 'note', note.id).note!.title).toBe(
      'changed by owner',
    );
  });

  it('tagIds are per-user on a shared note', async () => {
    const note = await owner.notes.create({ title: 'tagged both sides' });
    await share(note.id, 'editor');

    const ownerTag = await owner.tags.create({ name: 'owner-tag' });
    await owner.notes.update(note.id, { tagIds: [ownerTag.id] });

    const shareeTag = await sharee.tags.create({ name: 'sharee-tag' });
    await sharee.notes.update(note.id, { tagIds: [shareeTag.id] });

    const shareeView = await sharee.sync.drain();
    expect(entryFor(shareeView.entries, 'note', note.id).note!.tagIds).toEqual([
      shareeTag.id,
    ]);

    const ownerView = await owner.sync.drain();
    expect(entryFor(ownerView.entries, 'note', note.id).note!.tagIds).toEqual([
      ownerTag.id,
    ]);
  });

  it('permission change re-announces the note with the new permission', async () => {
    const note = await owner.notes.create({ title: 'downgraded' });
    const shareRow = await share(note.id, 'editor');
    const { cursor } = await sharee.sync.drain();

    await owner.shares.setPermission(note.id, shareRow.id, 'viewer');

    const { entries } = await sharee.sync.drain({ cursor });
    expect(entryFor(entries, 'note', note.id).note!.permission).toBe('viewer');
  });

  it('revoke removes the note from the sharee feed for good', async () => {
    const note = await owner.notes.create({ title: 'revoked soon' });
    const shareRow = await share(note.id, 'viewer');
    const first = await sharee.sync.drain();
    expect(entryFor(first.entries, 'note', note.id)).toBeDefined();

    expect(await owner.shares.revoke(note.id, shareRow.id)).toEqual({
      success: true,
    });

    const delta = await sharee.sync.drain({ cursor: first.cursor });
    expect(entryFor(delta.entries, 'note', note.id)).toMatchObject({
      op: 'remove',
    });

    // A sharee starting from scratch never sees it either.
    const fresh = await sharee.sync.drain();
    expect(entryFor(fresh.entries, 'note', note.id)).toBeUndefined();
  });

  it('revoke takes the note out of the sharee notes list', async () => {
    const note = await owner.notes.create({ title: 'revoked soon' });
    const shareRow = await share(note.id, 'viewer');
    expect((await sharee.notes.list()).map((n) => n.id)).toEqual([note.id]);

    await owner.shares.revoke(note.id, shareRow.id);

    expect(await sharee.notes.list()).toEqual([]);
    await sharee.http.get(`/api/notes/${note.id}`).expect(404);
  });

  it('post-revoke sharee pushes are denied', async () => {
    const note = await owner.notes.create({ title: 'owner keeps this' });
    const shareRow = await share(note.id, 'editor');
    await owner.shares.revoke(note.id, shareRow.id);

    const res = await sharee.sync.push([
      { type: 'note', id: note.id, title: 'edit after revoke', baseVersion: 1 },
    ]);

    expect(res.results).toEqual([
      { type: 'note', id: note.id, status: 'denied' },
    ]);
    const row = await ctx.prisma.note.findUnique({ where: { id: note.id } });
    expect(row!.title).toBe('owner keeps this');
  });

  it('revoke removes the sharee pin and re-share reuses the share row', async () => {
    const note = await owner.notes.create({ title: 'pinned by sharee' });
    const shareRow = await share(note.id, 'viewer');
    await sharee.notes.bulkPin([note.id], true);

    await owner.shares.revoke(note.id, shareRow.id);
    const pin = await ctx.prisma.notePin.findUnique({
      where: { userId_noteId: { userId: sharee.id, noteId: note.id } },
    });
    expect(pin).toBeNull();

    const reshared = await share(note.id, 'editor');
    expect(reshared.id).toBe(shareRow.id);
    expect(reshared.permission).toBe('editor');
  });

  it('owner shareIds shrink on revoke', async () => {
    const note = await owner.notes.create({ title: 'share ids' });
    const shareRow = await share(note.id, 'viewer');

    const before = await owner.sync.drain();
    expect(entryFor(before.entries, 'note', note.id).note!.shareIds).toEqual([
      shareRow.id,
    ]);

    await owner.shares.revoke(note.id, shareRow.id);

    const after = await owner.sync.drain();
    expect(entryFor(after.entries, 'note', note.id).note!.shareIds).toEqual([]);
  });

  it('only the owner can manage shares', async () => {
    const editor = await ctx.registerUser('Editor');
    const note = await owner.notes.create({ title: 'owner only' });
    await share(note.id, 'editor');

    await sharee.http
      .post(`/api/notes/${note.id}/shares`)
      .send({ sharedWithUserId: editor.id, permission: 'viewer' })
      .expect(403);
  });

  it('self-share and unknown user are rejected', async () => {
    const note = await owner.notes.create({ title: 'no self share' });

    await owner.http
      .post(`/api/notes/${note.id}/shares`)
      .send({ sharedWithUserId: owner.id, permission: 'viewer' })
      .expect(400);
    await owner.http
      .post(`/api/notes/${note.id}/shares`)
      .send({ sharedWithUserId: 'no-such-user', permission: 'viewer' })
      .expect(404);
  });

  const ids = (notes: { id: string }[]) => notes.map((n) => n.id);

  const tagCount = async (actor: Actor, tagId: string) => {
    const res = await actor.http.get('/api/tags').expect(200);
    return (res.body as TagOnWire[]).find((tag) => tag.id === tagId)?._count
      ?.notes;
  };

  describe('a sharee deleting a shared note', () => {
    it('leaves it, and the owner keeps it', async () => {
      const note = await owner.notes.create({ title: 'keep mine' });
      const shareRow = await share(note.id, 'viewer');
      const { cursor } = await sharee.sync.drain();

      await sharee.notes.trash(note.id);

      expect(await sharee.notes.list()).toEqual([]);
      await sharee.http.get(`/api/notes/${note.id}`).expect(404);
      const delta = await sharee.sync.drain({ cursor });
      expect(entryFor(delta.entries, 'note', note.id)).toMatchObject({
        op: 'remove',
      });

      const kept = await owner.notes.read(note.id);
      expect(kept).toMatchObject({ state: 'active', shareIds: [] });
      const row = await ctx.prisma.noteShare.findUniqueOrThrow({
        where: { id: shareRow.id },
      });
      expect(row.isDeleted).toBe(true);
    });

    it('takes their pin, archive, reminder and tags with them', async () => {
      const note = await owner.notes.create({ title: 'personal bits' });
      await share(note.id, 'editor');
      const tag = await sharee.tags.create({ name: 'mine' });
      await sharee.notes.update(note.id, {
        tagIds: [tag.id],
        isPinned: true,
        reminder: { remindAt: '2026-10-01T09:00' },
      });
      await sharee.notes.bulkArchive([note.id]);

      await sharee.notes.trash(note.id);

      const where = { userId: sharee.id, noteId: note.id };
      expect(await ctx.prisma.notePin.count({ where })).toBe(0);
      expect(await ctx.prisma.noteArchive.count({ where })).toBe(0);
      expect(await ctx.prisma.noteReminder.count({ where })).toBe(0);
      expect(await tagCount(sharee, tag.id)).toBe(0);

      await share(note.id, 'viewer');
      expect(await sharee.notes.read(note.id)).toMatchObject({
        isPinned: false,
        isArchived: false,
        tagIds: [],
        reminder: null,
      });
    });

    it('from multi-select trashes their own notes and leaves shared ones', async () => {
      const shared = await owner.notes.create({ title: 'theirs' });
      await share(shared.id, 'viewer');
      const own = await sharee.notes.create({ title: 'mine' });

      expect(
        await sharee.notes.bulkTrash([shared.id, own.id, 'no-such-note']),
      ).toEqual({ count: 2 });

      expect(ids(await sharee.notes.listTrashed())).toEqual([own.id]);
      expect(await sharee.notes.list()).toEqual([]);
      expect((await owner.notes.read(shared.id)).state).toBe('active');
    });

    it('from a phone leaves it even after the owner trashed it', async () => {
      const note = await owner.notes.create({ title: 'trashed first' });
      await share(note.id, 'editor');
      await owner.notes.trash(note.id);

      const res = await sharee.sync.push([
        {
          type: 'note',
          id: note.id,
          title: note.title,
          baseVersion: note.version,
          state: 'deleted',
        },
      ]);

      expect(res.results[0].status).toBe('denied');
      await owner.notes.restore(note.id);
      expect(await sharee.notes.list()).toEqual([]);
    });

    it('never happens from a phone sending saved versions', async () => {
      const note = await owner.notes.create({ title: 'still mine' });
      await share(note.id, 'editor');

      await sharee.sync.push([
        {
          type: 'note',
          id: note.id,
          title: note.title,
          baseVersion: note.version,
          state: 'trashed',
          revisionsOnly: true,
        },
      ]);

      expect(ids(await sharee.notes.list())).toEqual([note.id]);
    });

    it('from a phone leaves it', async () => {
      const note = await owner.notes.create({ title: 'phone delete' });
      await share(note.id, 'editor');

      const res = await sharee.sync.push([
        {
          type: 'note',
          id: note.id,
          title: note.title,
          baseVersion: note.version,
          state: 'trashed',
        },
      ]);

      expect(res.results).toEqual([
        { type: 'note', id: note.id, status: 'denied' },
      ]);
      expect(await sharee.notes.list()).toEqual([]);
      expect(await owner.notes.read(note.id)).toMatchObject({
        state: 'active',
        version: note.version,
      });
    });
  });

  it("a viewer's pin and reminder save from the note, for them alone", async () => {
    const note = await owner.notes.create({ title: 'for later' });
    await share(note.id, 'viewer');

    const saved = await sharee.notes.update(note.id, {
      isPinned: true,
      tagIds: [],
      reminder: { remindAt: '2026-10-01T09:00' },
    });

    expect(saved).toMatchObject({
      isPinned: true,
      reminder: { remindAt: '2026-10-01T09:00' },
    });
    expect(await owner.notes.read(note.id)).toMatchObject({
      isPinned: false,
      reminder: null,
      version: note.version,
    });
  });

  describe('tags on a shared note', () => {
    it('a viewer tags it for themselves without touching the note', async () => {
      const note = await owner.notes.create({ title: 'tag me' });
      await share(note.id, 'viewer');
      const tag = await sharee.tags.create({ name: 'reading' });
      const ownerFeed = await owner.sync.drain();

      const tagged = await sharee.notes.update(note.id, { tagIds: [tag.id] });

      expect(tagged.tagIds).toEqual([tag.id]);
      expect(await tagCount(sharee, tag.id)).toBe(1);
      expect((await owner.notes.read(note.id)).tagIds).toEqual([]);
      const row = await ctx.prisma.note.findUniqueOrThrow({
        where: { id: note.id },
      });
      expect(row.version).toBe(note.version);
      expect(row.updatedAt.toISOString()).toBe(note.updatedAt);
      const ownerDelta = await owner.sync.drain({ cursor: ownerFeed.cursor });
      expect(ownerDelta.entries).toEqual([]);
    });

    it('a viewer still cannot edit the note while tagging', async () => {
      const note = await owner.notes.create({ title: 'tag me' });
      await share(note.id, 'viewer');
      const tag = await sharee.tags.create({ name: 'reading' });

      await sharee.http
        .patch(`/api/notes/${note.id}`)
        .send({ title: 'viewer edit', tagIds: [tag.id] })
        .expect(403);
      expect((await sharee.notes.read(note.id)).tagIds).toEqual([]);
    });

    it('multi-select tags every note you can see', async () => {
      const shared = await owner.notes.create({ title: 'theirs' });
      await share(shared.id, 'viewer');
      const own = await sharee.notes.create({ title: 'mine' });
      const tag = await sharee.tags.create({ name: 'both' });

      const res = await sharee.http
        .post('/api/notes/bulk/tags')
        .send({ noteIds: [shared.id, own.id], tagIds: [tag.id] })
        .expect(201);

      expect(res.body).toEqual({ count: 2 });
      expect(await tagCount(sharee, tag.id)).toBe(2);
      expect((await owner.notes.read(shared.id)).tagIds).toEqual([]);
    });

    it("a viewer's phone push tags it", async () => {
      const note = await owner.notes.create({ title: 'phone tags' });
      await share(note.id, 'viewer');
      const tag = await sharee.tags.create({ name: 'on the go' });

      const res = await sharee.sync.push([
        {
          type: 'note',
          id: note.id,
          title: note.title,
          baseVersion: note.version,
          tagIds: [tag.id],
        },
      ]);

      expect(res.results).toEqual([
        { type: 'note', id: note.id, status: 'applied', version: note.version },
      ]);
      expect((await sharee.notes.read(note.id)).tagIds).toEqual([tag.id]);
    });
  });
});
