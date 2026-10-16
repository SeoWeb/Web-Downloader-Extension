export function validateRedirect(redirect: string | null): string {
  if (!redirect) return "/app";
  if (!redirect.startsWith("/")) return "/app";
  if (redirect.startsWith("//")) return "/app";
  if (redirect.includes("://")) return "/app";
  // Some URL parsers treat a backslash as a path separator: "/\evil.com"
  // normalizes to "//evil.com" (protocol-relative) and escapes the origin.
  // Reject any backslash outright (open-redirect bypass).
  if (redirect.includes("\\")) return "/app";
  return redirect;
}
