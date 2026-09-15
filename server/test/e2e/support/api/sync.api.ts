import { bodyOf, HttpClient } from '../http';
import type { SyncEntry, SyncResponse } from '../wire';

export interface SyncRequestBody {
  cursor?: string;
  limit?: number;
  changes?: Record<string, unknown>[];
}

export interface DrainResult {
  entries: SyncEntry[];
  cursor: string;
  pulls: number;
}

const MAX_DRAIN_PULLS = 50;

export class SyncApi {
  constructor(private readonly http: HttpClient) {}

  async pull(body: SyncRequestBody = {}): Promise<SyncResponse> {
    const res = await this.http.post('/api/sync').send(body).expect(200);
    return bodyOf<SyncResponse>(res);
  }

  push(
    changes: Record<string, unknown>[],
    body: SyncRequestBody = {},
  ): Promise<SyncResponse> {
    return this.pull({ ...body, changes });
  }

  /** Pages from `cursor` (or from scratch) until the server runs dry. */
  async drain(body: SyncRequestBody = {}): Promise<DrainResult> {
    let page = await this.pull(body);
    const entries = [...page.entries];
    let pulls = 1;

    while (page.hasMore) {
      expect(pulls).toBeLessThan(MAX_DRAIN_PULLS);
      page = await this.pull({ ...body, cursor: page.nextCursor ?? undefined });
      entries.push(...page.entries);
      pulls += 1;
    }

    return { entries, cursor: page.nextCursor!, pulls };
  }
}
