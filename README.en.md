<p align="center">
  <h1 align="center">AirCoding</h1>
</p>
<p align="center">Deterministic Multi-Agent AI Coding System</p>
<p align="center">
  <a href="http://git.airlongdian.fun/admin/AirCoding"><img alt="Gitea" src="https://img.shields.io/badge/Gitea-AirCoding-blue?style=flat-square" /></a>
  <a href="http://git.airlongdian.fun/admin/AirCoding/releases/tag/0.1.0"><img alt="Release" src="https://img.shields.io/badge/release-0.1.0-green?style=flat-square" /></a>
</p>

<p align="center">
  <a href="README.md">简体中文</a> |
  <a href="README.en.md">English</a>
</p>

---

## Overview

AirCoding is a semi-automated development agent I built based on my own workflow. Its main goal is to solve Vibe Coding's core problems — poor code quality and high model requirements — through an engineering-driven approach. The aim is to use low-cost models concurrently to complete small to medium-sized projects.

This idea has just barely gotten off the ground. Due to time constraints, the Alpha release is a fork of opencode with direct modifications. It's still constrained by opencode's framework and far from the ideal design. Bugs are plenty — I'll fix them as I find them. It works well enough for now.

When I have more free time, I'll need to build an agent from scratch. The current framework imposes too many limitations.





## Acknowledgments

Thanks to Player Xiao Zhang for calling me while I was on the toilet, which cleared my mind.

Thanks to Mr. Ran, Mr. Ze, Mr. Ding, and Mr. Zhe for enduring a 10-game losing streak in League of Legends while playing with me. This is the power of friendship and bonds — I'm going to find an Evolution Crystal to super-evolve as repayment.

Thanks in advance to Mr. Fan Xiaowen, who is currently researching Go for building agent frameworks. I plan to steal his work once he's done (doge).

---

The following is AI-generated.

## ## OOvveerrvviieeww

Core design principles:

- **Tool whitelist as hard gate**: Agent capabilities are enforced at the code level, not by prompt suggestion
- **Deterministic scheduling first**: Normal flow runs through a DAG state machine; LLM is consulted only for exceptions and edge cases
- **Two-layer review**: Worker self-verification + Reviewer Code-to-Design audit
- **Evidence-gated debugging**: cppcheck mandatory (C++ projects); must collect evidence before modifying code (DEBUG mode)
- **Anti-fallback**: Scheduler and Executor are forbidden from using "for now", "temporary solution", or any downgrade pattern to replace the design spec
- **Mandatory Reviewer**: Reviewer is not optional — every Worker output goes through a three-layer review (Code-to-Design → Static Analysis → Test Verification) before it can pass

## Architecture

```
User → Main Agent (aircoding) → dispatches
         │
         ├─→ Architect (architecture planner)
         │     Outputs: plan.md + task-graph.json + ADR + C4 docs
         │
         └─→ Scheduler (scheduling engine)
               │  coordinator_tick: deterministic DAG scheduler
               │
               ├─→ Worker (executor / debugger)
               │     EXECUTE: write code → compile → test → cppcheck
               │     DEBUG:   collect evidence → record → fix → verify
               │
               └─→ Reviewer (code reviewer)
                     Code-to-Design review against plan.md
                     Three mandatory layers:
                     1. Line-by-line Code-to-Design table
                     2. Static analysis (security / correctness / compliance)
                     3. Test / build verification
```

## Agent Permission Matrix

| Agent | Allowed Tools | Denied Tools |
|-------|--------------|--------------|
| aircoding (Main) | read, glob, grep, task, question, web, coordinator_status, coordinator_tick | write, edit, bash |
| Scheduler | read, glob, grep, task, coordinator_* | write, edit, bash |
| Worker | read, write, edit, bash, glob, grep | task |
| Architect | read, glob, grep, task, edit/write (.air/shared/plan/**) | bash, source file write |
| Reviewer | read, glob, grep | write, edit, bash, task |

## Install

### Binary (Linux x64)

```bash
# Download release
wget http://git.airlongdian.fun/admin/AirCoding/releases/download/0.1.0/AirCoding-Alpha-0.1.0-linux-x64.tar.gz
tar xzf AirCoding-Alpha-0.1.0-linux-x64.tar.gz
cd AirCoding-Alpha-0.1.0 && ./install.sh

aircoding --version  # → 0.1.0
```

The binary installs to `~/.aircoding/` and does not conflict with opencode (`~/.opencode/`).

### Build from Source

```bash
bun install          # install dependencies
bun typecheck        # type check (29 packages, all pass)
cd packages/opencode && OPENCODE_VERSION="0.1.0" OPENCODE_CHANNEL="aircoding" bun run script/build.ts --single --skip-embed-web-ui
```

## Directory Convention

```
.air/shared/plan/plan.md               # architecture plan (Architect output)
.air/shared/plan/task-graph.json       # task graph (Architect output, Scheduler reads)
.air/shared/plan/docs/ADR-*.md         # architecture decision records
.air/shared/plan/docs/c4/              # C4 model docs
.air/local/state/scheduler-state.json  # scheduler state (realtime persistence)
.air/local/debug/debug-log.md          # debug log
```

## Design Docs

Detailed design documents are in `docs/`:

- [Architecture Design MVP](docs/aircoding-architecture-mvp.md)
- [V2 Implementation Plan](docs/implementation-plan.md)
- [V2 Design (detailed)](docs/airplanV2-Qwen3.7-Max设计.md)
- [V1 Baseline](docs/baselineV1.md)
- [Agent Constraints](docs/AGENTS.md)
- [Integration Notes](docs/INTEGRATION.md)

## Key Constraints (Iron Rules)

See `CLAUDE.md` for the full constraint specification. Summary:

1. **Scheduler**: No fallback implementations. Must fully follow design specs. If the design doesn't cover a scenario, dispatch Architect to update the design first — never self-adjudicate in code.
2. **Executor (Worker)**: No "get it working first / fix later" downgrades. Compile → test → cppcheck all mandatory. Fallback language in output = auto-FAIL.
3. **Reviewer**: Mandatory, not optional. "Tests pass" / "function exists" / "build passed" are not valid reasons to PASS. Must produce a line-by-line Code-to-Design table. Coordinator code gates enforce this deterministically.
4. **Architect loop prevention**: Milestone review has a 2-per-phase / 5-global dispatch budget with `milestone_satisfied` gate to prevent infinite architect dispatch loops.

## Acknowledgments

Forked from [OpenCode](https://github.com/anomalyco/opencode) v1.17.4.
