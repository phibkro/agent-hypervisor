//! The laws from `lib.rs`, checked over random operation sequences.

use capalg::rights::SecretRights;
use capalg::typed::{Iso, Tag, Val};
use capalg::*;
use proptest::prelude::*;
use std::collections::{BTreeMap, BTreeSet};

// ---------- generators ----------

const HOSTS: [&str; 2] = ["api.github.com", "api.stripe.com"];
const METHODS: [Method; 3] = [Method::Get, Method::Post, Method::Delete];
const PREFIXES: [&str; 5] = ["/", "/repos", "/repos/x", "/repos/y", "/user"];
const PATHS: [&str; 6] = [
    "/repos/x/pulls",
    "/repos/y",
    "/repos/xy",
    "/user",
    "/other",
    "/repos",
];

fn scope() -> impl Strategy<Value = HttpScope> {
    (
        0..HOSTS.len(),
        prop::collection::btree_set(0..3usize, 0..=3),
        prop::collection::btree_set(0..5usize, 0..=3),
    )
        .prop_map(|(h, ms, ps)| {
            HttpScope::new(
                HOSTS[h],
                ms.into_iter().map(|i| METHODS[i]),
                ps.into_iter().map(|i| PREFIXES[i]),
            )
        })
}

fn fs_rights() -> impl Strategy<Value = Rights> {
    (any::<bool>(), any::<bool>()).prop_map(|(r, w)| Rights::fs(r, w))
}

fn secret_rights() -> impl Strategy<Value = Rights> {
    (scope(), any::<bool>(), any::<bool>()).prop_map(|(scope, rotate, reveal)| {
        Rights::Secret(SecretRights {
            scope,
            rotate,
            reveal,
        })
    })
}

fn rights() -> impl Strategy<Value = Rights> {
    prop_oneof![fs_rights(), secret_rights()]
}

fn request() -> impl Strategy<Value = HttpRequest> {
    (0..HOSTS.len(), 0..METHODS.len(), 0..PATHS.len()).prop_map(|(h, m, p)| HttpRequest {
        host: HOSTS[h].into(),
        method: METHODS[m],
        path: PATHS[p].into(),
    })
}

fn access() -> impl Strategy<Value = Access> {
    prop_oneof![
        Just(Access::Read),
        Just(Access::Write),
        request().prop_map(Access::Invoke)
    ]
}

fn mode() -> impl Strategy<Value = Mode> {
    prop_oneof![Just(Mode::Iso), Just(Mode::Val), Just(Mode::Tag)]
}

#[derive(Clone, Debug)]
enum Op {
    Acquire {
        s: u32,
        r: u32,
        mode: Mode,
        rights: Rights,
    },
    Attenuate {
        pick: usize,
        rights: Rights,
    },
    Send {
        pick: usize,
        to: u32,
        rights: Rights,
    },
    Freeze {
        pick: usize,
    },
    Release {
        pick: usize,
    },
    Revoke {
        r: u32,
    },
}

const SESSIONS: u32 = 3;
const RESOURCES: u32 = 3; // 0, 1: dirs (1 starts frozen); 2: secret

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        4 => (0..SESSIONS, 0..RESOURCES, mode(), rights())
            .prop_map(|(s, r, mode, rights)| Op::Acquire { s, r, mode, rights }),
        2 => (any::<usize>(), rights()).prop_map(|(pick, rights)| Op::Attenuate { pick, rights }),
        3 => (any::<usize>(), 0..SESSIONS, rights()).prop_map(|(pick, to, rights)| Op::Send { pick, to, rights }),
        1 => any::<usize>().prop_map(|pick| Op::Freeze { pick }),
        1 => any::<usize>().prop_map(|pick| Op::Release { pick }),
        1 => (0..RESOURCES).prop_map(|r| Op::Revoke { r }),
    ]
}

fn world() -> Registry {
    let mut reg = Registry::new();
    reg.register(Kind::Dir, false);
    reg.register(Kind::Dir, true);
    reg.register(Kind::Secret, false);
    reg
}

fn pick(reg: &Registry, i: usize) -> Option<Cap> {
    let caps: Vec<&Cap> = reg.caps().collect();
    (!caps.is_empty()).then(|| caps[i % caps.len()].clone())
}

