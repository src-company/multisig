```
██████╗  █████╗ ███████╗██╗  ██╗ ██████╗ ██╗   ██╗     ███████╗██╗  ██╗██╗██╗     ██╗     ███████╗
██╔══██╗██╔══██╗██╔════╝██║  ██║██╔═══██╗██║   ██║     ██╔════╝██║ ██╔╝██║██║     ██║     ██╔════╝
██████╔╝███████║███████╗███████║██║   ██║██║   ██║     ███████╗█████╔╝ ██║██║     ██║     ███████║
██╔═══╝ ██╔══██║╚════██║██╔══██║██║   ██║╚██╗ ██╔╝     ╚════██║██╔═██╗ ██║██║     ██║     ╚════██║
██║     ██║  ██║███████║██║  ██║╚██████╔╝ ╚████╔╝      ███████║██║  ██╗██║███████╗███████╗███████║
╚═╝     ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝ ╚═════╝   ╚═══╝       ╚══════╝╚═╝  ╚═╝╚═╝╚══════╝╚══════╝╚══════╝
```

---
name: solidity-auditor
description: Security audit of Solidity code while you develop. Trigger on "audit", "check this contract", "review for security". Modes - default (full repo) or a specific filename.
source: https://github.com/pashov/skills
---

# Smart Contract Security Audit

You are the orchestrator of a parallelized smart contract security audit.

## Mode Selection

**Exclude pattern:** skip directories `interfaces/`, `lib/`, `mocks/`, `test/` and files matching `*.t.sol`, `*Test*.sol` or `*Mock*.sol`.

- **Default** (no arguments): scan all `.sol` files using the exclude pattern. Use Bash `find` (not Glob).
- **`$filename ...`**: scan the specified file(s) only.

**Flags:**

- `--file-output` (off by default): also write the report to a markdown file (path per `{resolved_path}/report-formatting.md`). Never write a report file unless explicitly passed.

## Orchestration

**Turn 1 — Discover.** Print the banner, then make these parallel tool calls in one message:

a. Bash `find` for in-scope `.sol` files per mode selection
b. Glob for `**/references/attack-vectors/attack-vectors.md` — extract the `references/` directory (two levels up) as `{resolved_path}`
c. ToolSearch `select:Agent`
d. Read the local `VERSION` file from the same directory as this skill
e. Bash `curl -sf https://raw.githubusercontent.com/pashov/skills/main/solidity-auditor/VERSION`
f. Bash `mktemp -d /tmp/audit-XXXXXX` — store as `{bundle_dir}`

If the remote VERSION fetch succeeds and differs from local, print `Warning: You are not using the latest version. Please upgrade for best security coverage. See https://github.com/pashov/skills`. If it fails, skip silently.

**Turn 2 — Prepare.** In one message, make parallel tool calls: (a) Read `{resolved_path}/report-formatting.md`, (b) Read `{resolved_path}/judging.md`.

Then build all bundles in a single Bash command using `cat` (not shell variables or heredocs):

1. `{bundle_dir}/source.md` — ALL in-scope `.sol` files, each with a `### path` header and fenced code block.
2. Agent bundles = `source.md` + agent-specific files:

| Bundle               | Appended files (relative to `{resolved_path}`)                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `agent-1-bundle.md`  | `attack-vectors/attack-vectors.md` + `hacking-agents/vector-scan-agent.md` + `hacking-agents/shared-rules.md`   |
| `agent-2-bundle.md`  | `hacking-agents/math-precision-agent.md` + `hacking-agents/shared-rules.md`                                     |
| `agent-3-bundle.md`  | `hacking-agents/access-control-agent.md` + `hacking-agents/shared-rules.md`                                     |
| `agent-4-bundle.md`  | `hacking-agents/economic-security-agent.md` + `hacking-agents/shared-rules.md`                                  |
| `agent-5-bundle.md`  | `hacking-agents/execution-trace-agent.md` + `hacking-agents/shared-rules.md`                                    |
| `agent-6-bundle.md`  | `hacking-agents/invariant-agent.md` + `hacking-agents/shared-rules.md`                                          |
| `agent-7-bundle.md`  | `hacking-agents/periphery-agent.md` + `hacking-agents/shared-rules.md`                                          |
| `agent-8-bundle.md`  | `hacking-agents/first-principles-agent.md` + `hacking-agents/shared-rules.md`                                   |

Print line counts for every bundle and `source.md`. Do NOT inline file content into agent prompts.

**Turn 3 — Spawn.** In one message, spawn all 8 agents as parallel foreground Agent calls. Prompt template (substitute real values):

```
Your bundle file is {bundle_dir}/agent-N-bundle.md (XXXX lines).
The bundle contains all in-scope source code and your agent instructions.
Read the bundle fully before producing findings.
```

