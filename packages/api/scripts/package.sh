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
bundle = sys.argv[1]
output = sys.argv[2]
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as zf:
    zf.write(bundle, os.path.join('dist', os.path.basename(bundle)))
" "$API_DIR/dist/index.js" "$OUTPUT"

echo "Done: $OUTPUT"
