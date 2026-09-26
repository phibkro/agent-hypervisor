/*
 * Capabilities, sandboxes and sessions: the invariants the control plane must keep.
 *
 * Source: domain/agent-hypervisor.cml (draft 4). Principals follow containment
 * (Owner > Project > Session); a capability is iso (exclusive), val (shared,
 * immutable) or tag (identity only). Sandboxes are 1:1 with sessions, so a
 * session's mounts stand for its sandbox's mounts.
 *
 * Run: java -jar alloy.jar exec -f -o out spec/capabilities.als
 */
module capabilities

enum Mode { Iso, Val, Tag }

sig Resource {}
sig Right {}

abstract sig Principal {}
one sig Owner extends Principal {}
sig Project extends Principal {}
sig Session extends Principal {
  project: one Project,
  var rw: set Resource,   -- writable mounts in this session's sandbox
  var ro: set Resource    -- read-only mounts
}

/* Capabilities exist as atoms from the start; Minted says which have been issued. */
sig Cap {
  holder: one Principal,
  res: one Resource,
  mode: one Mode,
  rights: set Right,
  parent: lone Cap,
  copyOf: lone Cap        -- this capability is a fork's copy of another
}
/* "Allow once": consumed by its first use. */
sig SingleUse in Cap {}

/* Delegation follows containment, or stays with the same holder (attenuation). */
pred delegates[p, q: Principal] {
  p = q
  or (p = Owner and q in Project)
  or (p in Project and q in Session and q.project = p)
}

fact wellFormed {
  no c: Cap | c in c.^parent
  all c: Cap | no c.parent implies c.holder = Owner
  all c: Cap | some c.parent implies {
    c.res = c.parent.res
    c.rights in c.parent.rights
    delegates[c.parent.holder, c.holder]
    c.parent.mode = Tag implies c.mode = Tag
    c.parent.mode = Val implies c.mode in Val + Tag
    /* Found by ForkCarriesGrants: freezing iso into val happens in place (same holder).
       A project freezes its own iso, then hands out val copies, which stay re-derivable. */
    (c.parent.mode = Iso and c.mode = Val) implies c.holder = c.parent.holder
  }
  SingleUse.holder in Session
  /* A fork copy is re-derived from the same parent, never from its sibling source. */
  all d: Cap | some d.copyOf implies {
    d.parent = d.copyOf.parent
    d.mode = d.copyOf.mode
    d.rights = d.copyOf.rights
    d.holder in Session and d.copyOf.holder in Session
    d.holder != d.copyOf.holder
  }
}

var sig Minted in Cap {}
var sig Live in Minted {}
var sig Revoked in Minted {}
var sig Consumed in Minted {}

var sig Running in Session {}          -- the session's sandbox is up
var sig Pending in Session {}          -- the session has an open capability request

/* Revoke detaches affected mounts in the same step (present) or later (absent). */
lone sig SyncUnmount {}

fact init {
  no Minted
  no Running
  no Pending
  no rw
  no ro
}

/* ------------------------------------------------------------ helpers */

fun descendants[c: Cap]: set Cap { c.^~parent }

pred backedRW[s: Session, r: Resource, L: set Cap] {
  some c: L | c.holder = s and c.res = r and c.mode = Iso
}
pred backedRO[s: Session, r: Resource, L: set Cap] {
  some c: L | c.holder = s and c.res = r and c.mode in Iso + Val
}

pred capsUnchanged {
  Minted' = Minted
  Live' = Live
  Revoked' = Revoked
  Consumed' = Consumed
}
pred sandboxUnchanged {
  Running' = Running
  Pending' = Pending
  rw' = rw
  ro' = ro
}
pred mountsUnchanged {
  rw' = rw
  ro' = ro
}
/* Drop the mounts no longer backed by a live capability. */
pred unmountUnbacked[L: set Cap] {
  rw' = { s: Session, r: Resource | s->r in rw and backedRW[s, r, L] }
  ro' = { s: Session, r: Resource | s->r in ro and backedRO[s, r, L] }
}

/* ------------------------------------------------------------ capability events */

