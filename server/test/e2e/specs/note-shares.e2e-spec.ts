import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Actor,
  createE2EApp,
  E2EApp,
  entryFor,
  SharePermission,
  ShareOnWire,
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
});
