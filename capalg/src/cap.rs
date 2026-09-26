//! Modes: Pony's deny discipline, reduced to the one axis that matters here.
//!
//! Pony defines each reference capability by what it denies to *local* aliases
//! (same actor) and *global* aliases (other actors). In this system the actor is a
//! session, and everything inside a session (the agent and its subagents) shares
//! freely, so the local axis collapses. What remains is: what may this grant do,
//! and what does it deny to grants held by *other* sessions.
//!
//! | mode  | Pony | may do         | denies other sessions | sendable      |
//! |-------|------|----------------|-----------------------|---------------|
//! | `Iso` | iso  | read, write, * | read, write           | yes, by move  |
//! | `Val` | val  | read           | write                 | yes, by copy  |
//! | `Tag` | tag  | invoke         | nothing               | yes, by copy  |
//!
//! `*` Iso may also invoke. Pony's `tag` aliases may coexist with an `iso`, and so
//! do ours: exclusive ownership of a secret (to rotate it) does not stop other
//! sessions from using it through the proxy.

use crate::rights::{Kinds, Lattice, Rights};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Mode {
    Iso,
    Val,
    Tag,
}

impl Mode {
    /// Access kinds the mode allows at all (intersected with the rights).
    pub fn allows(self) -> Kinds {
        match self {
            Mode::Iso => Kinds::ALL,
            Mode::Val => Kinds::R,
            Mode::Tag => Kinds::I,
        }
    }

    /// Access kinds this mode denies to every other session's grant on the resource.
    pub fn denies(self) -> Kinds {
        match self {
            Mode::Iso => Kinds::RW,
            Mode::Val => Kinds::W,
            Mode::Tag => Kinds::NONE,
        }
    }

    /// Pony's rule: sendable iff local and global denies agree. With the local axis
    /// collapsed, all three remaining modes are sendable; what differs is whether
    /// sending moves (Iso) or copies (Val, Tag).
    pub fn send_moves(self) -> bool {
        matches!(self, Mode::Iso)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SessionId(pub u32);

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ResourceId(pub u32);

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CapId(pub u64);

/// Revocation epoch of a resource. Strictly increases; stale tokens are fenced off.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Epoch(pub u64);

/// A live grant, generic over its rights lattice (default: [`Rights`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cap<R = Rights> {
    pub id: CapId,
    pub holder: SessionId,
    pub res: ResourceId,
    pub mode: Mode,
    pub rights: R,
    pub epoch: Epoch,
}

impl<R: Lattice> Cap<R> {
    /// What this grant can actually do: mode ∩ rights.
    pub fn effective(&self) -> Kinds {
        self.mode.allows().inter(self.rights.kinds())
    }
}

/// The whole of Pony's matrix as one predicate on two coexisting grants.
///
/// Grants held by the same session never conflict (the collapsed local axis); the
/// registry separately keeps at most one grant per (session, resource).
pub fn compatible<R: Lattice>(a: &Cap<R>, b: &Cap<R>) -> bool {
    a.res != b.res
        || a.holder == b.holder
        || (a.effective().inter(b.mode.denies()).is_empty()
            && b.effective().inter(a.mode.denies()).is_empty())
}
