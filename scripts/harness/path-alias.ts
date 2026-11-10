/**
 * Spellings of one directory. The classifier matches the repo root and the home directory as text, so a path
 * that names the same directory another way slips past: macOS and Windows file systems ignore case
 * (`/USERS/ME/REPO`), the boot volume's firmlink is `/System/Volumes/Data/Users/me`, and `/tmp`, `/var` and
 * `/etc` are `/private/tmp`, `/private/var` and `/private/etc`. Folding all three is text work, linear and with
 * no file-system call. It is also the direction that fails safe: a path wrongly read as inside the root asks.
 * (A symlink inside a path is another matter: it cannot be read from the text, and is a documented limit.)
 */

const FIRMLINK = /^\/system\/volumes\/data(?=\/|$)/i;
const PRIVATE_LINK = /^\/private(?=\/(?:tmp|var|etc)(?:\/|$))/i;

/** A path with the firmlink prefix removed and `/private` taken off `/tmp`, `/var` and `/etc`, lower case. */
function fold(path: string): string {
  const unlinked = path.replace(FIRMLINK, "").replace(PRIVATE_LINK, "");
  return (unlinked === "" ? "/" : unlinked).toLowerCase();
}

/** How many characters of `path` the folded text `fold(path)` dropped from its front. */
const dropped = (path: string): number =>
  path.length - path.replace(FIRMLINK, "").replace(PRIVATE_LINK, "").length;

/**
 * The part of `path` below `base` (`""` for `base` itself), whatever spelling of the two is used; null when
 * `path` is elsewhere. The rest keeps the spelling it was written in. Both are absolute and collapsed, and
 * `base` is a directory below the file-system root (the classifier never asks about `/` itself).
 */
export function relativeTo(path: string, base: string): string | null {
  const folded = fold(path);
  const head = fold(base);
  if (!folded.startsWith(head)) return null;
  if (folded.length === head.length) return "";
  if (folded[head.length] !== "/") return null;
  return path.slice(dropped(path) + head.length + 1);
}
