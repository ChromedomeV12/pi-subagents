import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";

type Usage = { input: number; output: number; cost: number };
export type CostReport = { version: 1; parent: Usage; childTotal: Usage; total: Usage;
  children: { label: string; usage: Usage }[]; unresolvedAsyncChildren: number };
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const usage = (value: unknown): value is Usage => record(value) && finite(value.input) && finite(value.output) && finite(value.cost);

/** Validate Nico's versioned accounting response. */
export function parseCostReport(value: unknown): CostReport {
  if (!record(value) || value.version !== 1 || !usage(value.parent) || !usage(value.childTotal) || !usage(value.total)
    || !finite(value.unresolvedAsyncChildren) || !Array.isArray(value.children)
    || !value.children.every(child => record(child) && typeof child.label === "string" && usage(child.usage))) throw new Error("Unsupported subagent cost response.");
  return value as CostReport;
}

/** Bounded cost RPC, canceled when its owning fleet closes. */
export class FleetCostRpc {
  private readonly pending = new Set<() => void>();
  private readonly events: ExtensionAPI["events"];
  private readonly timeout: number;
  constructor(events: ExtensionAPI["events"], timeout = 5000) {
    this.events = events;
    this.timeout = timeout;
  }
  request(): Promise<CostReport> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const finish = (error?: Error, value?: CostReport) => {
        clearTimeout(timer); unsubscribe(); this.pending.delete(cancel);
        if (error) reject(error); else resolve(value!);
      };
      const cancel = () => finish(new Error("Fleet closed."));
      const unsubscribe = this.events.on(`subagents:rpc:v1:reply:${id}`, value => {
        if (!record(value) || value.version !== 1 || value.requestId !== id) return;
        try {
          if (value.success !== true) throw new Error(record(value.error) && typeof value.error.message === "string" ? value.error.message : "Cost request failed.");
          finish(undefined, parseCostReport(value.data));
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      });
      const timer = setTimeout(() => finish(new Error("Cost request timed out.")), this.timeout);
      this.pending.add(cancel);
      try { this.events.emit("subagents:rpc:v1:request", { version: 1, requestId: id, method: "cost", source: { extension: "personal-fleet-costs" } }); }
      catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  dispose(): void { for (const cancel of this.pending) cancel(); }
}

const plain = (value: string) => stripVTControlCharacters(value).replace(/[\r\n\t]/g, " ");
const cost = (name: string, value: Usage) => `${name}: $${value.cost.toFixed(4)} | ${value.input.toLocaleString()} in / ${value.output.toLocaleString()} out`;

/** Add a cost row and cost view to the upstream fleet without replacing its controls. */
export function enhanceFleet(component: Component, theme: Theme, render: () => void, rpc: Pick<FleetCostRpc, "request" | "dispose">): Component {
  let report: CostReport | undefined;
  let notice = "Loading costs";
  let costsOpen = false;
  let offset = 0;
  let pageHeight = 1;
  let busy = false;
  let disposed = false;
  const refresh = async () => {
    if (busy || disposed) return;
    busy = true;
    try { report = await rpc.request(); notice = ""; }
    catch (error) { notice = error instanceof Error ? error.message : "Costs unavailable"; }
    finally { busy = false; if (!disposed) render(); }
  };
  void refresh();
  return new Proxy(component, {
    get(target, property) {
      if (property === "render") return (width: number) => {
        const native = target.render(width);
        const inner = Math.max(0, width - 2);
        const frame = (text: string) => {
          const fitted = truncateToWidth(text, inner);
          return theme.fg("border", "│") + fitted + " ".repeat(Math.max(0, inner - visibleWidth(fitted))) + theme.fg("border", "│");
        };
        if (!costsOpen) {
          const summary = report ? `Total $${report.total.cost.toFixed(4)} · Parent $${report.parent.cost.toFixed(4)} · Workers $${report.childTotal.cost.toFixed(4)} · ${report.unresolvedAsyncChildren} unresolved` : plain(notice);
          return [...native.slice(0, 2), frame(theme.fg("dim", ` Ctrl+G costs · ${summary}`)), ...native.slice(2)];
        }
        const lines = report ? [cost("Parent", report.parent), ...report.children.map(child => cost(plain(child.label), child.usage)),
          cost("Children", report.childTotal), cost("Total", report.total), `${report.unresolvedAsyncChildren} children with unresolved accounting.`,
          "Catalog-price estimates; $0 does not prove free operation."] : [plain(notice)];
        pageHeight = Math.max(1, native.length - 5);
        offset = Math.max(0, Math.min(offset, Math.max(0, lines.length - pageHeight)));
        const divider = theme.fg("border", `├${"─".repeat(inner)}┤`);
        return [native[0], frame(theme.bold(" Subagent fleet · Costs")), divider,
          ...Array.from({ length: pageHeight }, (_, index) => frame(` ${lines[offset + index] ?? ""}`)), divider,
          frame(theme.fg("dim", " Up/Down scroll · r refresh · Ctrl+G/Esc back to fleet")), native.at(-1)!];
      };
      if (property === "handleInput") return (data: string) => {
        if (matchesKey(data, "ctrl+g")) { costsOpen = !costsOpen; if (costsOpen) void refresh(); render(); return; }
        if (!costsOpen) { target.handleInput?.(data); return; }
        if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") costsOpen = false;
        else if (matchesKey(data, "down") || data === "j") offset++;
        else if (matchesKey(data, "up") || data === "k") offset = Math.max(0, offset - 1);
        else if (matchesKey(data, "pageDown")) offset += pageHeight;
        else if (matchesKey(data, "pageUp")) offset = Math.max(0, offset - pageHeight);
        else if (data === "r") void refresh();
        render();
      };
      if (property === "dispose") return () => { disposed = true; rpc.dispose(); (target as Component & { dispose?(): void }).dispose?.(); };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Retain the original fleet handler and overlay, decorating only its component. */
export function withFleetCosts(pi: ExtensionAPI, command: Command): Command {
  const active = new Set<FleetCostRpc>();
  const close = () => { for (const rpc of active) rpc.dispose(); active.clear(); };
  pi.on("session_start", close);
  pi.on("session_shutdown", close);
  return { ...command, description: "Live subagent fleet: monitor, steer, stop, inspect and view costs", handler: async (args, ctx) => {
    const custom: typeof ctx.ui.custom = (factory, options) => ctx.ui.custom(async (tui, theme, keys, done) => {
      const terminal = new Proxy(tui.terminal, { get(target, property) {
        if (property === "rows") return Math.max(8, target.rows - 1);
        const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      } });
      const fleetTui = new Proxy(tui, { get(target, property) {
        if (property === "terminal") return terminal;
        const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      } });
      const component = await factory(fleetTui, theme, keys, done);
      const rpc = new FleetCostRpc(pi.events);
      active.add(rpc);
      return enhanceFleet(component, theme, () => tui.requestRender(), rpc);
    }, options);
    const ui = new Proxy(ctx.ui, { get(target, property) { if (property === "custom") return custom;
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value; } });
    const context = new Proxy(ctx, { get(target, property) { if (property === "ui") return ui;
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value; } }) as ExtensionCommandContext;
    try { await command.handler(args, context); }
    finally { close(); }
  } };
}
