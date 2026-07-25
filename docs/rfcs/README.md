# Review Bridge RFCs

RFCs describe substantial protocol, state-machine, security-boundary, or
cross-client changes before implementation.

## Lifecycle

1. Create the next numbered RFC as `NNNN-short-title.md`.
2. Mark it `Draft` while design review is in progress.
3. Change it to `Accepted` after the design decision is approved.
4. Change it to `Implemented` when the shipped implementation matches the RFC.
5. Use `Rejected` or `Superseded` when the proposal is not adopted or is
   replaced by a later RFC.

An accepted RFC records a design decision; it does not replace implementation
tests or code review. Material changes to an accepted RFC should be made
through a new RFC that identifies the document it supersedes.

## Required sections

Each RFC should include:

- metadata, summary, and motivation;
- goals and non-goals;
- detailed design and state invariants;
- security considerations and backward compatibility;
- drawbacks and alternatives considered;
- unresolved questions;
- test and rollout plans.

RFCs use the same Review Bridge and GitHub review gates as code changes.
