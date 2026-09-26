---
title: "capalg"
description: "The capability algebra in Rust: iso, val and tag grants over rights lattices, with proptest and Kani."
---

A capability algebra for agent sessions, after Pony's deny capabilities.

A **session** (one microVM: an agent plus its subagents) is the unit of authority.
Inside a session everything is shared. Between sessions, every grant says what it
lets its holder do (**rights**) and what it denies to everyone else (**mode**).

| mode  | Pony | may do         | denies other sessions | send      | used for                          |
|-------|------|----------------|-----------------------|-----------|-----------------------------------|
| `Iso` | iso  | read, write, invoke | read, write      | moves     | owning a repo, rotating a secret  |
| `Val` | val  | read           | write                 | copies    | frozen snapshots, shared docs     |
| `Tag` | tag  | invoke         | nothing               | copies    | credentials: usable, never readable |

Pony's whole matrix becomes one predicate, `compatible(a, b)`, that every pair of
live grants must satisfy. Rights are lattices (`Lattice` trait): directory
read/write, and HTTP scopes (exact host × methods × path subtrees, segment-aware).

## Operations

`acquire`, `attenuate` (narrow only), `send` (iso moves, val/tag copy),
`freeze` (iso → val, irreversible), `release`, `revoke` (bumps the epoch, fences
every outstanding token), and `authorize(token, access)`, the check an
enforcement point (file server, egress proxy) makes on every operation.

## Laws and evidence

| # | Law | Evidence |
|---|-----|----------|
| 1 | Every pair of live grants is compatible; iso excludes other readers and writers, val excludes writers | proptest, plus Kani for all mode × rights × holder combinations |
| 2 | No operation amplifies rights | proptest; Kani: attenuation preserves compatibility |
| 3 | Sending an iso consumes the sender's grant | proptest; compile-time via `typed::Iso` (move-only) |
| 4 | Frozen is forever, and a frozen resource never has a writer | proptest |
| 5 | Epochs never decrease; a token from before a revoke never authorizes | proptest |
| 6 | `authorize` implies a live, current grant covering the access | proptest |
| 7 | At most one grant per (session, resource) | proptest |
| – | Refused operations change nothing | proptest |
| – | `meet` is the greatest lower bound; `leq` is a preorder; `compatible` is symmetric | proptest, Kani |

`tests/laws.rs` runs 2000 random histories of up to 40 operations over 3 sessions
and 3 resources. A mutation pass (9 injected bugs) confirmed the suite catches 7;
the 2 survivors are equivalent (the property is already enforced elsewhere).

## Status

- `cargo test`: all pass. `cargo kani`: 3/3 algebra proofs verified.
- Registry-level Kani harnesses (`--features kani-registry`) run out of memory in
  a 7 GB container and have **not** been verified yet.
- Not built yet: the file server and egress proxy that call `authorize`, the
  microVM wiring, persistence, and a manifest format for grants.

```sh
cargo test
cargo kani                          # algebra proofs
cargo kani --features kani-registry # needs more memory
```
