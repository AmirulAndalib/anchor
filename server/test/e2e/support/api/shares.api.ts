import { bodyOf, HttpClient } from '../http';
import type { ShareOnWire } from '../wire';

export type SharePermission = 'viewer' | 'editor';

export class SharesApi {
  constructor(private readonly http: HttpClient) {}

  async grant(
    noteId: string,
    sharedWithUserId: string,
    permission: SharePermission,
  ): Promise<ShareOnWire> {
    const res = await this.http
      .post(`/api/notes/${noteId}/shares`)
      .send({ sharedWithUserId, permission })
      .expect(201);
    return bodyOf<ShareOnWire>(res);
  }

  async list(noteId: string): Promise<ShareOnWire[]> {
    const res = await this.http.get(`/api/notes/${noteId}/shares`).expect(200);
    return bodyOf<ShareOnWire[]>(res);
  }

  async setPermission(
    noteId: string,
    shareId: string,
    permission: SharePermission,
  ): Promise<ShareOnWire> {
    const res = await this.http
      .patch(`/api/notes/${noteId}/shares/${shareId}`)
      .send({ permission })
      .expect(200);
    return bodyOf<ShareOnWire>(res);
  }

  async revoke(noteId: string, shareId: string): Promise<{ success: boolean }> {
    const res = await this.http
      .delete(`/api/notes/${noteId}/shares/${shareId}`)
      .expect(200);
    return bodyOf<{ success: boolean }>(res);
  }
}