/* The owner issues a root capability. An iso root needs no other live iso on the resource. */
pred mintRoot[c: Cap] {
  no c.parent
  c not in Minted
  /* Found by IsoIsExclusive: an iso root must also exclude live vals, and a val root live isos. */
  c.mode = Iso implies no d: Live | d.res = c.res and d.mode in Iso + Val
  c.mode = Val implies no d: Live | d.res = c.res and d.mode = Iso
  Minted' = Minted + c
  Live' = Live + c
  Revoked' = Revoked
  Consumed' = Consumed
  sandboxUnchanged
}

/* Delegate or attenuate from a live parent. Deriving iso or val from an iso parent
   moves exclusivity: the parent stops being live (Pony's consume). */
pred derive[c: Cap] {
  some c.parent
  c not in Minted
  c.parent in Live
  let moved = (c.parent.mode = Iso and c.mode in Iso + Val) implies c.parent else none {
    Live' = Live - moved + c
    /* Found by MountsAreBackedWhenUnmountIsSynchronous: freezing iso into val removes write
       authority too, so mounts follow every loss of authority, not only revocation. */
    some SyncUnmount implies unmountUnbacked[Live - moved + c] else mountsUnchanged
  }
  Minted' = Minted + c
  Revoked' = Revoked
  Consumed' = Consumed
  Running' = Running
  Pending' = Pending
}

/* Revoke a capability and everything derived from it. */
pred revoke[c: Cap] {
  c in Minted - Revoked
  let dead = c + descendants[c] & Minted {
    Live' = Live - dead
    Revoked' = Revoked + dead
    some SyncUnmount implies unmountUnbacked[Live - dead] else mountsUnchanged
  }
  Minted' = Minted
  Consumed' = Consumed
  Running' = Running
  Pending' = Pending
}

/* Use a single-use capability; it and anything derived from it end. */
pred consume[c: Cap] {
  c in SingleUse & Live
  let dead = c + descendants[c] & Minted {
    Live' = Live - dead
    Consumed' = Consumed + c
    some SyncUnmount implies unmountUnbacked[Live - dead] else mountsUnchanged
  }
  Minted' = Minted
  Revoked' = Revoked
  Running' = Running
  Pending' = Pending
}

/* ------------------------------------------------------------ sandbox events */

pred start[s: Session] {
  s not in Running
  Running' = Running + s
  Pending' = Pending
  mountsUnchanged
  capsUnchanged
}

pred mount[s: Session, r: Resource, writable: Bool] {
  s in Running
  writable = True implies {
    backedRW[s, r, Live]
    rw' = rw + s->r
    ro' = ro
  } else {
    backedRO[s, r, Live]
    ro' = ro + s->r
    rw' = rw
  }
  Running' = Running
  Pending' = Pending
  capsUnchanged
}

pred unmount[s: Session, r: Resource] {
  s->r in rw + ro
  rw' = rw - s->r
  ro' = ro - s->r
  Running' = Running
  Pending' = Pending
  capsUnchanged
}

/* The 15-minute idle rule: never while a request is pending. */
pred stopIdle[s: Session] {
  s in Running
  s not in Pending
  Running' = Running - s
  Pending' = Pending
  rw' = rw - s->Resource
  ro' = ro - s->Resource
  capsUnchanged
}

/* The owner archives: open requests are cancelled, the sandbox stops. */
pred archive[s: Session] {
  s in Running
  Pending' = Pending - s
  Running' = Running - s
  rw' = rw - s->Resource
  ro' = ro - s->Resource
  capsUnchanged
}

pred request[s: Session] {
  s in Running
  s not in Pending
  Pending' = Pending + s
  Running' = Running
  mountsUnchanged
  capsUnchanged
}

/* Deciding closes the request; a grant is a separate derive event. */
pred decide[s: Session] {
  s in Pending
  Pending' = Pending - s
  Running' = Running
  mountsUnchanged
  capsUnchanged
}

/* ------------------------------------------------------------ fork */

/* A fork is a new session in the same project. It gets fresh copies of the source
   session's non-iso capabilities, re-derived from the same project-held parents
   (sessions cannot delegate to siblings). */
