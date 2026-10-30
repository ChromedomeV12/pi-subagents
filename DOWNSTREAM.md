# Personal Downstream

Fork of Nico Bailon's MIT-licensed pi-subagents, based on v0.84.0.
History, attribution and execution machinery are preserved. The personal branch
is maintained downstream; main remains the upstream reference branch.

## Changes

- src/personal/index.ts is the default extension entry. Retained commands: run,
  subagents, subagents-fleet, subagents-detach, subagents-doctor, subagents-guide
  and internal subagents-inspect-rpc.
- Native fleet controls remain: stop, steer and inspect. Inline accounting and
  Ctrl+G cost details are added without a second manager.
- The native role editor shows scout/planner/worker/reviewer with effective
  models and thinking. Existing save handlers are retained.
- Role discovery imports this repository's modules directly, removing the
  private node_modules path lookup from dotfiles.

Upstream Pi role prompts, model choices, Herdr configuration and child guard
registration remain operator configuration in dotfiles. No personal settings,
keys or session data belong in this public fork. Upstream index.ts is unchanged.

## Updates

1. Fetch upstream and review changes since v0.84.0 (or the last merged release).
2. Merge a selected release into a temporary branch from personal.
3. Use pnpm install, pnpm typecheck, pnpm test:unit, pnpm test:integration
   and pnpm build:pkg. Commit the lockfile.
4. Run dotfiles checks and the deployed Pi fleet/editor smoke. For lifecycle
   changes also test live spawning, results, steering, stopping and Herdr attach.
5. Push a reviewed commit, build and attach the package to a versioned GitHub
   release. Pin dotfiles to that release URL; the lockfile records integrity.
   Record its source commit and keep the previous version for rollback.

The build:pkg script builds dist-pkg, the bundled package consumed by dotfiles.
No registry publishing is configured. Package-owned UI adapters live here;
dotfiles only selects the version, supplies configuration and tests integration.
