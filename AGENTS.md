# Repository Instructions

## Pull request state

Open pull requests ready for review by default, even when they contain an
approved work-in-progress slice. Use draft status only when the pull request is
genuinely not ready for review and we intentionally do not want it reviewed yet.
Do not use draft status merely because more work is planned.

## Codex automated reviews

When a pull request review is requested with a top-level `@codex review`
comment:

1. Find the exact issue-comment ID for the request.
2. Poll that comment's reactions. The Codex reviewer is still running while its
   `eyes` reaction is present.
3. Treat the review as complete only after the `eyes` reaction is removed.
4. After completion, a Codex `+1` reaction means it found no issues. Otherwise,
   fetch the completed review and its thread-aware `reviewThreads` state before
   acting.
5. Do not act on partial review comments while the `eyes` reaction remains; the
   reviewer may still add or revise findings.

Use bounded polling, normally every 10–15 seconds, and keep the user updated
about once per minute during longer waits.

For every review conversation or inline thread you read, leave a concise GitHub
reply recording its disposition: fixed, deferred, non-actionable, or requiring
clarification.

When you fix a finding created by the Codex reviewer:

1. Implement and validate the fix.
2. Commit and push it to the pull-request branch.
3. Reply in the review thread with the fix summary and commit.
4. Resolve the review thread explicitly. Codex does not resolve its own threads
   after a later push.
5. Re-fetch thread-aware review state and verify `isResolved: true`.

Do not automatically request another full Codex review after every fix batch.
Make a judgment call based on the severity of the bugs fixed and the scope and
blast radius of the changes:

- Request re-review for P0/P1 fixes, broad refactors, protocol or schema
  changes, or changes spanning multiple interacting components.
- Decide case by case for P2 fixes.
- Normally skip re-review for narrow, well-tested P2/P3 fixes that do not
  introduce significant new behavior.

Never resolve a finding that was not fixed. Explain the disposition in the
thread and leave it open.
