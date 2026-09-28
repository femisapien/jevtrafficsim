/**
 * A bounded read of the relay's request body.
 *
 * ## The defect this replaces
 *
 * The route checked `content-length` before reading and checked the ACTUAL size
 * after `request.text()` had already buffered the whole body. A `content-length`
 * is a claim by the caller and is absent entirely on a chunked request, so a
 * length-less body of arbitrary size was materialised in the function's memory
 * before the ceiling could reject it. The check was in the right place in the
 * code and in the wrong place in time.
 *
 * ## What this does instead
 *
 * It reads the body STREAM and stops the moment the total exceeds `maxBytes`:
 * at most `maxBytes` plus one chunk of a rejected request is ever held, whatever
 * the caller sends and however the caller frames it. The residual body is
 * cancelled rather than drained, so an oversized request costs one chunk of
 * work, not the bandwidth to finish it.
 *
 * The smallest thing that satisfies that: no framing parser, no streaming
 * framework, no lookahead — one reader, one running total, one decoder at the
 * end. The size the ceiling is compared against is the BYTE count actually
 * read, not a character count and not the caller's claim.
 *
 * ## The one case it cannot bound, stated plainly
 *
 * `request.body` is null only when the request carries no body at all (both
 * runtimes this app deploys to — Node's undici and Next's edge runtime — always
 * hand a real body over as a stream). So a null body reads as the empty string,
 * which fails JSON parsing and is refused 400: fail closed, never buffer blind.
 */
/** What one bounded read produced, in a closed three-value vocabulary. */
export type BoundedBodyRead =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: "too-large" | "unreadable" };

/**
 * Read at most `maxBytes` of the request body.
 *
 * Returns `too-large` (413 territory) when the body exceeds the ceiling, and
 * `unreadable` (400 territory) when the stream itself fails — two facts a
 * caller can tell apart, and both refuse before anything is forwarded.
 */
export async function readBoundedBody(request: Request, maxBytes: number): Promise<BoundedBodyRead> {
  const body = request.body;
  if (body === null) {
    return { ok: true, text: "" };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value === undefined || value.byteLength === 0) {
        continue;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        // Over the ceiling: stop reading and release the source. Everything
        // already held is dropped with this frame — the point is that no more
        // of the body is ever buffered than the ceiling allows.
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too-large" };
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return { ok: false, reason: "unreadable" };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // Non-fatal decoding, exactly as `await request.text()` did: the BYTE count
  // above is the authoritative size, so a body with invalid UTF-8 is refused by
  // JSON parsing rather than by a decoder that throws on it.
  return { ok: true, text: new TextDecoder().decode(bytes) };
}
