#!/usr/bin/env python3
"""Print an Alloy 6 XML trace compactly: static capability facts once, then what changes per state.

Usage: python3 trace.py <solution.xml>
"""
import sys
import xml.etree.ElementTree as ET

STATIC_FIELDS = ["holder", "res", "mode", "rights", "parent", "copyOf", "project"]
VAR_SIGS = ["Minted", "Live", "Revoked", "Consumed", "Running", "Pending"]
VAR_FIELDS = ["rw", "ro"]


def short(atom: str) -> str:
    return atom.replace("$", "")


def read_instance(inst):
    sigs, fields, id2label = {}, {}, {}
    for sig in inst.findall("sig"):
        id2label[sig.get("ID")] = sig.get("label").split("/")[-1]
        sigs[sig.get("label").split("/")[-1]] = [short(a.get("label")) for a in sig.findall("atom")]
    for f in inst.findall("field"):
        tuples = [tuple(short(a.get("label")) for a in t.findall("atom")) for t in f.findall("tuple")]
        fields[f.get("label")] = tuples
    return sigs, fields


def main(path):
    root = ET.parse(path).getroot()
    instances = root.findall("instance")
    first_sigs, first_fields = read_instance(instances[0])
    loop = instances[0].get("backloop")
    print(f"trace: {len(instances)} states, loops back to state {loop}")
    if first_sigs.get("SyncUnmount"):
        print("SyncUnmount: yes")
    else:
        print("SyncUnmount: no")
    print("capabilities:")
    by_cap = {}
    for name in ["holder", "res", "mode", "parent", "copyOf"]:
        for t in first_fields.get(name, []):
            by_cap.setdefault(t[0], {})[name] = t[1]
    for t in first_fields.get("rights", []):
        by_cap.setdefault(t[0], {}).setdefault("rights", []).append(t[1])
    single = set(first_sigs.get("SingleUse", []))
    for cap in sorted(first_sigs.get("Cap", [])):
        info = by_cap.get(cap, {})
        extra = " single-use" if cap in single else ""
        print(f"  {cap}: {info.get('mode','?')} on {info.get('res','?')} held by {info.get('holder','?')}"
              f", parent {info.get('parent','-')}, copyOf {info.get('copyOf','-')}, rights {info.get('rights',[])}{extra}")
    for t in first_fields.get("project", []):
        print(f"  {t[0]} in {t[1]}")
    prev = None
    for i, inst in enumerate(instances):
        sigs, fields = read_instance(inst)
        cur = {k: sorted(sigs.get(k, [])) for k in VAR_SIGS}
        cur.update({k: sorted("->".join(t) for t in fields.get(k, [])) for k in VAR_FIELDS})
        changes = {k: v for k, v in cur.items() if prev is None or prev[k] != v}
        print(f"state {i}: " + ", ".join(f"{k}={v}" for k, v in changes.items()))
        prev = cur


if __name__ == "__main__":
    main(sys.argv[1])
