"""Verify packaged files before loading trusted joblib artifacts."""
import hashlib,json
from pathlib import Path
root=Path(__file__).resolve().parent
manifest=json.loads((root/'BUNDLE_MANIFEST.json').read_text(encoding='utf-8'))
for name, expected in manifest['files_sha256'].items():
    file=(root/name).resolve()
    if not file.is_relative_to(root) or not file.is_file():
        raise ValueError(f'Missing/unsafe file: {name}')
    if hashlib.sha256(file.read_bytes()).hexdigest()!=expected:
        raise ValueError(f'Checksum mismatch: {name}')
print(f"Verified {len(manifest['files_sha256'])} files. Checksums are integrity checks, not publisher signatures.")
