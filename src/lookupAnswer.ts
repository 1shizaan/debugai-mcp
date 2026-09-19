/**
 * What lookup_error says to the agent that asked.
 *
 * lookup_error answers from this project's memory with no model call (field
 * report 2026-09-16, R10), so everything it says is a stored fact, and the text
 * must not dress one up as more than it is. Four things decide the reply:
 *
 *   memory off     no project reached the API. Say so and say how to fix it;
 *                  silence here read as "never seen" for a whole session (F1).
 *   not seen       nothing stored. The next step is debug_error.
 *   seen, a fix    the state decides the verb. 'confirmed' is offered as the
 *                  fix to try first; 'unproven' (the error came back once) is
 *                  offered as something to check; 'anti_pattern' (it came back
 *                  twice or more) is named as what NOT to do. The same three
 *                  readings memory_state.py gives the model.
 *   refuted        fixes this project recently reported as failed, whatever
 *                  their signature: what not to try again.
 *
 * "Accepted" is not "observed". A fix is confirmed by somebody saying it worked,
 * which the engine words as "accepted, not observed to work" unless a browser
 * session watched the error stop; the reply keeps that distinction.
 *
 * Pure, no imports. Mirror: packages/mcp/src/lookupAnswer.ts and
 * apps/extension/src/mcp/lookupAnswer.ts, byte-identical INCLUDING this header
 * (apps/extension/src/mcp/drift.test.ts).
 */

export interface LookupResult {
  memory_enabled?: boolean | null;
  memory_disabled_reason?: string;
  memory_hit?: boolean;
  memory_times_seen?: number;
  memory_fix_state?: 'none' | 'confirmed' | 'unproven' | 'anti_pattern' | string;
  memory_recurrences_after_fix?: number;
  memory_verified_count?: number;
  last_seen_at?: string | null;
  stored_fix?: string | null;
  refuted?: { at: string; rank: number; title: string; what_happened?: string }[];
}

const DEBUG_NEXT = 'Call debug_error with the full error for an analysis.';

function times(n: number): string {
  return n === 1 ? 'once' : `${n} times`;
}

export function renderLookup(r: LookupResult, project: string): string {
  const lines: string[] = [];
  if (r.memory_enabled === false) {
    lines.push(
      `DebugAI memory is off for this call (${r.memory_disabled_reason || 'no project'}), so nothing ` +
      'was looked up. Pass projectRoot, or an absolute filePath inside the repository, so the ' +
      `error is filed under the right project. ${DEBUG_NEXT}`,
    );
    return lines.join('\n');
  }

  if (!r.memory_hit) {
    lines.push(`Not seen before in this project (${project}). ${DEBUG_NEXT}`);
  } else {
    const seen = Math.max(0, r.memory_times_seen ?? 0);
    const when = r.last_seen_at ? `, last on ${r.last_seen_at.slice(0, 10)}` : '';
    lines.push(`Seen ${times(seen)} before in this project (${project})${when}.`);
    const fix = (r.stored_fix ?? '').trim();
    const observed = (r.memory_verified_count ?? 0) > 0
      ? 'and a live session watched the error stop after it'
      : 'accepted by whoever applied it, not observed to work';
    switch (r.memory_fix_state) {
      case 'confirmed':
        lines.push(`A fix was confirmed for it (${observed}). Try it first:`, '', fix, '',
          'If the error comes back after applying it, call debug_error with the new output. ' +
          'That records the recurrence against this fix, so the next person is not handed it blindly.');
        break;
      case 'unproven':
        lines.push('A fix was applied before, and this error has come back once since. Treat it as ' +
          'unproven: check it against the code as it is now before applying it.', '', fix, '', DEBUG_NEXT);
        break;
      case 'anti_pattern':
        lines.push(`A fix was applied before, and this error came back ${times(Math.max(2, r.memory_recurrences_after_fix ?? 2))} ` +
          'after it. Do NOT repeat it:', '', fix, '', DEBUG_NEXT);
        break;
      default:
        lines.push(`No fix was ever confirmed for it. ${DEBUG_NEXT}`);
    }
  }

  const refuted = Array.isArray(r.refuted) ? r.refuted : [];
  if (refuted.length) {
    lines.push('', 'Tried in this project recently and reported as FAILED. Do not repeat these:');
    refuted.forEach((x, i) => {
      const what = x.what_happened ? `: ${x.what_happened}` : '';
      lines.push(`${i + 1}. ${x.title} (fix #${x.rank}, ${x.at})${what}`);
    });
  }
  return lines.join('\n');
}
