#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STAGING_DIR="$API_DIR/.lambda-staging"
OUTPUT="$API_DIR/lambda.zip"

echo "Building @petroglyph/api..."
pnpm build

echo "Staging deployment artifact..."
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"

cp -r "$API_DIR/dist" "$STAGING_DIR/dist"

if [ -d "$API_DIR/node_modules" ]; then
  cp -rL "$API_DIR/node_modules" "$STAGING_DIR/node_modules"
fi

echo "Zipping to $OUTPUT..."
rm -f "$OUTPUT"
python3 -c "
import zipfile, os, sys
staging = sys.argv[1]
output = sys.argv[2]
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as zf:
    for root, dirs, files in os.walk(staging):
        for file in files:
            abs_path = os.path.join(root, file)
            arc_name = os.path.relpath(abs_path, staging)
            zf.write(abs_path, arc_name)
" "$STAGING_DIR" "$OUTPUT"

echo "Cleaning up staging directory..."
rm -rf "$STAGING_DIR"

echo "Done: $OUTPUT"
