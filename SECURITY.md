# Security policy

## Supported versions

Only the latest `0.6.x` release receives security fixes.

## Reporting a vulnerability

Use
[GitHub private vulnerability reporting](https://github.com/fengjiachun/review-bridge/security/advisories/new).
Do not open a public issue containing vulnerability details, credentials,
private repository content, or Review Bridge store data.

If private reporting is unavailable, contact the maintainer through the
[GitHub profile](https://github.com/fengjiachun) without including sensitive
details and request a private reporting channel.

Useful reports include affected versions, impact, reproduction steps, and a
minimal proof of concept with secrets and proprietary code removed.

## Security boundaries

Review Bridge provides workflow attestations, not a Git or GitHub security
boundary. Its sensitive surfaces include snapshot integrity, repository path
validation, author/reviewer capability separation, private store permissions,
and release archive contents.

The selected reviewer client may send source returned by Review Bridge tools
to its model provider. Apply the relevant account and organization data policy
before reviewing confidential code.
