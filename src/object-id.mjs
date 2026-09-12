// Git names an object with 40 hex characters in a sha1 repository and 64 in a
// repository created with --object-format=sha256. Every id Review Bridge reads
// from the local repository may be either width, so the local guards decide
// through one judge here instead of each spelling a width of its own.
//
// Ids that arrive from the GitHub API keep their own 40-only guards: GitHub
// hosts no sha256 repository, so a 64-character id in a feed is malformed
// rather than wide.
const LOCAL_OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const LOCAL_OBJECT_ID_DESCRIPTION =
  "a 40- or 64-character lowercase Git object id";

export function isLocalObjectId(value) {
  return typeof value === "string" && LOCAL_OBJECT_ID_RE.test(value);
}
