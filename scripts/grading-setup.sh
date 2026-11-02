#!/usr/bin/env sh
# Experimental pre-grading: one-time setup on macOS / Linux (same as grading-setup.ps1).
set -e
VIRIDIAN_COMMIT=f22ec116a727dc3d0976e304eb28ad83c89d681b   # pinned; see docs/SOURCES.md
cd "$(dirname "$0")/.."
DIR=third_party/viridian
if [ ! -d "$DIR/.git" ]; then
  mkdir -p "$DIR"
  git -C "$DIR" init -q
  git -C "$DIR" remote add origin https://github.com/dylan7077/viridian.git
fi
git -C "$DIR" fetch -q --depth 1 origin "$VIRIDIAN_COMMIT"
git -C "$DIR" checkout -q --force FETCH_HEAD
test -f "$DIR/LICENSE" || { echo "The Viridian MIT license file is missing." >&2; exit 1; }
[ -x .venv-grading/bin/python ] || python3 -m venv .venv-grading
.venv-grading/bin/python -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" || { echo "Python 3.10 or newer is needed." >&2; exit 1; }
.venv-grading/bin/python -m pip install --disable-pip-version-check -q -r services/grading/requirements.txt
echo "Pre-grading is set up. Start it with: sh scripts/grading-start.sh"
