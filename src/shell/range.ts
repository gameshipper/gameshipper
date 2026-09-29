/** Inclusive byte range, as in HTTP. */
export interface ByteRange {
  start: number;
  end: number;
}

const RANGE = /^bytes=(\d*)-(\d*)$/i;

/**
 * Parses a single-range `Range: bytes=...` header for a file of `size` bytes.
 * Returns null when the header is absent or unusable (other units, bad syntax, several
 * ranges), meaning "serve the whole file", which HTTP allows.
 */
export function parseRange(header: string | null | undefined, size: number): ByteRange | 'unsatisfiable' | null {
  const m = RANGE.exec((header ?? '').trim());
  if (!m) return null;
  const [, first, last] = m;
  if (first === '' && last === '') return null;
  if (first === '') {
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (last !== '' && Number(last) < start) return null;
  if (start >= size) return 'unsatisfiable';
  return { start, end: last === '' ? size - 1 : Math.min(Number(last), size - 1) };
}

export interface FileResponsePlan {
  status: 200 | 206 | 416;
  headers: Record<string, string>;
  /** What to stream: the whole file, one range of it, or nothing. */
  body: 'whole' | ByteRange | null;
}

/** Status, headers and body for serving a file, honouring a Range header so media can seek. */
export function planFileResponse(size: number, rangeHeader: string | null | undefined, contentType: string): FileResponsePlan {
  const range = parseRange(rangeHeader, size);
  if (range === 'unsatisfiable') {
    return { status: 416, headers: { 'content-length': '0', 'accept-ranges': 'bytes', 'content-range': `bytes */${size}` }, body: null };
  }
  if (range === null) {
    return {
      status: 200,
      headers: { 'content-type': contentType, 'content-length': String(size), 'accept-ranges': 'bytes' },
      body: 'whole',
    };
  }
  return {
    status: 206,
    headers: {
      'content-type': contentType,
      'content-length': String(range.end - range.start + 1),
      'accept-ranges': 'bytes',
      'content-range': `bytes ${range.start}-${range.end}/${size}`,
    },
    body: range,
  };
}
