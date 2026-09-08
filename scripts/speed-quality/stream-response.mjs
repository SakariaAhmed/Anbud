// Forward provider bytes immediately while recording bounded SSE metadata only.
// Usage is observational: it never releases a budget reservation.
export async function forwardStream(body, write, started = performance.now()) {
  const decoder = new TextDecoder();
  let pending = "", usage, completion, firstContentMs;
  function readLine(line) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") return;
    try {
      const event = JSON.parse(line.slice(6));
      usage = event.usage ?? event.response?.usage ?? usage;
      if (event.choices?.some((c) => c.delta?.content) || event.type === "response.output_text.delta") firstContentMs ??= performance.now() - started;
      const reasons = event.choices?.map((c) => c.finish_reason).filter(Boolean);
      if (reasons?.length) completion = { finishReasons: reasons };
      if (["response.completed", "response.incomplete"].includes(event.type)) completion = { status: event.response?.status, incompleteReason: event.response?.incomplete_details?.reason };
    } catch { /* A malformed metadata line does not modify provider bytes. */ }
  }
  for await (const chunk of body) {
    await write(chunk);
    pending += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = pending.indexOf("\n")) >= 0) {
      readLine(pending.slice(0, end).trimEnd());
      pending = pending.slice(end + 1);
    }
    if (pending.length > 2_000_000) throw new Error("Unbounded SSE event.");
  }
  pending += decoder.decode();
  if (pending) readLine(pending.trimEnd());
  return { usage, completion, firstContentMs };
}
