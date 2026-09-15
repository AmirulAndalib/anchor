import { bodyOf, HttpClient } from '../http';
import type { NoteOnWire, RevisionOnWire, RevisionPageOnWire } from '../wire';

export class RevisionsApi {
  constructor(private readonly http: HttpClient) {}

  async list(noteId: string, query = ''): Promise<RevisionPageOnWire> {
    const res = await this.http
      .get(`/api/notes/${noteId}/revisions${query}`)
      .expect(200);
    return bodyOf<RevisionPageOnWire>(res);
  }

  async read(noteId: string, revisionId: string): Promise<RevisionOnWire> {
    const res = await this.http
      .get(`/api/notes/${noteId}/revisions/${revisionId}`)
      .expect(200);
    return bodyOf<RevisionOnWire>(res);
  }

  async restore(noteId: string, revisionId: string): Promise<NoteOnWire> {
    const res = await this.http
      .post(`/api/notes/${noteId}/revisions/${revisionId}/restore`)
      .expect(200);
    return bodyOf<NoteOnWire>(res);
  }
}
