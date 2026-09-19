/**
 * What report_outcome says back to the agent that sent the report.
 *
 * The reply is the only thing that tells an agent its report landed somewhere
 * real and what became of it. An agent that says "I ignored you and did it
 * myself" and gets a generic thank-you learns that the field is decorative, and
 * stops filling it.
 *
 * One function, because the reply went wrong the one time it was a chain of
 * ternaries: when 'worked_modified' joined the enum on 2026-09-18 it fell
 * through to the last branch, and an agent whose fix had worked was told
 * "Outcome recorded: fix failed". Every verdict is named here, and the `never`
 * in the default makes a fifth verdict a compile error instead of a wrong
 * sentence.
 *
 * It claims only what the report itself settles. Whether memory keeps a fix
 * also depends on things this process cannot see from here (the project having
 * an id, the answer having an engine session), so it says what memory does
 * with a report like this one, never that it already happened.
 *
 * Pure, no imports. Mirror: packages/mcp/src/outcomeAck.ts and
 * apps/extension/src/mcp/outcomeAck.ts, byte-identical INCLUDING this header
 * (apps/extension/src/mcp/drift.test.ts).
 */

export type OutcomeResult = 'worked' | 'worked_modified' | 'failed' | 'unused';

export interface OutcomeReport {
  result: OutcomeResult;
  fixRank?: number;
  newError?: string;
  actualFix?: string;
  finalFix?: string;
}

const REMEMBERED =
  'Confirmed fixes are remembered per project, so the next time this error ' +
  'appears in this project it starts from';

export function outcomeAck(r: OutcomeReport): string {
  let text: string;
  switch (r.result) {
    case 'worked':
      text =
        `Outcome recorded: ${r.fixRank ? `fix ${r.fixRank}` : 'the fix'} worked. ` +
        `${REMEMBERED} that fix.`;
      break;
    case 'worked_modified':
      text =
        'Outcome recorded: the fix worked after your changes. The code you sent ' +
        'in finalFix is what gets remembered, not the original suggestion. ' +
        `${REMEMBERED} what actually worked.`;
      break;
    case 'unused':
      text =
        'Outcome recorded: our fix was not used.' +
        (r.actualFix
          ? ' The fix that actually worked was logged. That is the most useful thing this ' +
            'tool receives, because it is a case we got wrong.'
          : ' If you know what actually resolved it, send it in actualFix: a wrong answer ' +
            'we can see is worth more than a right one we cannot.');
      break;
    case 'failed':
      text =
        'Outcome recorded: fix failed.' +
        (r.newError
          ? ' The follow-up error was logged with it.'
          : ' No follow-up error was sent, so only the failure itself was logged.') +
        ' When the answer was filed under a project, that project\'s analyses and lookups ' +
        'are shown this fix for the next week as one not to repeat, however the next ' +
        'error is worded.' +
        ' If you are still stuck, call debug_error again with the NEW error text.';
      break;
    default: {
      const unreachable: never = r.result;
      text = `Outcome recorded: ${String(unreachable)}.`;
    }
  }
  // Loud rather than silent: the API drops finalFix on every other verdict,
  // because nothing claims that code worked.
  if (r.finalFix && r.result !== 'worked_modified') {
    text += ' finalFix was ignored: it is only read with result "worked_modified".';
  }
  return text;
}
