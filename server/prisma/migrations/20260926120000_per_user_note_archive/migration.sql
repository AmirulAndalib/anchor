-- CreateTable
CREATE TABLE "NoteArchive" (
    "userId" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NoteArchive_pkey" PRIMARY KEY ("userId","noteId")
);

-- CreateIndex
CREATE INDEX "NoteArchive_noteId_idx" ON "NoteArchive"("noteId");

-- AddForeignKey
ALTER TABLE "NoteArchive" ADD CONSTRAINT "NoteArchive_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteArchive" ADD CONSTRAINT "NoteArchive_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "Note"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Everyone who could see an archived note keeps it archived.
INSERT INTO "NoteArchive" ("userId", "noteId")
SELECT "userId", "id" FROM "Note" WHERE "isArchived" = true
UNION
SELECT s."sharedWithUserId", s."noteId"
FROM "NoteShare" s
JOIN "Note" n ON n."id" = s."noteId"
WHERE n."isArchived" = true AND s."isDeleted" = false;

-- AlterTable
ALTER TABLE "Note" DROP COLUMN "isArchived";
