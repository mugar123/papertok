/**
 * Reading a body without trusting what it claims about its own size.
 *
 * `content-length` is a hint the sender writes, and a chunked request does not
 * send one at all, so a cap enforced on the header alone is not a cap: the way
 * past it is to omit the header. `request.json()` and `response.arrayBuffer()`
 * have already bought the whole thing by the time anything can measure it —
 * which on a Worker means the isolate's memory limit, not a 413.
 *
 * Both readers below count bytes as they arrive and stop at the cap, cancelling
 * what is left so the sender is not still uploading into a decision that has
 * already been made. The errors are the caller's: this module has no opinion
 * about what a route calls "too large".
 */

function concatenate(chunks, byteLength) {
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * The request body as parsed JSON, or `tooLarge()` / `invalid()` thrown.
 *
 * A declared length over the cap is refused without reading anything at all —
 * an honest oversized upload should not be paid for twice.
 */
export async function readBoundedJson(request, maximumBytes, { tooLarge, invalid }) {
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) throw tooLarge();

  let bytes;
  if (request.body?.getReader) {
    const reader = request.body.getReader();
    const chunks = [];
    let byteLength = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        byteLength += value.byteLength;
        if (byteLength > maximumBytes) {
          await reader.cancel();
          throw tooLarge();
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    bytes = concatenate(chunks, byteLength);
  } else {
    // No stream to walk (a test double, an already-buffered body): the read is
    // unavoidable, so the cap is checked on what came back.
    const fallbackBytes = new TextEncoder().encode(await request.text());
    if (fallbackBytes.byteLength > maximumBytes) throw tooLarge();
    bytes = fallbackBytes;
  }

  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw invalid();
  }
}

/**
 * The response body, or `null` once it passes the cap.
 *
 * `null` rather than a throw because every caller of this treats an unusable
 * download the same way it treats a missing one.
 */
export async function readBoundedBytes(response, maximumBytes) {
  if (!response?.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength > maximumBytes ? null : bytes;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maximumBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return concatenate(chunks, byteLength);
}
