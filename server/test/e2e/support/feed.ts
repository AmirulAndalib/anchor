import type { SyncEntry } from './wire';

type EntityType = SyncEntry['entityType'];

export const entriesOf = (entries: SyncEntry[], type: EntityType) =>
  entries.filter((entry) => entry.entityType === type);

export const entryFor = (
  entries: SyncEntry[],
  type: EntityType,
  entityId: string,
) =>
  entries.find(
    (entry) => entry.entityType === type && entry.entityId === entityId,
  )!;

export const idsOf = (entries: SyncEntry[]) =>
  entries.map((entry) => entry.entityId);

/** `[entityType, entityId]` pairs for a whole page. */
export const shapeOf = (entries: SyncEntry[]) =>
  entries.map((entry) => [entry.entityType, entry.entityId]);
