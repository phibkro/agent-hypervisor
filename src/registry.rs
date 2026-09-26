//! The sequencer: the single place where grants are created, moved and destroyed.
//!
//! Exclusive ownership is non-monotone (acquiring excludes others, releasing
//! retracts a fact), so by CALM it needs coordination. On one host that
//! coordination is this struct behind a lock. What *is* monotone (epochs,
//! frozenness) only ever grows, and the laws below say so.

use crate::cap::{Cap, CapId, Epoch, Mode, ResourceId, SessionId, compatible};
use crate::rights::{Access, AccessKind, Lattice, Rights};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Dir,
    Secret,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Resource {
    pub kind: Kind,
    /// Once frozen, never writable again (Pony's `val` is forever).
    pub frozen: bool,
    pub epoch: Epoch,
}

/// What an enforcement point (file server, egress proxy) holds on behalf of a session.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Token {
    pub cap: CapId,
    pub res: ResourceId,
    pub epoch: Epoch,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    NoSuchResource,
    NoSuchCap,
    KindMismatch,
    /// The session already holds a grant on this resource; attenuate or release it.
    AlreadyHeld,
    /// Would coexist with an incompatible grant held by another session.
    Conflict(CapId),
    /// Writes are impossible on a frozen resource; `val` needs a frozen one.
    Frozen,
    NotFrozen,
    /// The requested rights are not below the current ones.
    Amplification,
    /// Only an `Iso` can be frozen.
    NotIso,
    /// Sending to yourself is a no-op; use attenuate.
    SameSession,
}

/// Storage is plain vectors: a session holds tens of grants, linear scans are
/// cheap, and it keeps the code small enough for Kani to verify exhaustively.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Registry<R = Rights> {
    /// Indexed by `ResourceId`.
    resources: Vec<Resource>,
    caps: Vec<Cap<R>>,
    next_cap: u64,
}

impl<R> Default for Registry<R> {
    fn default() -> Self {
        Self {
            resources: Vec::new(),
            caps: Vec::new(),
            next_cap: 0,
        }
    }
}

/// Which invariant a registry state breaks (see `lib.rs` for the laws).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Violation {
    DanglingResource(CapId),
    StaleEpoch(CapId),
    WriterOnFrozen(CapId),
    ValOnMutable(CapId),
    TwoGrantsOneSession(CapId, CapId),
    Incompatible(CapId, CapId),
}

