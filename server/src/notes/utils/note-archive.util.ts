import type { Prisma } from 'src/generated/prisma/client';

// undefined leaves the archive untouched; true archives, false unarchives (per
// user). Returns whether anything changed.
export async function setNoteArchive(
  tx: Prisma.TransactionClient,
  userId: string,
  noteId: string,
  isArchived: boolean | undefined,
): Promise<boolean> {
  if (isArchived === undefined) {
    return false;
  }
  if (isArchived) {
    const { count } = await tx.noteArchive.createMany({
      data: [{ userId, noteId }],
      skipDuplicates: true,
    });
    return count > 0;
  }
  const { count } = await tx.noteArchive.deleteMany({
    where: { userId, noteId },
  });
  return count > 0;
}
