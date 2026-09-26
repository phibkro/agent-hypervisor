//! Rights lattices: what a capability lets its holder *do*.
//!
//! Every rights type is a meet-semilattice ordered by `leq` (attenuation).
//! `meet` is the greatest lower bound, used when narrowing a grant.

use std::collections::BTreeSet;

/// The three kinds of access an enforcement point can be asked about.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum AccessKind {
    /// Observe contents (read a file, reveal a secret).
    Read,
    /// Mutate contents (write a file, rotate a secret).
    Write,
    /// Use the resource without observing it (send a request through the proxy).
    Invoke,
}

/// A set of access kinds, as a tiny bitset.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Kinds(u8);

impl Kinds {
    pub const NONE: Kinds = Kinds(0);
    pub const R: Kinds = Kinds(1);
    pub const W: Kinds = Kinds(2);
    pub const I: Kinds = Kinds(4);
    pub const RW: Kinds = Kinds(3);
    pub const ALL: Kinds = Kinds(7);

    pub fn of(k: AccessKind) -> Kinds {
        match k {
            AccessKind::Read => Kinds::R,
            AccessKind::Write => Kinds::W,
            AccessKind::Invoke => Kinds::I,
        }
    }
    pub fn contains(self, k: AccessKind) -> bool {
        self.0 & Kinds::of(k).0 != 0
    }
    pub fn union(self, o: Kinds) -> Kinds {
        Kinds(self.0 | o.0)
    }
    pub fn inter(self, o: Kinds) -> Kinds {
        Kinds(self.0 & o.0)
    }
    pub fn is_empty(self) -> bool {
        self.0 == 0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Method {
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

/// An outgoing HTTP request as the egress proxy sees it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpRequest {
    pub host: String,
    pub method: Method,
    pub path: String,
}

/// `path` lies at or beneath `prefix`, respecting segment boundaries:
/// `/repos/a` is under `/repos` but `/repos-evil` is not.
pub fn path_under(path: &str, prefix: &str) -> bool {
    if prefix == "/" {
        return path.starts_with('/');
    }
    let prefix = prefix.trim_end_matches('/');
    path == prefix || (path.starts_with(prefix) && path.as_bytes().get(prefix.len()) == Some(&b'/'))
}

/// Scoped HTTP access: one exact host, a set of methods, a set of path subtrees.
/// Kept in normal form (no prefix lies under another; empty scope is canonical).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct HttpScope {
    host: String,
    methods: BTreeSet<Method>,
    prefixes: BTreeSet<String>,
}

impl HttpScope {
    pub fn new(
        host: impl Into<String>,
        methods: impl IntoIterator<Item = Method>,
        prefixes: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        Self {
            host: host.into().to_ascii_lowercase(),
            methods: methods.into_iter().collect(),
            prefixes: prefixes.into_iter().map(Into::into).collect(),
        }
        .normalize()
    }

    pub fn empty() -> Self {
        Self {
            host: String::new(),
            methods: BTreeSet::new(),
            prefixes: BTreeSet::new(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.methods.is_empty() || self.prefixes.is_empty()
    }

    fn normalize(self) -> Self {
        if self.methods.is_empty() || self.prefixes.is_empty() {
            return Self::empty();
        }
        let minimal: BTreeSet<String> = self
            .prefixes
            .iter()
            .filter(|p| !self.prefixes.iter().any(|q| q != *p && path_under(p, q)))
            .cloned()
            .collect();
        Self {
            prefixes: minimal,
            ..self
        }
    }

    pub fn permits(&self, req: &HttpRequest) -> bool {
        !self.is_empty()
            && req.host.eq_ignore_ascii_case(&self.host)
            && self.methods.contains(&req.method)
            && self.prefixes.iter().any(|p| path_under(&req.path, p))
    }

    pub fn leq(&self, other: &Self) -> bool {
        self.is_empty()
            || (self.host == other.host
                && self.methods.is_subset(&other.methods)
                && self
                    .prefixes
                    .iter()
                    .all(|p| other.prefixes.iter().any(|q| path_under(p, q))))
    }

    pub fn meet(&self, other: &Self) -> Self {
        if self.is_empty() || other.is_empty() || self.host != other.host {
            return Self::empty();
        }
        let methods = self.methods.intersection(&other.methods).copied().collect();
        let mut prefixes = BTreeSet::new();
        for p in &self.prefixes {
            for q in &other.prefixes {
                if path_under(p, q) {
                    prefixes.insert(p.clone());
                } else if path_under(q, p) {
                    prefixes.insert(q.clone());
                }
            }
        }
        Self {
            host: self.host.clone(),
            methods,
            prefixes,
        }
        .normalize()
    }
}

/// What the registry needs from a rights type: an attenuation order with meets,
/// and enough shape to answer enforcement questions.
pub trait Lattice: Clone + PartialEq + Eq + std::fmt::Debug {
    /// Which access kinds these rights could ever allow.
    fn kinds(&self) -> Kinds;
    /// Attenuation order: `self` grants no more than `other`.
    fn leq(&self, other: &Self) -> bool;
    /// Greatest lower bound, or `None` if the two are incomparable in kind.
    fn meet(&self, other: &Self) -> Option<Self>;
    /// The same rights with every mutating right removed (used by `freeze`).
    fn without_write(&self) -> Self;
    /// Does a concrete access fall inside these rights?
    fn permits(&self, access: &Access) -> bool;
    /// Do these rights make sense for a resource of this kind?
    fn fits(&self, kind: crate::registry::Kind) -> bool;
}

/// Rights over a directory.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct FsRights {
    pub read: bool,
    pub write: bool,
}

/// Rights over a secret. `reveal` is the dangerous one and defaults off.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct SecretRights {
    /// Where the proxy may substitute this secret.
    pub scope: HttpScope,
    /// Replace the secret's value.
    pub rotate: bool,
    /// Observe the plaintext.
    pub reveal: bool,
}

/// Rights, tagged by resource kind. Rights of different kinds are incomparable.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Rights {
    Fs(FsRights),
    Secret(SecretRights),
}

