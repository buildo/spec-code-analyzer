#!/usr/bin/env python3
"""
repo_map_to_bundle.py — deterministic md/JSON -> MCP ingest bundle transform (M3).

Turns the machine-readable discovery artifacts produced by the cartographer and the
crawler into two vibingwithclaude `ingest_bundle` payloads, so the `indexer` agent only
has to shell out here and forward the result to the MCP (no fragile in-agent parsing).

Inputs (all produced by the Context phase of workflows/spec-analyze.js):
  - <repo-map-dir>/index.json      (M4 cartographer sidecar)  + one <area_key>.md per area
  - <comments-index>               (M4 crawler sidecar, comments.index.json)
  - <comments-md>                  (crawler comments.md, stored verbatim for faithful reuse)

Output: a JSON object { "bundles": [ <cartographer bundle>, <crawler bundle> ] } on stdout
(or --out). Each bundle is a ready-to-send ingest_bundle payload. The node modeling is the
contract the context-broker relies on to MATERIALIZE the artifacts back on a fresh cache hit:
  - area node:  name=area_key, body_md=<area_key>.md content, extra.paths/dependsOn
                -> broker rebuilds repo-map/index.md (from purposes) + repo-map/<area_key>.md (from body_md)
  - pr node:    name=pr-<number>, extra.{number,state,signals,paths}, links touches->area
  - doc node:   name=comments-md (type pr, number 0), body_md=<entire comments.md>
                -> broker rebuilds comments.md verbatim from this single node

Stdlib only (like fetch_atlassian.py / run_cost.py). No network, no third-party deps.
"""
import argparse
import json
import os
import sys


def _load_json(path, default):
    if not path or not os.path.isfile(path):
        return default
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError) as e:
        sys.stderr.write(f"WARN: could not read {path}: {e}\n")
        return default


def _read_text(path):
    if not path or not os.path.isfile(path):
        return ""
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read()
    except OSError as e:
        sys.stderr.write(f"WARN: could not read {path}: {e}\n")
        return ""


def _touches_area(pr_paths, areas_by_key):
    """Map a PR's touched paths to the area_keys it overlaps (by path-prefix), deduped."""
    hits = []
    for area_key, paths in areas_by_key.items():
        for ap in paths:
            ap_norm = ap.rstrip("/")
            if not ap_norm:
                continue
            if any(p == ap_norm or p.startswith(ap_norm + "/") or ap_norm.startswith(p.rstrip("/") + "/")
                   for p in pr_paths if p):
                hits.append(area_key)
                break
    # stable order, deduped
    seen, out = set(), []
    for h in hits:
        if h not in seen:
            seen.add(h)
            out.append(h)
    return out


