// Git names an object with 40 hex characters in a sha1 repository and 64 in a
// repository created with --object-format=sha256. Only the readers a sha256
// repository can reach before the remote path refuses it by name decide
// through this judge: the local gate a local review mints, and the base and
// head `authorize_remote_publication` is handed. Everything past that refusal
// -- publications, workflows, their bindings, the scorecard -- is sha1 by
// construction and keeps a 40-only guard, so a 64-character id there is
// malformed rather than wide.
const LOCAL_OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const LOCAL_OBJECT_ID_DESCRIPTION =
  "a 40- or 64-character lowercase Git object id";

export function isLocalObjectId(value) {
  return typeof value === "string" && LOCAL_OBJECT_ID_RE.test(value);
}

const FULL_SHA_RE = /^[0-9a-f]{40}$/;

// The 40-only guard past that refusal. The type check is not decoration:
// RegExp.test coerces its argument, so ["<40 hex>"] would pass the bare regex.
export function isFullSha(value) {
  return typeof value === "string" && FULL_SHA_RE.test(value);
}
