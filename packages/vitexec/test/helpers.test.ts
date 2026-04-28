import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildVitexecUrl,
  uploadCode,
  VITEXEC_PARAM,
  VITEXEC_UPLOAD_ROUTE
} from "../src/index.js";

describe("vitexec helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds a load URL while preserving the base URL", () => {
    const url = buildVitexecUrl("http://localhost:5173/app?x=1#view", "abc 123");

    expect(url).toBe("http://localhost:5173/app?x=1&__vitexec=abc+123#view");
    expect(new URL(url).searchParams.get(VITEXEC_PARAM)).toBe("abc 123");
  });

  it("uploads raw code to the expected dev API route", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await uploadCode("http://localhost:5173/app?ignored=1", "run-1", "console.log(1)");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      `http://localhost:5173${VITEXEC_UPLOAD_ROUTE}/run-1`
    );
    expect(init).toMatchObject({
      method: "POST",
      body: "console.log(1)"
    });
  });

  it("throws when uploading fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500, statusText: "Nope" }))
    );

    await expect(uploadCode("http://localhost:5173/", "run-1", "")).rejects.toThrow(
      'Could not upload code "run-1" to http://localhost:5173: 500 Nope'
    );
  });
});
