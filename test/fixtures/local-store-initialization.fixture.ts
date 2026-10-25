import { expect, it, spyOn } from "bun:test";
import { LocalStore, addToStore, clearStore, searchStore, searchStoreFiltered } from "../../src/local-store.js";


it("concurrent first-use reads and writes wait for the same initial load", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  // Replace disk access entirely: never touch the user's default cache.
  const load = spyOn(LocalStore.prototype, "load").mockImplementation(async function (this: LocalStore) {
    await gate;
    this.add("saved", [1, 0], { content: "old", kind: "note" });
  });
  try {
    const first = searchStore([1, 0]);
    const second = searchStoreFiltered([1, 0], (m) => m.kind === "note");
    let writeFinished = false;
    const write = addToStore("saved", [1, 0], { content: "new", kind: "note" })
      .then(() => { writeFinished = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(writeFinished).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
    release();
    const [a, b] = await Promise.all([first, second, write]);
    expect(a.map((x) => x.id)).toEqual(["saved"]);
    expect(b.map((x) => x.id)).toEqual(["saved"]);
    expect((await searchStore([1, 0]))[0].metadata.content).toBe("new");
  } finally {
    release();
    await gate;
    load.mockRestore();
    clearStore();
  }
});
