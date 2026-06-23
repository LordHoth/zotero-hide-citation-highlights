#!/usr/bin/env bash
#
# Release helper: bump manifest.json to the given version, commit, tag, and push
# the tag (which triggers .github/workflows/release.yml to build the .xpi and
# publish the GitHub release).
#
# Usage: ./release.sh v0.1.0   (the leading "v" is optional)
#
set -euo pipefail

raw="${1:-}"
if [ -z "$raw" ]; then
  echo "usage: $0 <version>   e.g. $0 v0.1.0" >&2
  exit 1
fi

version="${raw#v}"          # 0.1.0
tag="v${version}"           # v0.1.0

if ! printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.]+)?$'; then
  echo "error: '$raw' is not a valid version like v0.1.0" >&2
  exit 1
fi

cd "$(dirname "$0")"

if git rev-parse "$tag" >/dev/null 2>&1; then
  echo "error: tag $tag already exists" >&2
  exit 1
fi

# Bump manifest.json version (portable; preserves key order and 2-space indent).
python3 - "$version" <<'PY'
import json, sys
path = "manifest.json"
with open(path) as f:
    data = json.load(f)
data["version"] = sys.argv[1]
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
echo "manifest.json version -> $version"

# Commit the bump only if it actually changed something.
if ! git diff --quiet -- manifest.json; then
  git add manifest.json
  git commit -m "Release $tag"
else
  echo "manifest.json already at $version; tagging existing commit"
fi

# Make sure the tagged commit exists on the remote, then push the tag.
git push origin HEAD
git tag "$tag"
git push origin "$tag"

echo "Pushed $tag. GitHub Actions will build the .xpi and publish the release."
