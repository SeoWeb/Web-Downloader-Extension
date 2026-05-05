export function validateRedirect(redirect: string | null): string {
  if (!redirect) return "/app";
  if (!redirect.startsWith("/")) return "/app";
  if (redirect.startsWith("//")) return "/app";
  if (redirect.includes("://")) return "/app";
  return redirect;
}
