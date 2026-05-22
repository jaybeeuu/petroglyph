#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT="$PACKAGE_DIR/lambda.zip"

echo "Building @petroglyph/ingest-onedrive..."
pnpm build

echo "Zipping to $OUTPUT..."
rm -f "$OUTPUT"
python3 -c "
import zipfile, os, sys
package_dir = sys.argv[1]
output = sys.argv[2]
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as zf:
    zf.write(os.path.join(package_dir, 'dist', 'index.js'), 'dist/index.js')
    zf.write(os.path.join(package_dir, 'package.json'), 'package.json')
" "$PACKAGE_DIR" "$OUTPUT"

echo "Done: $OUTPUT"
