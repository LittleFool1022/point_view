#!/usr/bin/env bash
set -euo pipefail
studio_root="$(cd "$(dirname "$0")/../.." && pwd)"
if [[ ! -x "$studio_root/.tools/object-runtime/bin/python" ]]; then
  uv venv "$studio_root/.tools/object-runtime" --python 3.10
fi
uv pip install --python "$studio_root/.tools/object-runtime/bin/python" -r "$studio_root/scripts/object-studio/requirements.txt"
