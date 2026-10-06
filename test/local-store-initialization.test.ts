import { expect, it } from "bun:test";

it("initializes the default store before concurrent reads and writes", () => {
  // A fresh process isolates module-level initialization from other singleton tests.
  const fixture = new URL("./fixtures/local-store-initialization.fixture.ts", import.meta.url).pathname;
  const result = Bun.spawnSync([process.execPath, "test", fixture], {
    stdout: "pipe", stderr: "pipe", timeout: 10000,
  });
  expect(new TextDecoder().decode(result.stderr)).toContain("1 pass");
  expect(result.exitCode).toBe(0);
});
