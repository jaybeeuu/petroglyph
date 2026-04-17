#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT="$API_DIR/lambda.zip"

echo "Building @petroglyph/api..."
pnpm build

echo "Zipping to $OUTPUT..."
rm -f "$OUTPUT"
python3 -c "
import zipfile, os, sys
api_dir = sys.argv[1]
output = sys.argv[2]
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as zf:
    zf.write(os.path.join(api_dir, 'dist', 'index.js'), 'dist/index.js')
    zf.write(os.path.join(api_dir, 'package.json'), 'package.json')
" "$API_DIR" "$OUTPUT"

echo "Done: $OUTPUT"
