// What an anonymous PostHog `$exception` event keeps: the error type, where in
// our code it happened, the release its bundle was built for, and allowlisted
// operation, status and email-limit labels. Messages,
// variables, source lines and every other property stay home. Shared by the
// browser (`sanitizeAnalyticsCapture`) and the Worker (`worker/error-tracking.ts`).

interface ExceptionFrame {
  platform?: unknown; filename?: unknown; function?: unknown;
  lineno?: unknown; colno?: unknown; in_app?: unknown; chunk_id?: unknown;
}
interface ExceptionEntry {
  type?: unknown;
  mechanism?: { handled?: unknown; synthetic?: unknown };
  stacktrace?: { frames?: unknown };
}

const ERROR_TYPES = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError']);
const PLATFORMS = new Set(['web:javascript', 'node:javascript']);
// Chunk and release ids are written into our bundles at build time.
const BUILD_ID = /^[\w-]{1,128}$/;
const OPERATIONS = new Set(['http', 'rewrite', 'schedule', 'render', 'durable_object', 'workflow']);

function codeLocation(filename: unknown) {
  if (typeof filename !== 'string') return undefined;
  const path = filename.split(/[?#]/, 1)[0];
  if (/^https:\/\/(?:www\.)?papertok\.app\/assets\/[\w.-]+\.js$/.test(path)) return path;
  const source = path.match(/(?:^|\/)((?:worker|src)\/[\w./-]+\.[cm]?[jt]sx?)$/);
  if (source) return source[1];
  if (/^(?:app:\/\/\/)?[\w.-]+\.[cm]?js$/.test(path)) return `app:///${path.slice(path.lastIndexOf('/') + 1)}`;
  // Development frames still identify code, never the page being read.
  if (/^http:\/\/(?:localhost|127\.0\.0\.1):\d+\/assets\/[\w.-]+\.js$/.test(path)) return path;
  if (/^(?:file:\/\/)?\/.*\/\.wrangler\/tmp\/[\w/-]+\/[\w.-]+\.js$/.test(path)) return `app:///${path.slice(path.lastIndexOf('/') + 1)}`;
  return undefined;
}

function positiveInteger(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function sanitizeFrame(frame: ExceptionFrame) {
  const filename = codeLocation(frame.filename);
  if (!filename || !PLATFORMS.has(frame.platform as string)) return null;
  const lineno = positiveInteger(frame.lineno);
  const colno = positiveInteger(frame.colno);
  return {
    platform: frame.platform,
    filename,
    // A name from our own bundle; '?' is what PostHog's parser writes for none.
    function: typeof frame.function === 'string' && /^[\w$.<> ]{1,200}$/.test(frame.function) ? frame.function : '?',
    in_app: typeof frame.in_app === 'boolean' ? frame.in_app : true,
    ...(lineno ? { lineno } : {}),
    ...(colno ? { colno } : {}),
    // Links the frame to the source map uploaded for its bundle.
    ...(typeof frame.chunk_id === 'string' && BUILD_ID.test(frame.chunk_id) ? { chunk_id: frame.chunk_id } : {}),
  };
}

function sanitizeException(exception: ExceptionEntry) {
  const frames = Array.isArray(exception.stacktrace?.frames) ? exception.stacktrace.frames as ExceptionFrame[] : [];
  return {
    type: ERROR_TYPES.has(exception.type as string) ? exception.type : 'Error',
    value: 'Application error (message redacted)',
    mechanism: {
      type: 'generic',
      handled: typeof exception.mechanism?.handled === 'boolean' ? exception.mechanism.handled : false,
      synthetic: exception.mechanism?.synthetic === true,
    },
    stacktrace: { type: 'raw', frames: frames.slice(-30).flatMap(frame => sanitizeFrame(frame) ?? []) },
  };
}

export function sanitizeExceptionProperties(properties: Record<string, unknown>) {
  const exceptions = properties.$exception_list;
  if (!Array.isArray(exceptions) || !exceptions.length) return null;
  const status = properties.http_status;
  return {
    $exception_level: 'error',
    $exception_list: (exceptions as ExceptionEntry[]).slice(0, 3).map(sanitizeException),
    ...(typeof properties.$release_id === 'string' && BUILD_ID.test(properties.$release_id) ? { $release_id: properties.$release_id } : {}),
    ...(OPERATIONS.has(properties.operation as string) ? { operation: properties.operation } : {}),
    ...(typeof status === 'number' && status >= 500 && status < 600 ? { http_status: status } : {}),
    ...(properties.email_limit === 'reached' ? { email_limit: 'reached' } : {}),
  };
}
