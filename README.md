# agent-hypervisor

A self-hosted, vendor-agnostic control plane for coding-agent harnesses (omp first; Claude Code, Codex, pi later).
Run agents per session, supervise and answer them from any device over Tailscale, and give them exactly the
authority a task needs through an object-capability algebra.

| Path | What |
|---|---|
| `app/` | Control plane prototype: TanStack Start + TanStack AI, omp over ACP, approvals, questions, projects, import |
| `capalg/` | Capability algebra in Rust (iso / val / tag, rights lattices, revocation), proptest + Kani |
| `domain/` | Domain model in Context Mapper (CML): user stories, lifecycles, four bounded contexts |
| `spec/` | Alloy models of the invariants the implementation must keep |

Status: prototype. Single owner, one host. The microVM sandbox (Cloud Hypervisor) needs a Linux host with KVM.