/// Some rights at or below `r`, to make successful sends and attenuations likely.
fn narrow(r: &Rights, other: &Rights) -> Rights {
    r.meet(other).unwrap_or_else(|| r.clone())
}

// ---------- the laws ----------

proptest! {
    #![proptest_config(ProptestConfig { cases: 2000, ..ProptestConfig::default() })]

    /// Laws 1-7 over arbitrary operation sequences.
    #[test]
    fn laws_hold_over_any_history(ops in prop::collection::vec(op(), 1..40), probes in prop::collection::vec(access(), 4)) {
        let mut reg = world();
        let mut tokens: Vec<Token> = Vec::new();
        let mut frozen_ever: BTreeSet<ResourceId> = [ResourceId(1)].into();
        let mut epochs: BTreeMap<ResourceId, Epoch> = BTreeMap::new();
        // tokens issued before the latest revoke of their resource
        let mut fenced: Vec<Token> = Vec::new();

        for op in ops {
            let before = reg.clone();
            let failed = match op {
                Op::Acquire { s, r, mode, rights } => {
                    match reg.acquire(SessionId(s), ResourceId(r), mode, rights) {
                        Ok(t) => { tokens.push(t); false }
                        Err(_) => true,
                    }
                }
                Op::Attenuate { pick: i, rights } => match pick(&reg, i) {
                    None => false,
                    Some(c) => {
                        // amplification is always refused, and refusing changes nothing
                        if !rights.leq(&c.rights) {
                            let snap = reg.clone();
                            prop_assert_eq!(reg.attenuate(c.id, rights.clone()), Err(Error::Amplification));
                            prop_assert_eq!(&reg, &snap);
                        }
                        let new = narrow(&c.rights, &rights);
                        match reg.attenuate(c.id, new) {
                            Ok(()) => {
                                // Law 2: never amplifies
                                prop_assert!(reg.cap(c.id).unwrap().rights.leq(&c.rights));
                                false
                            }
                            Err(_) => true,
                        }
                    }
                },
                Op::Send { pick: i, to, rights } => match pick(&reg, i) {
                    None => false,
                    Some(c) => match reg.send(c.id, SessionId(to), narrow(&c.rights, &rights)) {
                        Ok(t) => {
                            tokens.push(t);
                            let got = reg.cap(t.cap).unwrap();
                            // Law 2
                            prop_assert!(got.rights.leq(&c.rights));
                            prop_assert_eq!(got.mode, c.mode);
                            // Law 3: iso moves, val/tag copy
                            if c.mode == Mode::Iso {
                                prop_assert!(reg.cap(c.id).is_none());
                                prop_assert!(reg.held_by(c.holder, c.res).is_none());
                            } else {
                                prop_assert!(reg.cap(c.id).is_some());
                            }
                            false
                        }
                        Err(_) => true,
                    },
                },
                Op::Freeze { pick: i } => match pick(&reg, i) {
                    None => false,
                    Some(c) => match reg.freeze(c.id) {
                        Ok(t) => {
                            tokens.push(t);
                            frozen_ever.insert(c.res);
                            prop_assert_eq!(reg.cap(t.cap).unwrap().mode, Mode::Val);
                            false
                        }
                        Err(_) => true,
                    },
                },
                Op::Release { pick: i } => {
                    if let Some(c) = pick(&reg, i) { reg.release(c.id).unwrap(); }
                    false
                }
                Op::Revoke { r } => {
                    let r = ResourceId(r);
                    fenced.extend(tokens.iter().filter(|t| t.res == r).copied());
                    reg.revoke(r).unwrap();
                    prop_assert!(reg.caps().all(|c| c.res != r));
                    false
                }
            };

            // refused operations are atomic: nothing changes
            if failed { prop_assert_eq!(&reg, &before); }

            // Law 1 and 7 (and val-only-on-frozen, no-writer-on-frozen)
            prop_assert!(reg.check_invariants().is_ok(), "{:?}", reg.check_invariants());

            // Law 1, stated independently of `compatible` (which it would otherwise
            // be checking against itself): what iso and val promise, in plain terms.
            let caps: Vec<&Cap> = reg.caps().collect();
            for x in &caps {
                for y in caps.iter().filter(|y| y.res == x.res && y.holder != x.holder) {
                    let eff = y.effective();
                    match x.mode {
                        Mode::Iso => prop_assert!(
                            !eff.contains(AccessKind::Read) && !eff.contains(AccessKind::Write),
                            "iso {:?} coexists with another session that can read or write: {:?}", x.id, y
                        ),
                        Mode::Val => prop_assert!(
                            !eff.contains(AccessKind::Write),
                            "val {:?} coexists with a writer {:?}", x.id, y
                        ),
                        Mode::Tag => {}
                    }
                }
            }

            // Law 4: frozen forever
            for r in &frozen_ever {
                prop_assert!(reg.resource(*r).unwrap().frozen);
                prop_assert!(reg.caps().filter(|c| c.res == *r).all(|c| !c.effective().contains(AccessKind::Write)));
            }

            // Law 5: epochs monotone
            for r in 0..RESOURCES {
                let r = ResourceId(r);
                let e = reg.resource(r).unwrap().epoch;
                if let Some(prev) = epochs.insert(r, e) { prop_assert!(e >= prev); }
            }

            // Law 5 (fencing) and Law 6 (authorize soundness)
            for t in &tokens {
                for a in &probes {
                    if reg.authorize(t, a) {
                        prop_assert!(!fenced.contains(t), "fenced token authorized");
                        let c = reg.cap(t.cap).expect("authorized a dead grant");
                        let r = reg.resource(t.res).unwrap();
                        prop_assert_eq!(c.epoch, r.epoch);
                        prop_assert!(c.mode.allows().contains(a.kind()));
                        prop_assert!(c.rights.permits(a));
                    }
                }
            }
        }
    }

    // ---------- lattice laws for rights ----------

    #[test]
    fn leq_is_a_preorder(a in rights(), b in rights(), c in rights()) {
        prop_assert!(a.leq(&a));
        if a.leq(&b) && b.leq(&c) { prop_assert!(a.leq(&c)); }
    }

    #[test]
    fn meet_is_the_greatest_lower_bound(a in rights(), b in rights(), c in rights()) {
        if let Some(m) = a.meet(&b) {
            prop_assert!(m.leq(&a) && m.leq(&b));
            if c.leq(&a) && c.leq(&b) { prop_assert!(c.leq(&m)); }
            prop_assert_eq!(Some(m.clone()), b.meet(&a));
        }
    }

    #[test]
    fn attenuation_only_shrinks_what_is_permitted(a in rights(), b in rights(), x in access()) {
        if a.leq(&b) && a.permits(&x) { prop_assert!(b.permits(&x)); }
    }

    #[test]
    fn compatible_is_symmetric(a in rights(), b in rights(), m1 in mode(), m2 in mode(), s1 in 0..2u32, s2 in 0..2u32) {
        let mk = |id, s, mode, rights| Cap { id: CapId(id), holder: SessionId(s), res: ResourceId(0), mode, rights, epoch: Epoch(0) };
        let (x, y) = (mk(0, s1, m1, a), mk(1, s2, m2, b));
        prop_assert_eq!(compatible(&x, &y), compatible(&y, &x));
    }
}

