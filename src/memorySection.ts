/**
 * What this project already knows about this exact error.
 *
 * ## Why it is its own module
 *
 * This section was the headline of npm 2.4.0 and **never reached the bundled
 * server** — the zero-config one VS Code registers automatically, with no
 * install and no config, and therefore the copy an agent is most likely to be
 * on. For weeks the most-used MCP server advertised memory in its own
 * instructions and never printed a word of it. That is the third time a
 * decision duplicated across this boundary has drifted in the same direction.
 *
 * Inlined in two `debugError.ts` files it drifted silently, because
 * `drift.test.ts` pinned tool SIGNATURES and the signatures were identical.
 * As a module it is byte-comparable, and that comparison now ships as a test.
 *
 * Mirror: apps/extension/src/mcp/memorySection.ts
 * The two are identical below this header. Change one, change the other, on
 * the same commit (Rule 15b).
 */
/** The fields the engine sends about a remembered error. Every one optional:
 *  an older engine sends none, and absence must read as "nothing remembered"
 *  rather than as "nothing happened". */
export interface MemoryFields {
  memory_hit?: boolean;
  memory_times_seen?: number;
  memory_fix_confirmed?: boolean;
  memory_fix_state?: string;
  memory_verified_count?: number;
}

/**
 * The "Seen before" section, or null when there is nothing remembered.
 *
 * Returns null rather than an empty string so a caller cannot push a blank
 * heading into the response and leave an agent reading "## Seen before"
 * followed by nothing, which is worse than no section: it looks like a lookup
 * that ran and found the error is new.
 */
export function memorySection(result: MemoryFields | null | undefined): string | null {
  if (!result?.memory_hit) { return null; }

  const seen = typeof result.memory_times_seen === 'number'
    ? `${result.memory_times_seen}x before in this project`
    : 'before in this project';

  // Four states, not two. Until 2026-08-21 this said "a fix was confirmed
  // working" on the strength of somebody clicking Apply, and a fix that had
  // been tried and FAILED was indistinguishable from one nobody had ever
  // tried — both fell into the else branch and read "no fix has been confirmed
  // yet". An agent reading that will happily re-propose the fix that already
  // did not work, which is the loop this exists to break.
  //
  // memory_fix_state is what the engine sends now. When it is absent (older
  // engine) the boolean still decides, exactly as before.
  const state = typeof result.memory_fix_state === 'string'
    ? result.memory_fix_state
    : (result.memory_fix_confirmed ? 'confirmed' : 'none');
  const verified = typeof result.memory_verified_count === 'number'
    ? result.memory_verified_count
    : 0;

  let body: string;
  if (state === 'confirmed' && verified > 0) {
    body =
      `This error has been seen ${seen}. A fix for it was VERIFIED BY ` +
      `OBSERVATION ${verified}x: a live session watched the error stop ` +
      `after that fix was applied. It led the analysis above.`;
  } else if (state === 'confirmed') {
    body =
      `This error has been seen ${seen}. A fix for it was applied and ` +
      `accepted by a developer, though nothing has observed it working. ` +
      `It led the analysis above. Treat it as a strong lead, not proof.`;
  } else if (state === 'unproven') {
    body =
      `This error has been seen ${seen}. A fix was applied for it and ` +
      `THE ERROR HAS RECURRED ONCE SINCE, so that fix is unproven. The ` +
      `analysis above was told not to lead with it.`;
  } else if (state === 'anti_pattern') {
    body =
      `This error has been seen ${seen}. A fix was applied for it and ` +
      `THE ERROR KEPT HAPPENING. That fix did not work and the analysis ` +
      `above was told not to propose it again. If you are about to ` +
      `suggest something equivalent, the cause is somewhere it does not ` +
      `touch.`;
  } else {
    body = `This error has been seen ${seen}. No fix has been confirmed for it yet.`;
  }
  return `\n## Seen before\n${body}`;
}
