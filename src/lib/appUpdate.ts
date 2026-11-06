/** Decide whether a running shell should load a newer HTML document.
 *  A reload keeps localStorage. It never clears learning data or the personal corpus. */

const RELOAD_KEY = "musk-atlas:reload-for";

export function reloadTarget(runningSrc: string, remoteJs: string, alreadyTried: string | null): string | null {
  const remote = remoteJs.trim();
  if (!remote || remote.includes("..") || /[\s"'<>]/.test(remote)) return null;
  if (!remote.endsWith(".js")) return null;
  if (runningSrc.includes(remote)) return null;
  if (alreadyTried === remote) return null;
  return remote;
}

export function nextDocumentUrl(href: string, remoteJs: string): string {
  const url = new URL(href);
  const file = remoteJs.split("/").pop() || remoteJs;
  url.searchParams.set("v", file.replace(/[^a-zA-Z0-9._-]/g, ""));
  return url.toString();
}

/** If version.json names a different script, replace the document once. Storage is left untouched. */
export async function watchAppUpdate(fetchImpl: typeof fetch = fetch): Promise<void> {
  if (typeof document === "undefined") return;
  const base = import.meta.env.BASE_URL || "/";
  const current = document.querySelector('script[type="module"]')?.getAttribute("src") || "";
  let remote = "";
  try {
    const res = await fetchImpl(`${base}version.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { js?: unknown };
    remote = typeof data.js === "string" ? data.js : "";
  } catch {
    return;
  }
  const already = sessionStorage.getItem(RELOAD_KEY);
  const target = reloadTarget(current, remote, already);
  if (!target) return;
  sessionStorage.setItem(RELOAD_KEY, target);
  location.replace(nextDocumentUrl(location.href, target));
}