impl<R: Lattice> Registry<R> {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, kind: Kind, frozen: bool) -> ResourceId {
        let id = ResourceId(self.resources.len() as u32);
        self.resources.push(Resource {
            kind,
            frozen,
            epoch: Epoch(0),
        });
        id
    }

    pub fn resource(&self, id: ResourceId) -> Option<&Resource> {
        self.resources.get(id.0 as usize)
    }

    fn resource_mut(&mut self, id: ResourceId) -> Option<&mut Resource> {
        self.resources.get_mut(id.0 as usize)
    }

    pub fn cap(&self, id: CapId) -> Option<&Cap<R>> {
        self.caps.iter().find(|c| c.id == id)
    }

    fn cap_mut(&mut self, id: CapId) -> Option<&mut Cap<R>> {
        self.caps.iter_mut().find(|c| c.id == id)
    }

    fn remove_cap(&mut self, id: CapId) -> Option<Cap<R>> {
        let i = self.caps.iter().position(|c| c.id == id)?;
        Some(self.caps.swap_remove(i))
    }

    pub fn caps(&self) -> impl Iterator<Item = &Cap<R>> {
        self.caps.iter()
    }

    pub fn held_by(&self, s: SessionId, r: ResourceId) -> Option<&Cap<R>> {
        self.caps.iter().find(|c| c.holder == s && c.res == r)
    }

    fn token(c: &Cap<R>) -> Token {
        Token {
            cap: c.id,
            res: c.res,
            epoch: c.epoch,
        }
    }

    /// Admission check for a candidate grant, ignoring `except` (the grant being replaced).
    fn admit(&self, cand: &Cap<R>, except: Option<CapId>) -> Result<(), Error> {
        let res = self.resource(cand.res).ok_or(Error::NoSuchResource)?;
        if !cand.rights.fits(res.kind) {
            return Err(Error::KindMismatch);
        }
        if res.frozen && cand.effective().contains(AccessKind::Write) {
            return Err(Error::Frozen);
        }
        if cand.mode == Mode::Val && !res.frozen {
            return Err(Error::NotFrozen);
        }
        if let Some(c) = self.held_by(cand.holder, cand.res)
            && Some(c.id) != except
        {
            return Err(Error::AlreadyHeld);
        }
        match self
            .caps
            .iter()
            .find(|c| Some(c.id) != except && !compatible(c, cand))
        {
            Some(c) => Err(Error::Conflict(c.id)),
            None => Ok(()),
        }
    }

    fn insert(&mut self, holder: SessionId, res: ResourceId, mode: Mode, rights: R) -> Cap<R> {
        let epoch = self.resource(res).expect("admitted resource exists").epoch;
        let cap = Cap {
            id: CapId(self.next_cap),
            holder,
            res,
            mode,
            rights,
            epoch,
        };
        self.next_cap += 1;
        self.caps.push(cap.clone());
        cap
    }

    fn candidate(
        &self,
        holder: SessionId,
        res: ResourceId,
        mode: Mode,
        rights: R,
    ) -> Result<Cap<R>, Error> {
        let epoch = self.resource(res).ok_or(Error::NoSuchResource)?.epoch;
        Ok(Cap {
            id: CapId(u64::MAX),
            holder,
            res,
            mode,
            rights,
            epoch,
        })
    }

    /// Ask for a fresh grant. Refused unless compatible with every live grant.
    pub fn acquire(
        &mut self,
        holder: SessionId,
        res: ResourceId,
        mode: Mode,
        rights: R,
    ) -> Result<Token, Error> {
        let cand = self.candidate(holder, res, mode, rights)?;
        self.admit(&cand, None)?;
        Ok(Self::token(&self.insert(holder, res, mode, cand.rights)))
    }

    /// Narrow a grant in place. Never amplifies.
    pub fn attenuate(&mut self, cap: CapId, rights: R) -> Result<(), Error> {
        let c = self.cap_mut(cap).ok_or(Error::NoSuchCap)?;
        if !rights.leq(&c.rights) {
            return Err(Error::Amplification);
        }
        c.rights = rights;
        Ok(())
    }

    /// Hand a grant (optionally narrowed) to another session.
    /// `Iso` moves: the sender's grant is consumed. `Val` and `Tag` copy.
    pub fn send(&mut self, cap: CapId, to: SessionId, rights: R) -> Result<Token, Error> {
        let c = self.cap(cap).ok_or(Error::NoSuchCap)?.clone();
        if c.holder == to {
            return Err(Error::SameSession);
        }
        if !rights.leq(&c.rights) {
            return Err(Error::Amplification);
        }
        let cand = Cap {
            holder: to,
            rights,
            ..c.clone()
        };
        let except = c.mode.send_moves().then_some(c.id);
        self.admit(&cand, except)?;
        if c.mode.send_moves() {
            self.remove_cap(c.id);
        }
        Ok(Self::token(&self.insert(to, c.res, c.mode, cand.rights)))
    }

    /// Pony's `consume iso` into `val`: the owner publishes an immutable snapshot.
    /// Irreversible. The grant becomes a read-only `Val` for its holder.
    pub fn freeze(&mut self, cap: CapId) -> Result<Token, Error> {
        let c = self.cap(cap).ok_or(Error::NoSuchCap)?;
        if c.mode != Mode::Iso {
            return Err(Error::NotIso);
        }
        let (res, holder, rights) = (c.res, c.holder, c.rights.without_write());
        self.remove_cap(cap);
        self.resource_mut(res)
            .expect("cap refers to live resource")
            .frozen = true;
        Ok(Self::token(&self.insert(holder, res, Mode::Val, rights)))
    }

    pub fn release(&mut self, cap: CapId) -> Result<(), Error> {
        self.remove_cap(cap).map(|_| ()).ok_or(Error::NoSuchCap)
    }

    /// Revoke every grant on a resource and fence off all outstanding tokens.
    pub fn revoke(&mut self, res: ResourceId) -> Result<Epoch, Error> {
        let r = self.resource_mut(res).ok_or(Error::NoSuchResource)?;
        r.epoch = Epoch(r.epoch.0 + 1);
        let e = r.epoch;
        self.caps.retain(|c| c.res != res);
        Ok(e)
    }

    /// The enforcement-point check. Everything an agent does passes through here.
    pub fn authorize(&self, t: &Token, access: &Access) -> bool {
        let (Some(c), Some(r)) = (self.cap(t.cap), self.resource(t.res)) else {
            return false;
        };
        c.res == t.res
            && t.epoch == r.epoch
            && c.epoch == r.epoch
            && c.effective().contains(access.kind())
            && c.rights.permits(access)
            && !(r.frozen && access.kind() == AccessKind::Write)
    }

    /// The global invariant (laws 1, 4, 5, 7). `None` means it holds.
    pub fn violation(&self) -> Option<Violation> {
        for (i, a) in self.caps.iter().enumerate() {
            let Some(r) = self.resource(a.res) else {
                return Some(Violation::DanglingResource(a.id));
            };
            if a.epoch != r.epoch {
                return Some(Violation::StaleEpoch(a.id));
            }
            if r.frozen && a.effective().contains(AccessKind::Write) {
                return Some(Violation::WriterOnFrozen(a.id));
            }
            if a.mode == Mode::Val && !r.frozen {
                return Some(Violation::ValOnMutable(a.id));
            }
            for b in &self.caps[i + 1..] {
                if a.holder == b.holder && a.res == b.res {
                    return Some(Violation::TwoGrantsOneSession(a.id, b.id));
                }
                if !compatible(a, b) {
                    return Some(Violation::Incompatible(a.id, b.id));
                }
            }
        }
        None
    }

    pub fn check_invariants(&self) -> Result<(), Violation> {
        self.violation().map_or(Ok(()), Err)
    }
}
