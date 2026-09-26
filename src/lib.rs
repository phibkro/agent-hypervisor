//! # capalg
//!
//! A capability algebra for agent sessions, after Pony's deny capabilities.
//!
//! * [`rights`]: what a grant lets you do (attenuation lattices).
//! * [`cap`]: what a grant denies to *other sessions* (`Iso`, `Val`, `Tag`), and
//!   the one predicate, [`compatible`], that is Pony's whole matrix.
//! * [`registry`]: the sequencer that creates, moves, freezes and revokes grants,
//!   and the [`Registry::authorize`] check enforcement points call.
//! * [`typed`]: move-only handles so the control plane's own misuse is a compile error.
//!
//! Laws (property-tested in `tests/laws.rs`):
//!
//! 1. Every pair of live grants is [`compatible`].
//! 2. No operation amplifies rights.
//! 3. Sending an `Iso` consumes the sender's grant.
//! 4. A frozen resource is frozen forever and never has a writer.
//! 5. Epochs never decrease, and a token from before a revoke never authorizes.
//! 6. `authorize` implies a live, current grant whose mode and rights cover the access.
//! 7. At most one grant per (session, resource).

pub mod cap;
pub mod registry;
pub mod rights;
pub mod typed;

pub use cap::{Cap, CapId, Epoch, Mode, ResourceId, SessionId, compatible};
pub use registry::{Error, Kind, Registry, Token};
pub use rights::{Access, AccessKind, FsRights, HttpRequest, HttpScope, Lattice, Method, Rights};

#[cfg(kani)]
mod proofs;
