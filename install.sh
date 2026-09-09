#!/usr/bin/env bash
# Install or refresh the gpu-device-grant grant as a home-level patch layer.
#
#   bash ~/dsh-wsl-gpufix/install.sh
#
# This is the "all profiles, no profile changes" method: the plugin is loaded
# in place from this directory through $DSH_HOME/cordis.patch.yml. If you
# prefer the standard DSH plugin install, use instead:
#
#   dsh plugin --profile <profile> add github:Jumqyc/dsh-wsl-gpufix
#
# Use one method, not both.
#
# Idempotent: creates $DSH_HOME/cordis.patch.yml when absent, repairs a row
# whose path no longer matches this directory (with a backup), and appends the
# row to a non-empty layer that lacks it. A stale pre-move copy under
# $DSH_HOME/plugins is removed when byte-identical.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE="$HERE/gpu-device-grant.mjs"
TEMPLATE="$HERE/home/cordis.patch.yml"
MODULE_URL="file://$MODULE"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PATCH="$DSH_HOME_DIR/cordis.patch.yml"
ROW_MARKER="gpu-device-grant"
LEGACY="$DSH_HOME_DIR/plugins/gpu-device-grant.mjs"

[[ -f "$MODULE" ]] || { echo "install: $MODULE not found" >&2; exit 1; }
[[ -f "$TEMPLATE" ]] || { echo "install: $TEMPLATE not found" >&2; exit 1; }
[[ -d "$DSH_HOME_DIR" ]] || { echo "install: $DSH_HOME_DIR does not exist (is DSH_HOME right?)" >&2; exit 1; }

render_patch() {
  sed "s|__MODULE_URL__|$MODULE_URL|g" "$TEMPLATE"
}

if [[ ! -e "$PATCH" ]]; then
  render_patch > "$PATCH"
  echo "install: created $PATCH"
elif grep -q "$ROW_MARKER" "$PATCH"; then
  if grep -Fq "name: $MODULE_URL" "$PATCH"; then
    echo "install: $PATCH already points at $MODULE_URL; left unchanged"
  else
    cp -f "$PATCH" "$PATCH.bak-gpu-device-grant"
    awk -v url="$MODULE_URL" '
      /^[[:space:]]*name:.*gpu-device-grant\.mjs[[:space:]]*$/ { print "      name: " url; next }
      { print }
    ' "$PATCH.bak-gpu-device-grant" > "$PATCH"
    echo "install: updated the row path in $PATCH (backup: $PATCH.bak-gpu-device-grant)"
  fi
elif [[ "$(tr -d '[:space:]' < "$PATCH")" == "[]" ]]; then
  render_patch > "$PATCH"
  echo "install: replaced the empty $PATCH with the $ROW_MARKER row"
else
  cp -f "$PATCH" "$PATCH.bak-gpu-device-grant"
  { printf '\n'; render_patch | sed -n '/^- insert:/,$p'; } >> "$PATCH"
  echo "install: appended the $ROW_MARKER row to $PATCH (backup: $PATCH.bak-gpu-device-grant)"
fi

if [[ -e "$LEGACY" ]]; then
  if cmp -s "$LEGACY" "$MODULE"; then
    rm -f "$LEGACY"
    rmdir "$DSH_HOME_DIR/plugins" 2>/dev/null || true
    echo "install: removed the stale pre-move copy $LEGACY"
  else
    echo "install: note: $LEGACY differs from this plugin and is no longer referenced; remove it if stale" >&2
  fi
fi

cat <<EOF

Plugin: $MODULE
Row:    $PATCH  (id $ROW_MARKER)

Next:
  1. DSH applies the home patch layer live when the profile sets
     patchReload: live; otherwise restart the profile.
  2. Verify from a normal (workspace-write) agent bash session:
       python -c "import os, torch; os.close(os.open('/dev/dxg', os.O_RDWR)); print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
     (use os.open, not open(path,'r+b'): buffered open seeks and raises
      UnsupportedOperation on a character device after the permission check)
  3. Editing gpu-device-grant.mjs needs a DSH restart: the loader caches the
     imported module.
  4. Prefer the standard DSH plugin install instead? Remove this home-layer row
     and use:
       dsh plugin --profile <profile> add github:Jumqyc/dsh-wsl-gpufix
     Use one method, not both.
EOF
