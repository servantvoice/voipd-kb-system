/**
 * CF Access JWT verification and role management.
 *
 * The Worker sits behind Cloudflare Access which adds a signed JWT
 * in the `CF_Authorization` cookie.  For now we base64url-decode the
 * payload to extract the email claim.  A future iteration should
 * verify the signature against the CF Access public-key endpoint.
 */

import type { Env } from "./index";

export interface UserContext {
  email: string;
  role: "admin" | "editor" | "viewer";
}

/** Base64url decode (no padding required). */
function base64urlDecode(input: string): string {
  let base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  // Pad to multiple of 4
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  return atob(base64);
}

/**
 * Read the CF_Authorization cookie, decode the JWT payload, and
 * return a UserContext with role information.
 *
 * Returns `null` when no valid token is present (should not happen
 * behind CF Access, but handled defensively).
 */
export async function verifyAccessJwt(
  request: Request,
  env: Env,
): Promise<UserContext | null> {
  const cookieHeader = request.headers.get("Cookie") ?? "";
  const match = cookieHeader.match(/CF_Authorization=([^\s;]+)/);
  if (!match) return null;

  try {
    const token = match[1];
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const payload = JSON.parse(base64urlDecode(parts[1]));
    const email: string | undefined = payload.email;
    if (!email) return null;

    const role = getUserRole(email, env);
    return { email, role };
  } catch {
    return null;
  }
}

/** Determine role based on environment variable lists. */
export function getUserRole(
  email: string,
  env: Env,
): "admin" | "editor" | "viewer" {
  try {
    const admins: string[] = JSON.parse(env.ADMIN_EMAILS);
    if (admins.includes(email.toLowerCase())) return "admin";
  } catch {
    /* ignore parse errors */
  }

  // Check explicit viewer list (read-only access)
  try {
    const viewers: string[] = JSON.parse(env.VIEWER_EMAILS || "[]");
    if (viewers.includes(email.toLowerCase())) return "viewer";
  } catch {
    /* ignore parse errors */
  }

  // Default: any authenticated user who isn't admin or viewer is an editor.
  // All editors can propose edits; only admins can approve.
  return "editor";
}
