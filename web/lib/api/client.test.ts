import { describe, expect, it, vi } from "vitest";

vi.mock("@/features/auth", () => ({
  getAccessToken: () => null,
  getRefreshToken: () => null,
  setAccessToken: vi.fn(),
  setRefreshToken: vi.fn(),
  clearAccessToken: vi.fn(),
  clearRefreshToken: vi.fn(),
}));

import { api } from "./client";

function replyWith(status: number, body: string, contentType: string) {
  return api.extend({
    baseUrl: "http://anchor.test",
    fetch: () =>
      Promise.resolve(
        new Response(body, {
          status,
          headers: { "content-type": contentType },
        }),
      ),
  });
}

async function errorMessageOf(request: Promise<unknown>): Promise<string> {
  try {
    await request;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the request to fail");
}

describe("api errors", () => {
  it("show the server's message", async () => {
    const client = replyWith(
      401,
      JSON.stringify({ message: "Invalid credentials" }),
      "application/json",
    );

    expect(await errorMessageOf(client.post("api/auth/login"))).toBe(
      "Invalid credentials",
    );
  });

  it("join the server's validation messages", async () => {
    const client = replyWith(
      400,
      JSON.stringify({ message: ["email must be an email", "name is empty"] }),
      "application/json",
    );

    expect(await errorMessageOf(client.post("api/auth/register"))).toBe(
      "email must be an email, name is empty",
    );
  });

  it("keep the default message when the server sends no message", async () => {
    const client = replyWith(502, "Bad Gateway", "text/plain");

    expect(await errorMessageOf(client.post("api/notes"))).toMatch(
      /^Request failed with status code 502/,
    );
  });
});
