// The two store writes the release-evidence tooling makes. Both are the same
// no-overwrite write, and a second copy of it would be a second chance to lose
// that property: the collector's observation and the verifier's record each
// exist to be the frozen thing a later run cannot quietly replace.

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export function digestOf(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * Create the file or fail. The caller sees EEXIST rather than a silently
 * replaced file, and the directory entry is durable before the write is
 * reported.
 */
export async function writeNoOverwrite(filePath, bytes) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fsp.writeFile(filePath, bytes, { flag: "wx", mode: 0o600 });
  const directory = await fsp.open(path.dirname(filePath), fs.constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/**
 * Store bytes under their own digest.
 *
 * A re-run's fresh collection lands under its own name and can never replace
 * the bytes an existing record references. Identical content is idempotent,
 * because the name is the content -- and a file that does not hash to the name
 * it is stored under is refused rather than reused, since it is no longer the
 * evidence the name claims.
 */
export async function writeContentAddressed(directory, bytes) {
  const digest = digestOf(bytes);
  const filePath = path.join(directory, `${digest}.json`);
  try {
    await writeNoOverwrite(filePath, bytes);
    return { path: filePath, sha256: digest, reused: false };
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }
  if (digestOf(await fsp.readFile(filePath)) !== digest) {
    throw new Error(
      `${filePath} does not hash to the name it is stored under; the stored file is damaged`,
    );
  }
  return { path: filePath, sha256: digest, reused: true };
}
