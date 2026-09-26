import ky, { HTTPError } from "ky";
import type { RefreshTokenResponse } from "@/features/auth";
import {
  clearAccessToken,
  clearRefreshToken,
  getAccessToken,
  getRefreshToken,
  setAccessToken,
  setRefreshToken,
} from "@/features/auth";

let refreshPromise: Promise<boolean> | null = null;

// Use fetch directly to avoid interceptor loops
async function requestNewTokens(): Promise<RefreshTokenResponse> {
  const storedRefreshToken = getRefreshToken();

  if (!storedRefreshToken) {
    throw new Error("No refresh token available");
  }

  const response = await fetch("/api/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: storedRefreshToken }),
  });

  if (!response.ok) {
    throw new Error("Failed to refresh token");
  }

  return response.json();
}

function signOut(): void {
  clearAccessToken();
  clearRefreshToken();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("auth:unauthorized"));
  }
}

async function runRefresh(): Promise<boolean> {
  try {
    const tokens = await requestNewTokens();
    setAccessToken(tokens.access_token);
    setRefreshToken(tokens.refresh_token);
    return true;
  } catch {
    signOut();
    return false;
  } finally {
    refreshPromise = null;
  }
}

export function refreshAccessToken(): Promise<boolean> {
  refreshPromise ??= runRefresh();
  return refreshPromise;
}

export const api = ky.create({
  prefix: "/",
  timeout: 30000,
  hooks: {
    beforeRequest: [
      ({ request }) => {
        const token = getAccessToken();
        if (token) {
          request.headers.set("Authorization", `Bearer ${token}`);
        }
      },
    ],
    beforeError: [
      ({ error }) => {
        // Show the server's own message when it sends one.
        if (error instanceof HTTPError) {
          const { message } = (error.data ?? {}) as {
            message?: string | string[];
          };
          if (message) {
            error.message = Array.isArray(message)
              ? message.join(", ")
              : message;
          }
        }
        return error;
      },
    ],
    afterResponse: [
      async ({ request, response }) => {
        if (response.status !== 401) {
          return response;
        }

        if (request.url.includes("/api/auth/refresh")) {
          signOut();
          return response;
        }

        if (!(await refreshAccessToken())) {
          return response;
        }

        request.headers.set("Authorization", `Bearer ${getAccessToken()}`);
        return ky(request);
      },
    ],
  },
});
