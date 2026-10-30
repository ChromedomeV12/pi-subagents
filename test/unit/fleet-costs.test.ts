import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { visibleWidth } from "@earendil-works/pi-tui";
import { limitedCommands, SUBAGENT_COMMANDS } from "../../src/personal/index.ts";
import { enhanceFleet, FleetCostRpc, parseCostReport } from "../../src/personal/fleet.ts";

const usage = { input: 10, output: 20, cost: 0.01 };
const report = { version: 1 as const, parent: usage, childTotal: usage, total: { ...usage, cost: .02 }, children: [{ label: "worker", usage }], unresolvedAsyncChildren: 0 };
const theme = { bold: (text: string) => text, fg: (_color: string, text: string) => text } as any;
function events() {
  const bus = new EventEmitter();
  return { bus, api: { on(name: string, handler: (data: unknown) => void) { bus.on(name, handler); return () => { bus.off(name, handler); }; }, emit(name: string, data: unknown) { bus.emit(name, data); } } };
}

test("slash wrapper retains original non-fleet commands and integrates cost, stop and steer into fleet", () => {
  const commands = new Map<string, any>();
  const api = { registerCommand: (name: string, command: any) => commands.set(name, command), on() {} } as any;
  const wrapped = limitedCommands(api);
  const original = { description: "Original", handler: async () => {} };
  for (const name of [...SUBAGENT_COMMANDS, "subagents-models", "subagent-cost", "subagents-stop", "subagents-steer", "subagents-watchdog"]) wrapped.registerCommand(name, original);
  assert.deepEqual([...commands.keys()], [...SUBAGENT_COMMANDS]);
  assert.notEqual(commands.get("subagents"), original);
  assert.equal(commands.get("subagents-detach"), original);
  assert.notEqual(commands.get("subagents-fleet"), original);
});

test("cost RPC validates, correlates, times out and disposes pending listeners", async () => {
  assert.deepEqual(parseCostReport(report), report);
  assert.throws(() => parseCostReport({ ...report, total: { ...usage, cost: NaN } }));
  const e = events();
  e.bus.on("subagents:rpc:v1:request", request => {
    e.api.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: "wrong", success: true, data: {} });
    e.api.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, success: true, data: report });
  });
  assert.deepEqual(await new FleetCostRpc(e.api).request(), report);
  assert.equal(e.bus.eventNames().length, 1);
  const silent = events();
  const rpc = new FleetCostRpc(silent.api, 5);
  await assert.rejects(rpc.request(), /timed out/);
  const pending = rpc.request();
  rpc.dispose();
  await assert.rejects(pending, /closed/);
  assert.equal(silent.bus.eventNames().length, 0);
});

test("fleet decorator preserves native input, stop, steer, rendering and lifecycle", async () => {
  const input: string[] = [];
  let disposed = 0;
  let canceled = 0;
  let refreshes = 0;
  const native = { render: (width: number) => ["+".repeat(width), "Subagent fleet inspector", "+".repeat(width), "native transcript", "+".repeat(width), "s steer | D stop", "+".repeat(width)],
    handleInput: (data: string) => input.push(data), invalidate() {}, dispose() { disposed++; } };
  const enhanced = enhanceFleet(native, theme, () => {}, { request: async () => { refreshes++; return report; }, dispose: () => { canceled++; } });
  await Promise.resolve();
  for (const width of [30, 50, 80, 120]) {
    const lines = enhanced.render(width);
    assert.ok(lines.some(line => line.includes("Ctrl+G costs")));
    if (width >= 80) assert.ok(lines.some(line => line.includes("Parent $")));
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
  }
  enhanced.handleInput!("s"); enhanced.handleInput!("D"); enhanced.handleInput!("c"); enhanced.handleInput!("typing a message");
  assert.deepEqual(input, ["s", "D", "c", "typing a message"]);
  enhanced.handleInput!("\x07");
  assert.ok(enhanced.render(80).some(line => line.includes("Costs")));
  enhanced.handleInput!("r");
  enhanced.handleInput!("\x1b");
  assert.ok(enhanced.render(80).some(line => line.includes("native transcript")));
  (enhanced as typeof native).dispose();
  assert.equal(disposed, 1); assert.equal(canceled, 1); assert.ok(refreshes >= 2);
});

test("closing the fleet does not render late cost responses", async () => {
  let complete!: (value: typeof report) => void;
  let renders = 0;
  const enhanced = enhanceFleet({ render: () => [], invalidate() {} }, theme, () => { renders++; },
    { request: () => new Promise(resolve => { complete = resolve; }), dispose() {} });
  (enhanced as typeof enhanced & { dispose(): void }).dispose();
  complete(report);
  await Promise.resolve();
  assert.equal(renders, 0);
});