impl Rights {
    pub fn fs(read: bool, write: bool) -> Self {
        Rights::Fs(FsRights { read, write })
    }

    pub fn invoke(scope: HttpScope) -> Self {
        Rights::Secret(SecretRights {
            scope,
            rotate: false,
            reveal: false,
        })
    }
}

impl Lattice for FsRights {
    fn kinds(&self) -> Kinds {
        let r = if self.read { Kinds::R } else { Kinds::NONE };
        let w = if self.write { Kinds::W } else { Kinds::NONE };
        r.union(w)
    }
    fn leq(&self, o: &Self) -> bool {
        (!self.read || o.read) && (!self.write || o.write)
    }
    fn meet(&self, o: &Self) -> Option<Self> {
        Some(FsRights {
            read: self.read && o.read,
            write: self.write && o.write,
        })
    }
    fn without_write(&self) -> Self {
        FsRights {
            write: false,
            ..*self
        }
    }
    fn permits(&self, a: &Access) -> bool {
        !matches!(a, Access::Invoke(_)) && self.kinds().contains(a.kind())
    }
    fn fits(&self, kind: crate::registry::Kind) -> bool {
        kind == crate::registry::Kind::Dir
    }
}

impl Lattice for Rights {
    fn kinds(&self) -> Kinds {
        match self {
            Rights::Fs(f) => {
                let r = if f.read { Kinds::R } else { Kinds::NONE };
                let w = if f.write { Kinds::W } else { Kinds::NONE };
                r.union(w)
            }
            Rights::Secret(s) => {
                let i = if s.scope.is_empty() {
                    Kinds::NONE
                } else {
                    Kinds::I
                };
                let r = if s.reveal { Kinds::R } else { Kinds::NONE };
                let w = if s.rotate { Kinds::W } else { Kinds::NONE };
                i.union(r).union(w)
            }
        }
    }

    fn leq(&self, other: &Rights) -> bool {
        match (self, other) {
            (Rights::Fs(a), Rights::Fs(b)) => (!a.read || b.read) && (!a.write || b.write),
            (Rights::Secret(a), Rights::Secret(b)) => {
                a.scope.leq(&b.scope) && (!a.rotate || b.rotate) && (!a.reveal || b.reveal)
            }
            _ => false,
        }
    }

    fn meet(&self, other: &Rights) -> Option<Rights> {
        match (self, other) {
            (Rights::Fs(a), Rights::Fs(b)) => {
                Some(Rights::fs(a.read && b.read, a.write && b.write))
            }
            (Rights::Secret(a), Rights::Secret(b)) => Some(Rights::Secret(SecretRights {
                scope: a.scope.meet(&b.scope),
                rotate: a.rotate && b.rotate,
                reveal: a.reveal && b.reveal,
            })),
            _ => None,
        }
    }

    fn without_write(&self) -> Rights {
        match self {
            Rights::Fs(f) => Rights::fs(f.read, false),
            Rights::Secret(s) => Rights::Secret(SecretRights {
                rotate: false,
                ..s.clone()
            }),
        }
    }

    fn permits(&self, access: &Access) -> bool {
        match (self, access) {
            (_, Access::Read) => self.kinds().contains(AccessKind::Read),
            (_, Access::Write) => self.kinds().contains(AccessKind::Write),
            (Rights::Secret(s), Access::Invoke(req)) => s.scope.permits(req),
            (Rights::Fs(_), Access::Invoke(_)) => false,
        }
    }

    fn fits(&self, kind: crate::registry::Kind) -> bool {
        use crate::registry::Kind;
        matches!(
            (kind, self),
            (Kind::Dir, Rights::Fs(_)) | (Kind::Secret, Rights::Secret(_))
        )
    }
}

/// A concrete access, checked at an enforcement point.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Access {
    Read,
    Write,
    Invoke(HttpRequest),
}

impl Access {
    pub fn kind(&self) -> AccessKind {
        match self {
            Access::Read => AccessKind::Read,
            Access::Write => AccessKind::Write,
            Access::Invoke(_) => AccessKind::Invoke,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segment_boundaries() {
        assert!(path_under("/repos/a/pulls", "/repos/a"));
        assert!(path_under("/repos/a", "/repos/a/"));
        assert!(!path_under("/repos/ab", "/repos/a"));
        assert!(path_under("/anything", "/"));
    }

    #[test]
    fn scope_meet_narrows_paths() {
        let a = HttpScope::new("api.github.com", [Method::Get, Method::Post], ["/repos"]);
        let b = HttpScope::new("api.github.com", [Method::Post], ["/repos/x", "/user"]);
        let m = a.meet(&b);
        assert_eq!(
            m,
            HttpScope::new("api.github.com", [Method::Post], ["/repos/x"])
        );
        assert!(m.leq(&a) && m.leq(&b));
    }
}
