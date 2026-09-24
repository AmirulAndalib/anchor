import * as zlib from 'zlib';

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

const STORED = 0;
const DEFLATED = 8;

/** Reads an exported archive back. */
export class ZipReader {
  private constructor(private readonly entries: Map<string, Buffer>) {}

  static read(archive: Buffer): ZipReader {
    const directory = findCentralDirectory(archive);
    const entries = new Map<string, Buffer>();
    let cursor = directory.offset;

    for (let i = 0; i < directory.count; i++) {
      if (archive.readUInt32LE(cursor) !== CENTRAL_FILE_HEADER) {
        throw new Error(`Corrupt central directory at byte ${cursor}`);
      }
      const method = archive.readUInt16LE(cursor + 10);
      const compressedSize = archive.readUInt32LE(cursor + 20);
      const nameLength = archive.readUInt16LE(cursor + 28);
      const extraLength = archive.readUInt16LE(cursor + 30);
      const commentLength = archive.readUInt16LE(cursor + 32);
      const localOffset = archive.readUInt32LE(cursor + 42);
      const name = archive.toString(
        'utf8',
        cursor + 46,
        cursor + 46 + nameLength,
      );

      if (!name.endsWith('/')) {
        entries.set(
          name,
          readEntryData(archive, localOffset, method, compressedSize),
        );
      }
      cursor += 46 + nameLength + extraLength + commentLength;
    }

    return new ZipReader(entries);
  }

  /** Entry names in central directory order. */
  get names(): string[] {
    return [...this.entries.keys()];
  }

  /** Entry names directly or deeply under a folder, e.g. `'Archived/'`. */
  namesUnder(prefix: string): string[] {
    return this.names.filter((name) => name.startsWith(prefix));
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  bytes(name: string): Buffer {
    const data = this.entries.get(name);
    if (!data) {
      throw new Error(
        `No entry "${name}" in archive. Entries: ${this.names.join(', ')}`,
      );
    }
    return data;
  }

  text(name: string): string {
    return this.bytes(name).toString('utf8');
  }

  json<T>(name: string): T {
    return JSON.parse(this.text(name)) as T;
  }
}

/** The trailing comment is variable length, so scan back for the record. */
function findCentralDirectory(archive: Buffer): {
  offset: number;
  count: number;
} {
  for (let i = archive.length - 22; i >= 0; i--) {
    if (archive.readUInt32LE(i) === END_OF_CENTRAL_DIRECTORY) {
      return {
        count: archive.readUInt16LE(i + 10),
        offset: archive.readUInt32LE(i + 16),
      };
    }
  }
  throw new Error('Not a zip: no end of central directory record');
}

function readEntryData(
  archive: Buffer,
  localOffset: number,
  method: number,
  compressedSize: number,
): Buffer {
  if (archive.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER) {
    throw new Error(`Corrupt local header at byte ${localOffset}`);
  }
  const nameLength = archive.readUInt16LE(localOffset + 26);
  const extraLength = archive.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLength + extraLength;
  // Streamed entries leave the sizes out of the local header, so the length
  // comes from the central directory instead.
  if (compressedSize === 0) return Buffer.alloc(0);

  const data = archive.subarray(start, start + compressedSize);
  if (method === STORED) return Buffer.from(data);
  if (method === DEFLATED) return zlib.inflateRawSync(data);
  throw new Error(`Unsupported compression method ${method}`);
}