// ---------- scenarios, as a reader would check them ----------

fn gh(methods: impl IntoIterator<Item = Method>, prefixes: &[&str]) -> HttpScope {
    HttpScope::new("api.github.com", methods, prefixes.iter().copied())
}

#[test]
fn two_sessions_cannot_both_own_a_repo() {
    let mut reg = world();
    let repo = ResourceId(0);
    let a = Iso::acquire(&mut reg, SessionId(0), repo, Rights::fs(true, true)).unwrap();
    let b = reg.acquire(SessionId(1), repo, Mode::Iso, Rights::fs(true, true));
    assert_eq!(b, Err(Error::Conflict(a.token().cap)));
}

#[test]
fn ownership_transfers_then_old_holder_is_fenced() {
    let mut reg = world();
    let repo = ResourceId(0);
    let a = Iso::acquire(&mut reg, SessionId(0), repo, Rights::fs(true, true)).unwrap();
    let old = *a.token();
    let b = a
        .send(&mut reg, SessionId(1), Rights::fs(true, true))
        .unwrap();
    assert!(!reg.authorize(&old, &Access::Write));
    assert!(reg.authorize(b.token(), &Access::Write));
}

#[test]
fn freeze_publishes_a_snapshot_others_can_read_but_nobody_can_write() {
    let mut reg = world();
    let repo = ResourceId(0);
    let owner = Iso::acquire(&mut reg, SessionId(0), repo, Rights::fs(true, true)).unwrap();
    // watchers cannot read a live, owned repo
    assert!(matches!(
        Val::acquire(&mut reg, SessionId(1), repo, Rights::fs(true, false)),
        Err(Error::NotFrozen)
    ));
    let snap = owner.freeze(&mut reg).unwrap();
    assert!(!reg.authorize(snap.token(), &Access::Write));
    let reader = snap
        .send(&mut reg, SessionId(1), Rights::fs(true, false))
        .unwrap();
    assert!(reg.authorize(reader.token(), &Access::Read));
    assert_eq!(
        reg.acquire(SessionId(2), repo, Mode::Iso, Rights::fs(true, true)),
        Err(Error::Frozen)
    );
}

