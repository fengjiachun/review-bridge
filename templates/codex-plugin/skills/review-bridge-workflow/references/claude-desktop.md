## Dispatching a CLAUDE_DESKTOP review

Use [Prepare](prepare.md) for a local review or [Advisory panel](advisory-panel.md)
for an advisory member. The operator opens a fresh Claude Desktop conversation
themselves. Never launch, script, or otherwise programmatically invoke a Claude
reviewer from this session: this is an account-compliance boundary.

Give the operator the returned `review_id`, `reviewer_provider`, `review_strategy`,
and this request to paste into the fresh conversation:

> Independently review Review Bridge task `<review_id>` using the packaged
> Claude review instructions. Require `reviewer_provider: CLAUDE_DESKTOP`,
> follow the review strategy, and submit every actionable finding.

Send no authoring history or other reviewer's findings. Wait with
`wait_for_review_state` on the recorded `state_version`; a timeout is expected
while the person or reviewer is still working. After a local verdict, load
[Handle findings](findings.md) or [Finish](finish.md). For round two of the same
ID, the operator may resume that conversation with the review ID and a request
to rereview the author's resolutions. An advisory panel has no second round.
