import type { ErrorEvent, StackFrame } from '@sentry/core';

export const ERROR_DATA_COLLECTION = {
  userInfo: false, cookies: false, httpHeaders: false, httpBodies: [],
  urlQueryParams: false, graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false }, databaseQueryData: false,
  queues: false, stackFrameVariables: false, frameContextLines: 0,
} as const;

function codeLocation(filename: string | undefined) {
  if (!filename) return undefined;
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

function sanitizeFrame(frame: StackFrame): StackFrame | null {
  const filename = codeLocation(frame.filename);
  if (!filename) return null;
  return {
    filename,
    abs_path: filename,
    ...(Number.isSafeInteger(frame.lineno) && frame.lineno! > 0 ? { lineno: frame.lineno } : {}),
    ...(Number.isSafeInteger(frame.colno) && frame.colno! > 0 ? { colno: frame.colno } : {}),
    ...(typeof frame.in_app === 'boolean' ? { in_app: frame.in_app } : {}),
    ...(frame.debug_id && /^[\da-f-]{36}$/i.test(frame.debug_id) ? { debug_id: frame.debug_id } : {}),
  };
}

export function sanitizeErrorEvent(event: ErrorEvent): ErrorEvent | null {
  if (!event.exception?.values?.length) return null;
  return {
    type: undefined,
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: 'javascript',
    // Prevent ingestion from deriving identity or location from the transport IP.
    user: { ip_address: '0.0.0.0' },
    level: 'error',
    environment: event.environment,
    release: event.release,
    exception: {
      values: event.exception.values.slice(0, 3).map(exception => ({
        type: ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError'].includes(exception.type || '') ? exception.type : 'Error',
        value: 'Application error (message redacted)',
        mechanism: { type: 'generic', handled: exception.mechanism?.handled ?? false },
        stacktrace: { frames: (exception.stacktrace?.frames || []).slice(-30).flatMap(frame => {
          const safe = sanitizeFrame(frame);
          return safe ? [safe] : [];
        }) },
      })),
    },
    tags: {
      ...(typeof event.tags?.http_status === 'number' && event.tags.http_status >= 500 && event.tags.http_status < 600 ? { http_status: event.tags.http_status } : {}),
      ...(['http', 'rewrite', 'schedule', 'render'].includes(String(event.tags?.operation)) ? { operation: event.tags!.operation } : {}),
    },
    debug_meta: {
      images: (event.debug_meta?.images || []).flatMap(image => {
        const filename = codeLocation(image.code_file);
        return image.type === 'sourcemap' && filename && /^[\da-f-]{36}$/i.test(image.debug_id)
          ? [{ type: 'sourcemap' as const, code_file: filename, debug_id: image.debug_id }]
          : [];
      }),
    },
  };
}
