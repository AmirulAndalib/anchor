import { bodyOf, HttpClient } from '../http';
import { ZipReader } from '../zip';

export type ExportFormat = 'anchor' | 'markdown';

export interface ExportDownload {
  filename: string;
  contentType: string;
  bytes: Buffer;
  zip: ZipReader;
}

export class ExportApi {
  constructor(private readonly http: HttpClient) {}

  /** Raw request, for asserting a rejection. */
  request(query = '') {
    // responseType makes superagent buffer the body instead of decoding it.
    return this.http.get(`/api/export${query}`).responseType('blob');
  }

  async download(format?: ExportFormat): Promise<ExportDownload> {
    const res = await this.request(format ? `?format=${format}` : '').expect(
      200,
    );
    const bytes = bodyOf<Buffer>(res);

    return {
      filename: filenameOf(res.headers['content-disposition']),
      contentType: res.headers['content-type'],
      bytes,
      zip: ZipReader.read(bytes),
    };
  }
}

function filenameOf(disposition: string | undefined): string {
  return /filename="([^"]*)"/.exec(disposition ?? '')?.[1] ?? '';
}
