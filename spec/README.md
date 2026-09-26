# spec: Alloy models

`capabilities.als` checks the rules the control plane must keep about capabilities, sandbox mounts, pending
requests and forks. It follows `domain/agent-hypervisor.cml`: principals follow containment
(Owner > Project > Session); a capability is `iso` (exclusive), `val` (shared, immutable) or `tag`
(identity only); sandboxes are 1:1 with sessions.

```sh
java -jar alloy.jar exec -f -t xml -o out capabilities.als   # Alloy 6.2.0
python3 trace.py out/<Command>-solution-0.xml                # readable counterexample
```

## Results (bounded: 4 atoms per signature, 8 steps)

| Check | Result |
|---|---|
| I1 `IsoIsExclusive`: an iso capability is the only live alias of its resource | holds |
| I2 `MountsAreBacked` with lazy unmount | **fails, by design** (documents the unsafe window) |
| I2' `MountsAreBackedWhenUnmountIsSynchronous` | holds |
| I3 `RevocationCascades`: revoking ends everything derived, for good | holds |
| I4 `SessionsWithinProject`: sessions never exceed their project's rights | holds |
| I5 `SingleUseOnce`: "allow once" is used at most once | holds |
| I6 `WaitingSessionsKeepRunning`: an agent waiting on a request keeps its sandbox | holds |
| F1 `ForkCarriesGrants`: a fork carries the project-issued, non-iso grants | holds |

The two `run` commands show the interesting states are reachable (the checks are not vacuous).

## What the counterexamples changed

1. **Issuing a root must check both directions.** An exclusive root must find no live shared capability on the
   resource, and a shared root no live exclusive one. The first draft only compared exclusive with exclusive.
2. **Mounts must follow every loss of authority, synchronously.** With lazy unmounting, a revoked session keeps a
   mount for a while (I2 fails). Revocation is not the only loss: *freezing* an exclusive capability into a shared
   one removes write authority too, so a writable mount must be downgraded in the same step. Implementation rule:
   a revoke or freeze completes only after the sandbox has detached or downgraded the affected mounts.
3. **Freeze in place.** Turning exclusive into shared is only allowed for the same holder. A project freezes its
   own capability, then hands out shared copies; handing a session a shared capability straight from the
   project's exclusive one consumes the project's, and no fork could ever get a copy.
4. **What a fork carries is exactly the project-issued grants.** Grants a session derived from its own exclusive
   capability (a read-only view of its own worktree) stay with it; the fork gets its own worktree instead.

## Limits

Bounded model checking: no counterexample within the scope, not a proof. Rights are sets of atoms (no lattice);
hosts, secrets and the harness are out of scope. `copyOf` pre-allocates fork copies to keep the quantification
first-order.
