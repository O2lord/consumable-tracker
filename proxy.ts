import { NextResponse, type NextRequest } from "next/server";

// Sends visitors with no session cookie to /login before anything renders.
// This is only a fast, optimistic check: it does not prove the token is valid. Expired or revoked
// tokens are still caught by requireSession() in the (app) layout and in each page.
const ACCESS_COOKIE = "ct-access";

export function proxy(request: NextRequest) {
  if (!request.cookies.has(ACCESS_COOKIE)) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
}

// Only the signed-in app sections. /login, /api, the service worker, the manifest and static
// assets are not matched, so they stay reachable without a session.
export const config = {
  matcher: [
    "/dashboard/:path*",
    "/store/:path*",
    "/distribution/:path*",
    "/reports/:path*",
    "/admin/:path*",
    "/needs-attention/:path*",
  ],
};