pred fork[s, t: Session] {
  t != s
  t.project = s.project
  no Minted & holder.t
  t not in Running
  /* Every non-iso capability the source holds from its project has a copy atom for t. */
  all c: Live & holder.s & mode.(Val + Tag) | c.parent.holder = s.project implies some copyOf.c & holder.t
  /* Copies are minted where their parent is still live; nothing else changes. */
  let copies = { d: Cap - Minted | d.holder = t and some d.copyOf and d.copyOf in Live & holder.s and d.parent in Live } {
    Minted' = Minted + copies
    Live' = Live + copies
  }
  Revoked' = Revoked
  Consumed' = Consumed
  sandboxUnchanged
}

pred stutter { capsUnchanged and sandboxUnchanged }

fact traces {
  always (
    stutter
    or (some c: Cap | mintRoot[c] or derive[c] or revoke[c] or consume[c])
    or (some s: Session | start[s] or stopIdle[s] or archive[s] or request[s] or decide[s])
    or (some s: Session, r: Resource, b: Bool | mount[s, r, b])
    or (some s: Session, r: Resource | unmount[s, r])
    or (some s, t: Session | fork[s, t])
  )
}

enum Bool { True, False }

/* ------------------------------------------------------------ invariants */

/* I1: an iso capability is the only live alias of its resource (tags excepted). */
assert IsoIsExclusive {
  always all c: Live & mode.Iso | no d: Live - c | d.res = c.res and d.mode in Iso + Val
}

/* I2: every mount is backed by a live capability held by that session.
   Expected to FAIL when unmounting lags revocation (no SyncUnmount): the counterexample is the
   window in which a revoked session can still read or write. Kept as a documented negative result. */
assert MountsAreBacked {
  always all s: Session, r: Resource {
    s->r in rw implies backedRW[s, r, Live]
    s->r in ro implies backedRO[s, r, Live]
  }
}

/* I2': with synchronous unmounting (revoke and freeze detach affected mounts in the same step),
   every mount is backed. This is the rule the implementation must follow. */
assert MountsAreBackedWhenUnmountIsSynchronous {
  some SyncUnmount implies (always all s: Session, r: Resource {
    r in s.rw implies backedRW[s, r, Live]
    r in s.ro implies backedRO[s, r, Live]
  })
}

/* I3: revoking a capability ends everything derived from it, for good. */
assert RevocationCascades {
  always all c: Revoked | no (descendants[c] & Live)
  always all c: Revoked | always c not in Live
}

/* I4: a session never holds rights its project does not hold (or once held). */
assert SessionsWithinProject {
  always all c: Live & holder.Session |
    some p: c.^parent | p.holder = c.holder.project and c.rights in p.rights
}

/* I5: a single-use capability is used at most once. */
assert SingleUseOnce {
  always all c: Consumed | always c not in Live
}

/* I6: an agent waiting on a request always has a running sandbox. */
assert WaitingSessionsKeepRunning {
  always Pending in Running
}

/* F1: a fork carries every non-iso capability the project issued to its source.
   Refined after a counterexample: grants the session derived from its own iso (e.g. a
   read-only view of its own worktree) stay with it; the fork gets its own worktree instead. */
assert ForkCarriesGrants {
  always all s, t: Session | fork[s, t] implies
    all c: Live & holder.s & mode.(Val + Tag) & parent.holder.(s.project) |
      some d: Live' & holder.t | d.res = c.res and d.mode = c.mode and d.rights = c.rights
}

check IsoIsExclusive for 4 but 8 steps
check MountsAreBacked for 4 but 8 steps  -- expected: counterexample
/* Same property when revoke detaches affected mounts in the same step. */
check MountsAreBackedWhenUnmountIsSynchronous for 4 but 8 steps
check RevocationCascades for 4 but 8 steps
check SessionsWithinProject for 4 but 8 steps
check SingleUseOnce for 4 but 8 steps
check WaitingSessionsKeepRunning for 4 but 8 steps
check ForkCarriesGrants for 4 but 8 steps

/* Non-vacuity: the interesting states are reachable. */
run WriteMountThenRevoke {
  eventually (some rw and eventually some Revoked)
} for 4 but 8 steps
run ForkHappens {
  eventually (some s, t: Session | fork[s, t])
} for 4 but 8 steps

/* Larger scope for the properties the implementation leans on. */
check IsoIsExclusive for 5 but 10 steps
check MountsAreBackedWhenUnmountIsSynchronous for 5 but 10 steps
check ForkCarriesGrants for 5 but 10 steps