def build(args):
    common_extra = {"commit_sha": args.commit_sha, "branch": args.branch, "repo": args.repo}
    sha_tag = (args.commit_sha or "nosha")[:12]

    # ---- cartographer bundle (areas) ----
    index = _load_json(os.path.join(args.repo_map_dir, "index.json"), {"areas": []})
    areas = index.get("areas", []) if isinstance(index, dict) else []
    areas_by_key = {}
    area_nodes = []
    for a in areas:
        key = str(a.get("area_key", "")).strip()
        if not key:
            continue
        paths = [p for p in (a.get("paths") or []) if p]
        areas_by_key[key] = paths
        body_md = _read_text(os.path.join(args.repo_map_dir, f"{key}.md"))
        area_nodes.append({
            "type": "area",
            "name": key,
            "title": key,
            "summary": str(a.get("purpose", "")).strip(),
            "keywords": paths,
            "body_md": body_md,
            "extra": dict(common_extra, paths=paths, dependsOn=[d for d in (a.get("dependsOn") or []) if d],
                          artifact="repo-map"),
        })
    # dependsOn links, only to areas that actually exist
    for a in areas:
        key = str(a.get("area_key", "")).strip()
        for dep in (a.get("dependsOn") or []):
            dep = str(dep).strip()
            if key and dep and dep in areas_by_key:
                for n in area_nodes:
                    if n["name"] == key:
                        n.setdefault("links", []).append(
                            {"relation": "dependsOn", "target_type": "area", "target_name": dep})

    cartographer_bundle = {
        "schema_version": args.schema_version,
        "bundle_id": f"{args.workspace}-cartographer-{sha_tag}",
        "source_kind": "cartographer",
        "workspace": args.workspace,
        "commit_sha": args.commit_sha,
        "branch": args.branch,
        "replace_edges": True,
        "nodes": area_nodes,
    }

    # ---- crawler bundle (PRs + full comments.md doc node) ----
    cidx = _load_json(args.comments_index, {"prs": []})
    prs = cidx.get("prs", []) if isinstance(cidx, dict) else []
    pr_nodes = []
    for pr in prs:
        num = pr.get("number")
        if num is None:
            continue
        try:
            num = int(num)
        except (TypeError, ValueError):
            sys.stderr.write(f"WARN: skipping PR with non-integer number {num!r}\n")
            continue
        pr_paths = [p for p in (pr.get("paths") or []) if p]
        node = {
            "type": "pr",
            "name": f"pr-{num}",
            "title": str(pr.get("title", "")).strip() or f"PR {num}",
            "summary": str(pr.get("title", "")).strip(),
            "extra": dict(common_extra, number=num, state=pr.get("state", ""),
                          signals=pr.get("signals", ""), paths=pr_paths, artifact="pr"),
        }
        links = [{"relation": "touches", "target_type": "area", "target_name": ak}
                 for ak in _touches_area(pr_paths, areas_by_key)]
        if links:
            node["links"] = links
        pr_nodes.append(node)

    # one doc node carrying the full comments.md verbatim (faithful reuse on fresh hit)
    comments_md = _read_text(args.comments_md)
    if comments_md.strip():
        pr_nodes.append({
            "type": "pr",
            "name": "comments-md",
            "title": "comments.md (full crawler output)",
            "summary": "verbatim crawler comments.md for faithful cache reuse",
            "body_md": comments_md,
            "extra": dict(common_extra, number=0, artifact="comments-md"),
        })

    # replace_edges wipes existing edges for these nodes before re-adding them. Only assert it for
    # the crawler bundle when we actually have PR nodes to re-link: a comments-md-only bundle (e.g.
    # comments.index.json missing) must NOT wipe prior `touches` edges it cannot re-establish.
    has_pr_nodes = any(n["name"] != "comments-md" for n in pr_nodes)
    crawler_bundle = {
        "schema_version": args.schema_version,
        "bundle_id": f"{args.workspace}-crawler-{sha_tag}",
        "source_kind": "crawler",
        "workspace": args.workspace,
        "commit_sha": args.commit_sha,
        "branch": args.branch,
        "replace_edges": has_pr_nodes,
        "nodes": pr_nodes,
    }

    # Omit a bundle with zero nodes so a failed/empty discovery never ships an empty,
    # edge-wiping bundle to the MCP (the indexer also skips empties defensively).
    bundles = [b for b in (cartographer_bundle, crawler_bundle) if b["nodes"]]
    return {"bundles": bundles}


def main():
    ap = argparse.ArgumentParser(description="Build MCP ingest bundles from repo-map/ + comments artifacts.")
    ap.add_argument("--repo", required=True)
    ap.add_argument("--branch", default="main")
    ap.add_argument("--commit-sha", default="", dest="commit_sha")
    ap.add_argument("--workspace", required=True, help="sanitized [a-z0-9-] workspace (owner-repo)")
    ap.add_argument("--repo-map-dir", required=True, dest="repo_map_dir")
    ap.add_argument("--comments-index", default="", dest="comments_index")
    ap.add_argument("--comments-md", default="", dest="comments_md")
    ap.add_argument("--schema-version", default="1.0", dest="schema_version")
    ap.add_argument("--out", default="", help="output file (default stdout)")
    args = ap.parse_args()

    result = build(args)
    payload = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(payload)
        # brief summary to stderr for the calling agent's log
        cb, wb = result["bundles"]
        sys.stderr.write(f"wrote {args.out}: {len(cb['nodes'])} area nodes, {len(wb['nodes'])} crawler nodes\n")
    else:
        print(payload)


if __name__ == "__main__":
    main()