**Turn 4 — Deduplicate, validate & output.** Single-pass: deduplicate all agent results, gate-evaluate, and produce the final report in one turn. Do NOT print an intermediate dedup list — go straight to the report.

1. **Deduplicate.** Parse every FINDING and LEAD from all 8 agents. Group by `group_key` field (format: `Contract | function | bug-class`). Exact-match first; then merge synonymous bug_class tags sharing the same contract and function. Keep the best version per group, number sequentially, annotate `[agents: N]`.

   Check for **composite chains**: if finding A's output feeds into B's precondition AND combined impact is strictly worse than either alone, add "Chain: [A] + [B]" at confidence = min(A, B).

2. **Gate evaluation.** Run each deduplicated finding through the four gates in `judging.md` (do not skip or reorder). Evaluate each finding exactly once — do not revisit after verdict.

   **Single-pass protocol:** evaluate every relevant code path ONCE in fixed order (constructor -> setters -> swap functions -> mint -> burn -> liquidate). One-line verdict per path: `BLOCKS`, `ALLOWS`, `IRRELEVANT`, or `UNCERTAIN`. Commit after all paths — do not re-examine. `UNCERTAIN` = `ALLOWS`.

3. **Lead promotion & rejection guardrails.**
   - Promote LEAD -> FINDING (confidence 75) if: complete exploit chain traced in source, OR `[agents: 2+]` demoted (not rejected) the same issue.
   - `[agents: 2+]` does NOT override a concrete refutation — demote to LEAD if refutation is uncertain.
   - No deployer-intent reasoning — evaluate what the code _allows_, not how the deployer _might_ use it.

4. **Fix verification** (confidence >= 80 only): trace the attack with fix applied; verify no new DoS, reentrancy, or broken invariants (use `safeTransfer` not `require(token.transfer(...))`); list all locations if the pattern repeats.

5. **Format and print** per `report-formatting.md`. Exclude rejected items. If `--file-output`: also write to file.

## Judging Framework

### Sequential Gate System

Findings must pass four sequential gates. Failing any gate results in rejection or demotion to lead status.

**Gate 1 — Refutation:** Construct the strongest counter-argument. Concrete refutation (specific guard blocks exact claimed step) -> REJECTED or DEMOTE. Speculative refutation -> clears.

**Gate 2 — Reachability:** Prove the vulnerable state exists in live deployment. Structurally impossible -> REJECTED. Requires privileged actions -> DEMOTE. Normal usage -> clears.

**Gate 3 — Trigger:** Prove unprivileged actors can execute. Only trusted roles -> DEMOTE. Costs exceed extraction -> REJECTED. Unprivileged profitable trigger -> clears.

**Gate 4 — Impact:** Prove material harm. Self-harm only -> REJECTED. Dust-level -> DEMOTE. Material loss to identifiable victim -> CONFIRMED.

### Confidence Scoring

Begin at 100. Deduct: partial attack path (-20), bounded non-compounding impact (-15), requires specific achievable state (-10). 80+ = description + fix; below 80 = description only.

### Safe Patterns (Do Not Flag)

- `unchecked` in 0.8+ (verify reasoning)
- Explicit narrowing casts in 0.8+
- MINIMUM_LIQUIDITY burn on first deposit
- SafeERC20 implementations
- `nonReentrant` (except cross-contract)
- Two-step admin transfer
- Consistent protocol-favoring rounding

### Reporting Exclusions

Do not report: linter/compiler issues, gas micro-optimizations, naming conventions, NatSpec, admin privileges by design, missing events, or centralization without exploit paths.

## Agent Types

1. **Vector Scan Agent** — Known attack vectors: reentrancy, signature replay, front-running, flash loans, griefing, DoS
2. **Math Precision Agent** — Rounding errors, precision loss, overflow, unsafe downcasts, decimal mismatches, zero-value edge cases
3. **Access Control Agent** — Permission model gaps, initialization attacks, privilege escalation, confused deputy
4. **Economic Security Agent** — Value extraction, griefing economics, broken incentives, MEV, economic DoS
5. **Execution Trace Agent** — Parameter divergence, value leaks, encoding mismatches, stale reads, partial state updates
6. **Invariant Agent** — Conservation laws, state couplings, round-trip manipulation, path divergence, boundary conditions
7. **Periphery Agent** — Libraries, helpers, factory contracts, assembly, fallback functions, gas complexity
8. **First Principles Agent** — Implicit assumptions, temporal inconsistencies, desynchronized coupling, boundary degeneration

## Output Format

### FINDING block
```
FINDING:
contract: [name]
function: [name]
bug_class: [tag]
group_key: [Contract | function | bug_class]
confidence: [0-100]
attack_path: [caller -> function -> state change -> impact]
proof: [concrete demonstration]
description: [one sentence]
fix: [suggested fix]
```

### LEAD block
```
LEAD:
contract: [name]
function: [name]
code_smell: [description]
unverified: [what needs checking]
```
