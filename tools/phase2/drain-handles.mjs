// Stop every owned resource even if an earlier child failed. Never turn a failed
// child exit into PASS merely because its surviving siblings could be stopped.
export async function drainHandles(handles) {
  let first;
  for (const handle of [...handles].reverse()) {
    try { await handle.stop(); } catch (error) { first ??= error; }
  }
  if (first) throw first;
}
