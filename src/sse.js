// @ts-check

/**
 * Yield the payload of each `data:` line from an SSE byte stream. Handles CRLF,
 * `data:` with or without a space, and lines/UTF-8 sequences split across chunks.
 *
 * @param {ReadableStream<Uint8Array>} stream
 * @returns {AsyncGenerator<string>}
 */
export async function* sseData(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = done ? "" : (lines.pop() ?? "");
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(line[5] === " " ? 6 : 5).trim();
        if (data) yield data;
      }
      if (done) return;
    }
  } finally {
    // Runs on normal end, on `break`, and on errors: stop pulling from upstream.
    reader.cancel().catch(() => {});
  }
}
