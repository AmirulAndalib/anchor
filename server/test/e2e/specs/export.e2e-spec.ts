import { Actor, createE2EApp, E2EApp, ExportManifestOnWire } from '../support';

const SHOPPING = JSON.stringify({
  ops: [
    { insert: 'Shopping' },
    { insert: '\n', attributes: { header: 2 } },
    { insert: 'Milk' },
    { insert: '\n', attributes: { list: 'bullet' } },
    { insert: 'Oat milk' },
    { insert: '\n', attributes: { list: 'bullet', indent: 1 } },
    { insert: 'call the ' },
    { insert: 'shop', attributes: { bold: true } },
    { insert: '\n', attributes: { list: 'unchecked' } },
  ],
});

/**
 * The two shapes the export endpoint streams: the Anchor backup a restore
 * reads back, and the plain markdown files other apps read.
 */
describe('export', () => {
  let ctx: E2EApp;
  let owner: Actor;
  let friend: Actor;

  beforeAll(async () => {
    ctx = await createE2EApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    owner = await ctx.registerUser('Owner');
    friend = await ctx.registerUser('Friend');
  });

  describe('format selection', () => {
    it('rejects a format it cannot write', async () => {
      await owner.export.request('?format=pdf').expect(400);
    });

    it('defaults to the anchor backup', async () => {
      await owner.notes.create({ title: 'Kept' });

      const download = await owner.export.download();

      expect(download.contentType).toBe('application/zip');
      expect(download.filename).toMatch(
        /^anchor-export-\d{4}-\d{2}-\d{2}\.zip$/,
      );
      expect(download.zip.has('manifest.json')).toBe(true);
    });

    it('names the markdown archive apart from the backup', async () => {
      await owner.notes.create({ title: 'Kept' });

      const download = await owner.export.download('markdown');

      expect(download.filename).toMatch(
        /^anchor-markdown-\d{4}-\d{2}-\d{2}\.zip$/,
      );
      expect(download.zip.has('manifest.json')).toBe(false);
    });
  });

  describe('anchor backup', () => {
    it('keeps trashed notes, which a restore puts back', async () => {
      const note = await owner.notes.create({ title: 'Gone' });
      await owner.notes.trash(note.id);

      const { zip } = await owner.export.download('anchor');
      const manifest = zip.json<ExportManifestOnWire>('manifest.json');

      expect(manifest.counts.notes).toBe(1);
      expect(manifest.notes[0]).toMatchObject({
        id: note.id,
        state: 'trashed',
      });
    });

    it('drops an attachment whose file is gone and says so', async () => {
      const note = await owner.notes.create({ title: 'Trip' });
      const attachment = await owner.attachments.upload(note.id);
      await ctx.prisma.$executeRawUnsafe(
        `UPDATE "NoteAttachment" SET "storedFilename" = 'missing.png' WHERE id = '${attachment.id}'`,
      );

      const { zip } = await owner.export.download('anchor');
      const manifest = zip.json<ExportManifestOnWire>('manifest.json');

      expect(manifest.counts.attachments).toBe(0);
      expect(manifest.notes[0].attachments).toEqual([]);
      expect(manifest.warnings).toEqual([
        expect.stringContaining('Attachment file missing on disk'),
      ]);
    });
  });

  describe('markdown files', () => {
    it('files notes by state and leaves the trash behind', async () => {
      await owner.notes.create({ title: 'Kept' });
      await owner.notes.create({ title: 'Filed', isArchived: true });
      const trashed = await owner.notes.create({ title: 'Gone' });
      await owner.notes.trash(trashed.id);

      const theirs = await friend.notes.create({ title: 'From Friend' });
      await friend.shares.grant(theirs.id, owner.id, 'viewer');

      const { zip } = await owner.export.download('markdown');

      expect(zip.names.sort()).toEqual([
        'Archived/Filed.md',
        'Kept.md',
        'Shared/From Friend.md',
      ]);
    });

    it('writes the note body as markdown', async () => {
      await owner.notes.create({ title: 'Shopping', content: SHOPPING });

      const { zip } = await owner.export.download('markdown');

      expect(zip.text('Shopping.md')).toBe(
        '## Shopping\n- Milk\n    - Oat milk\n- [ ] call the **shop**\n',
      );
    });

    it('sanitizes titles and numbers the ones that collide', async () => {
      await owner.notes.create({ title: 'Groceries' });
      await owner.notes.create({ title: 'Groceries' });
      await owner.notes.create({ title: 'a/b: c?' });

      const { zip } = await owner.export.download('markdown');

      expect(zip.names.sort()).toEqual([
        'Groceries (2).md',
        'Groceries.md',
        'a b c.md',
      ]);
    });
  });
});