#[test]
fn a_credential_is_usable_but_never_readable() {
    let mut reg = world();
    let token = ResourceId(2);
    let scope = gh([Method::Get, Method::Post], &["/repos/x"]);
    let t = Tag::acquire(&mut reg, SessionId(0), token, Rights::invoke(scope)).unwrap();
    let pr = |m, p: &str| {
        Access::Invoke(HttpRequest {
            host: "api.github.com".into(),
            method: m,
            path: p.into(),
        })
    };
    assert!(reg.authorize(t.token(), &pr(Method::Post, "/repos/x/pulls")));
    assert!(!reg.authorize(t.token(), &pr(Method::Delete, "/repos/x")));
    assert!(!reg.authorize(t.token(), &pr(Method::Get, "/repos/xy")));
    assert!(!reg.authorize(t.token(), &Access::Read));
}

#[test]
fn a_subagent_gets_less_and_can_never_get_more() {
    let mut reg = world();
    let token = ResourceId(2);
    let parent = Tag::acquire(
        &mut reg,
        SessionId(0),
        token,
        Rights::invoke(gh([Method::Get, Method::Post], &["/repos"])),
    )
    .unwrap();
    let child = parent
        .send(
            &mut reg,
            SessionId(1),
            Rights::invoke(gh([Method::Get], &["/repos/x"])),
        )
        .unwrap();
    let wider = Rights::invoke(gh([Method::Get, Method::Delete], &["/repos"]));
    assert_eq!(
        child.send(&mut reg, SessionId(2), wider),
        Err(Error::Amplification)
    );
}

#[test]
fn owning_a_secret_to_rotate_it_does_not_stop_others_using_it() {
    let mut reg = world();
    let token = ResourceId(2);
    let users = Tag::acquire(
        &mut reg,
        SessionId(0),
        token,
        Rights::invoke(gh([Method::Get], &["/"])),
    )
    .unwrap();
    let rotator = Rights::Secret(SecretRights {
        scope: HttpScope::empty(),
        rotate: true,
        reveal: false,
    });
    let rot = Iso::acquire(&mut reg, SessionId(1), token, rotator).unwrap();
    assert!(reg.authorize(rot.token(), &Access::Write));
    let get = Access::Invoke(HttpRequest {
        host: "api.github.com".into(),
        method: Method::Get,
        path: "/user".into(),
    });
    assert!(reg.authorize(users.token(), &get));
}

#[test]
fn revoke_fences_every_outstanding_token() {
    let mut reg = world();
    let snap = ResourceId(1);
    let v = Val::acquire(&mut reg, SessionId(0), snap, Rights::fs(true, false)).unwrap();
    let w = v
        .send(&mut reg, SessionId(1), Rights::fs(true, false))
        .unwrap();
    reg.revoke(snap).unwrap();
    assert!(!reg.authorize(v.token(), &Access::Read));
    assert!(!reg.authorize(w.token(), &Access::Read));
    // a fresh grant after revoke works, at the new epoch
    let fresh = Val::acquire(&mut reg, SessionId(0), snap, Rights::fs(true, false)).unwrap();
    assert!(reg.authorize(fresh.token(), &Access::Read));
    assert_eq!(fresh.token().epoch, Epoch(1));
}
