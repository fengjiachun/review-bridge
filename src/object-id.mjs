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

// One review is one repository, and a repository has one object-id width. A
// ledger carrying both widths describes two repositories, which no sequence of
// operations can produce -- it can only have been spliced together outside the
// store. The scope pins the first width a validation pass admits and refuses
// every later id of the other width, so the rule holds over whatever fields
// that pass reads rather than over a list of field names kept in step by hand.
export function createObjectIdWidthScope() {
  let width = null;
  return {
    admit(value) {
      if (width == null) {
        width = value.length;
        return true;
      }
      return value.length === width;
    },
    get width() {
      return width;
    },
  };
}
