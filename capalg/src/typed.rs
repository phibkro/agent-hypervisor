//! Static layer for the control plane's own code: Rust's move semantics play the
//! role of Pony's `consume`.
//!
//! Agents sit outside the type system, so the registry checks everything at run
//! time. The control plane's own code, though, can get compile errors for misuse:
//! an `Iso` handle is not `Clone`, and sending or freezing it consumes it.
//!
//! ```compile_fail
//! use capalg::{Registry, Kind, Rights, SessionId, typed::Iso};
//! let mut reg = Registry::new();
//! let repo = reg.register(Kind::Dir, false);
//! let iso = Iso::acquire(&mut reg, SessionId(1), repo, Rights::fs(true, true)).unwrap();
//! let moved = iso.send(&mut reg, SessionId(2), Rights::fs(true, true)).unwrap();
//! iso.freeze(&mut reg); // error: use of moved value `iso`
//! ```
//!
//! ```compile_fail
//! use capalg::{Registry, Kind, Rights, SessionId, typed::Iso};
//! fn dup(i: &Iso) -> Iso { i.clone() } // error: Iso is not Clone
//! ```

use crate::cap::{Mode, ResourceId, SessionId};
use crate::registry::{Error, Registry, Token};
use crate::rights::Rights;

/// Exclusive ownership. Not `Clone`: there is exactly one.
#[derive(Debug, PartialEq, Eq)]
pub struct Iso(Token);

/// Immutable snapshot access. Freely copied within a session.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Val(Token);

/// Use without observation (credentials). Freely copied within a session.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Tag(Token);

impl Iso {
    pub fn acquire(
        reg: &mut Registry,
        s: SessionId,
        r: ResourceId,
        rights: Rights,
    ) -> Result<Iso, Error> {
        reg.acquire(s, r, Mode::Iso, rights).map(Iso)
    }
    /// Move ownership to another session. `self` is consumed.
    pub fn send(
        self,
        reg: &mut Registry,
        to: SessionId,
        rights: Rights,
    ) -> Result<Iso, (Iso, Error)> {
        reg.send(self.0.cap, to, rights)
            .map(Iso)
            .map_err(|e| (self, e))
    }
    /// Publish as an immutable snapshot. `self` is consumed.
    pub fn freeze(self, reg: &mut Registry) -> Result<Val, (Iso, Error)> {
        reg.freeze(self.0.cap).map(Val).map_err(|e| (self, e))
    }
    pub fn token(&self) -> &Token {
        &self.0
    }
}

impl Val {
    pub fn acquire(
        reg: &mut Registry,
        s: SessionId,
        r: ResourceId,
        rights: Rights,
    ) -> Result<Val, Error> {
        reg.acquire(s, r, Mode::Val, rights).map(Val)
    }
    pub fn send(&self, reg: &mut Registry, to: SessionId, rights: Rights) -> Result<Val, Error> {
        reg.send(self.0.cap, to, rights).map(Val)
    }
    pub fn token(&self) -> &Token {
        &self.0
    }
}

impl Tag {
    pub fn acquire(
        reg: &mut Registry,
        s: SessionId,
        r: ResourceId,
        rights: Rights,
    ) -> Result<Tag, Error> {
        reg.acquire(s, r, Mode::Tag, rights).map(Tag)
    }
    pub fn send(&self, reg: &mut Registry, to: SessionId, rights: Rights) -> Result<Tag, Error> {
        reg.send(self.0.cap, to, rights).map(Tag)
    }
    pub fn token(&self) -> &Token {
        &self.0
    }
}
