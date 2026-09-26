//! Kani harnesses: exhaustive over the finite parts of the algebra.
//! Run with `cargo kani`. Property tests cover the unbounded parts (HTTP scopes,
//! long histories); these prove the mode algebra for *every* input.

use crate::cap::*;
use crate::registry::{Kind, Registry};
use crate::rights::{AccessKind, FsRights, Lattice};

fn any_mode() -> Mode {
    match kani::any::<u8>() % 3 {
        0 => Mode::Iso,
        1 => Mode::Val,
        _ => Mode::Tag,
    }
}

fn any_fs() -> FsRights {
    FsRights {
        read: kani::any(),
        write: kani::any(),
    }
}

fn any_fs_cap(id: u64) -> Cap<FsRights> {
    Cap {
        id: CapId(id),
        holder: SessionId(kani::any::<u32>() % 2),
        res: ResourceId(kani::any::<u32>() % 2),
        mode: any_mode(),
        rights: any_fs(),
        epoch: Epoch(0),
    }
}

/// `compatible` is symmetric.
#[kani::proof]
fn compatible_symmetric() {
    let (a, b) = (any_fs_cap(0), any_fs_cap(1));
    assert_eq!(compatible(&a, &b), compatible(&b, &a));
}

/// What iso and val promise, for every pair `compatible` admits.
#[kani::proof]
fn compatible_implies_mode_promises() {
    let (a, b) = (any_fs_cap(0), any_fs_cap(1));
    kani::assume(a.res == b.res && a.holder != b.holder);
    if compatible(&a, &b) {
        if a.mode == Mode::Iso {
            assert!(!b.effective().contains(AccessKind::Read));
            assert!(!b.effective().contains(AccessKind::Write));
        }
        if a.mode == Mode::Val {
            assert!(!b.effective().contains(AccessKind::Write));
        }
    }
}

/// Attenuating a grant cannot make it incompatible with anything it was compatible with.
#[kani::proof]
fn attenuation_preserves_compatibility() {
    let (a, b) = (any_fs_cap(0), any_fs_cap(1));
    let narrower = any_fs();
    kani::assume(narrower.leq(&a.rights));
    let a2 = Cap {
        rights: narrower,
        ..a.clone()
    };
    if compatible(&a, &b) {
        assert!(compatible(&a2, &b));
    }
}

// Registry-level harnesses. They exhaust CBMC's memory in a 7 GB container (not
// yet run to completion), so they sit behind a feature:
//   cargo kani --features kani-registry
// Until they run somewhere bigger, `tests/laws.rs` (2000 random histories plus a
// mutation check) is the evidence for the registry's invariants.
#[cfg(feature = "kani-registry")]
mod registry_proofs {
    use super::*;

    /// Two acquires on one resource: whatever the modes, rights and sessions, the
    /// registry either refuses the second or ends in a state satisfying every invariant.
    #[kani::proof]
    #[kani::unwind(6)]
    fn two_acquires_keep_invariants() {
        let mut reg: Registry<FsRights> = Registry::new();
        let frozen: bool = kani::any();
        let r = reg.register(Kind::Dir, frozen);
        for _ in 0..2 {
            let s = SessionId(kani::any::<u32>() % 2);
            let _ = reg.acquire(s, r, any_mode(), any_fs());
        }
        assert!(reg.check_invariants().is_ok());
    }

    /// Acquire, then send: iso moves, and the result still satisfies every invariant.
    #[kani::proof]
    #[kani::unwind(6)]
    fn send_moves_iso_and_keeps_invariants() {
        let mut reg: Registry<FsRights> = Registry::new();
        let r = reg.register(Kind::Dir, kani::any());
        let mode = any_mode();
        if let Ok(t) = reg.acquire(SessionId(0), r, mode, any_fs()) {
            let rights = any_fs();
            if reg.send(t.cap, SessionId(1), rights).is_ok() {
                assert_eq!(reg.cap(t.cap).is_none(), mode == Mode::Iso);
                assert!(reg.check_invariants().is_ok());
            }
        }
    }
}
