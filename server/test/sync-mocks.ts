import { vi } from 'vitest';
import { SyncEmitterService } from '../src/sync/sync-emitter.service';
import { SyncEventsService } from '../src/sync/sync-events.service';
import { NoteRevisionsService } from '../src/sync/note-revisions.service';

// Emitter/revisions doubles for service unit tests, which assert service
// behaviour rather than ChangeLog contents.
export function createMockSyncEmitter() {
  return {
    emit: vi.fn().mockResolvedValue([]),
    noteRecipients: vi.fn().mockResolvedValue([]),
    notesRecipients: vi.fn().mockResolvedValue(new Map<string, string[]>()),
    removeNote: vi.fn().mockResolvedValue([]),
    removeNotes: vi.fn().mockResolvedValue([]),
  };
}

export type MockSyncEmitter = ReturnType<typeof createMockSyncEmitter>;

export const asSyncEmitter = (mock: MockSyncEmitter) =>
  mock as unknown as SyncEmitterService;

export function createMockSyncEvents() {
  return {
    schedulePoke: vi.fn(),
    poke: vi.fn(),
  };
}

export type MockSyncEvents = ReturnType<typeof createMockSyncEvents>;

export const asSyncEvents = (mock: MockSyncEvents) =>
  mock as unknown as SyncEventsService;

export function createMockNoteRevisions() {
  return {
    recordEdit: vi.fn().mockResolvedValue(undefined),
    recordClient: vi.fn().mockResolvedValue(undefined),
    recordConflict: vi.fn().mockResolvedValue(undefined),
    recordRestore: vi.fn().mockResolvedValue(undefined),
  };
}

export type MockNoteRevisions = ReturnType<typeof createMockNoteRevisions>;

export const asNoteRevisions = (mock: MockNoteRevisions) =>
  mock as unknown as NoteRevisionsService;
