import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configuredRoleViews, CONFIGURED_ROLES, roleSelectorItems, withRoleOverview } from "../../src/personal/definitions.ts";

test("role overview prunes disabled/unused roles and preserves native selector values", () => {
  const views = [{ name: "worker", source: "user", filePath: "/agents/worker.md", model: "test/parent", modelSetting: "inherit session model", thinking: "default / unset" }];
  const items = [{ value: "worker [user] — implementation", label: "old" }, { value: "worker [builtin] — builtin", label: "builtin" },
    { value: "oracle [builtin] — not selected", label: "oracle" }];
  const output = roleSelectorItems(items, views)!;
  assert.equal(output.length, 1);
  assert.equal(output[0].value, items[0].value);
  assert.match(output[0].label, /test\/parent.*default \/ unset/);
  assert.equal(roleSelectorItems([{ value: "test/model", label: "model" }], views), undefined);
  assert.equal(items[0].label, "old");
  assert.deepEqual(roleSelectorItems([...items, { ...items[0], value: `${items[0].value} · /agents/other.md` }], views), []);
});

test("combined editor uses upstream model resolution, four roles and original save handlers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-role-config-test-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  try {
    await mkdir(join(directory, "agents"));
    await writeFile(join(directory, "settings.json"), JSON.stringify({ subagents: { disableBuiltins: true } }));
    for (const role of CONFIGURED_ROLES) await writeFile(join(directory, "agents", `${role}.md`), `---\nname: ${role}\ndescription: Fixture ${role}\n${role === "worker" ? "model: test/worker\nthinking: high\n" : ""}---\nOriginal prompt.\n`);
    const ctx = { cwd: directory, isProjectTrusted: () => true, hasUI: true, mode: "tui", model: { provider: "test", id: "parent" },
      modelRegistry: { getAvailable: () => [] }, ui: { notify() {}, select: async (title: string) => { titles.push(title); return "Done"; } } } as any;
    const titles: string[] = [];
    const views = await configuredRoleViews(ctx);
    assert.deepEqual(views.map(view => view.name), [...CONFIGURED_ROLES]);
    assert.equal(views.find(view => view.name === "worker")?.model, "test/worker");
    assert.equal(views.find(view => view.name === "worker")?.thinking, "high");
    assert.equal(views.find(view => view.name === "scout")?.model, "test/parent");
    assert.equal(views.find(view => view.name === "scout")?.modelSetting, "inherit session model");
    let calls = 0;
    const wrapped = withRoleOverview({ description: "Upstream editor", handler: async (args, inner) => {
      calls++; assert.equal(args, "worker model");
      await inner.ui.select("Administer worker\nOriginal summary", ["Change model", "Done"]);
    } });
    await wrapped.handler("worker model", ctx);
    assert.equal(calls, 1);
    assert.match(titles[0], /Model: test\/worker/);
    assert.match(titles[0], /Thinking: high/);
    await wrapped.handler("oracle", ctx);
    assert.equal(calls, 1);
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
    await rm(directory, { recursive: true, force: true });
  }
});
