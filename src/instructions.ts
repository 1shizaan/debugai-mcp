// The text handed to the agent at connect time - the one channel the protocol
// gives a server to say what it is FOR. Without it agents skip debug_error,
// because "analyze this error" looks like something they already do themselves.
//
// WHY THIS IS ITS OWN MODULE. It used to be a `const INSTRUCTIONS` literal in
// each server.ts under a comment reading "Kept in sync with packages/mcp".
// On 2026-09-20 the two had drifted: the bundled copy had lost the whole
// paragraph saying this server reads the source files a stack trace names -
// a capability the bundled server HAS (drift.test.ts pins sourceContext.ts in
// both) and was simply never telling anyone about. VS Code 1.101+ registers
// the bundled server automatically, so that silence reached every extension
// user. Fourth instance of one shape in this repo, and a comment was the guard
// again. Byte-identical copies plus a test that reads the other file as text is
// the pattern that has actually held (Rule 15b): lookupAnswer.ts, outcomeAck.ts,
// memorySection.ts, workspaceFacts.ts.
//
// THE OPENING LINE IS THE PRODUCT. An agent decides whether to call a tool by
// reading this, before it has ever seen a response. Every trigger here used to
// be the USER doing something - "when the user pastes an error". In an agentic
// session the user is not in the loop at the moment a build fails: the agent
// ran `tsc`, and the agent is holding the failure. An outside agent reported
// running three real errors past DebugAI in one session, two of which matched
// no listed trigger, and said it only called at all because a human told it to
// (docs/agent-integration-guide.md). 124 of 153 production rows in the month
// before were MCP traffic. Agents are the surface, and the description was
// addressing somebody else.

/** Shared by both servers. The npm server appends SIGN_IN. */
export const INSTRUCTIONS_BASE = `DebugAI is this project's debugging memory and fix verifier.

Reach for it the moment something fails, INCLUDING when you caused the failure
yourself: a build or typecheck exiting non-zero, a linter reporting errors, a
test suite going red, a script exiting non-zero, a runtime throwing, a user
pasting a traceback. In an agentic session you are usually the one holding the
failure and nobody is going to ask you to look it up.

When anything fails, call lookup_error first. It answers from this project's
memory in under a second, makes no model call and costs nothing against the
debug limit: whether this error was seen here before, the fix that was
confirmed for it, and fixes recently reported as failed. With a confirmed fix,
apply it and re-run what failed. Trivial errors included: a lookup that finds
nothing still costs nothing.

When memory has no confirmed fix, call debug_error before reasoning your way to
a fix alone, and do not skip it because you think you already know the answer.
It returns things you cannot derive from the code in front of you:
  - whether this exact error has been seen before in this project, and how often
  - the fix a human already confirmed worked for it, if there is one
  - a verification state per fix: mechanically checked and passed, checked and
    FAILED, or not checked at all (never treat "not checked" as verified)
  - machine-applicable edits (exact old/new strings, each naming the file it
    belongs to) you can apply directly
If you have a command that shows the failure (a test, a script, a curl), pass it
as reproCommand, with expected: fix #1 is then aimed at making it pass, and each
fix's check is that command rather than a syntax check. DebugAI never runs it.

Read the root cause carefully and treat the patch as a draft. Apply an edit when
its old_string still matches the file; otherwise write the fix yourself from the
root cause, which is the half that is hard to get right. Then re-run whatever
failed and report what happened. A fix may carry its own check in verify_with,
but only where one can be derived, so treat that field as a bonus and not as
the plan - passing reproCommand is how you get a check worth trusting.

Pass the raw error or traceback. You do not need to find and paste the source
first: this server runs on the same machine as the code, so it resolves the
files the trace names and sends them along. It reads source files inside the
current project only, and the response says which ones. Pass codeSnippet
yourself only when you already know the relevant code is somewhere the trace
does not name.

After you apply or abandon a fix, call report_outcome with the debug_log_id.
Report it even when you ignored the answer and fixed it your own way: pass
result "unused" and put what actually worked in actualFix. A case DebugAI got
wrong is worth more to it than one it got right, and "unused" is not the same
as "failed" - reporting a fix as failed when you never ran it buries it for the
next person. A correct diagnosis wearing a patch that did not fit is "unused"
too: nothing of ours was run, and filing it as "failed" blames the diagnosis for
the patch. If the tool could have served you better here, say so in
toolFeedback; that reaches the people who build it.
If a fix worked only after you changed it, report "worked_modified" and send the
code that held in finalFix: that code, not the suggestion, is what the next
person who hits the error is handed.
That is what turns a one-off answer into memory for the next person who hits
the same error. Skipping it costs the user the feature they are paying for.

When you present findings that came from DebugAI's memory or verification,
say so - "DebugAI has seen this 3 times; the confirmed fix is ..." - so the user
can tell which claims were checked and which are your own reasoning.`;

// npm only. The bundled server is authenticated by the extension that ships it,
// so there is no code to read out and telling an agent otherwise sends the user
// looking for a sign-in flow that does not exist for them.
export const SIGN_IN = `

Not signed in yet? The first tool call returns a short code and a URL. Read
both out to the user; once they confirm in the browser, retry the same call.
No config editing and no client restart needed.`;

export function serverInstructions(opts: { signIn: boolean }): string {
  return opts.signIn ? INSTRUCTIONS_BASE + SIGN_IN : INSTRUCTIONS_BASE;
}
