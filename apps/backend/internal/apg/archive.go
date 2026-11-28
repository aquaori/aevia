package apg

import (
	"encoding/hex"
	"errors"
	"path/filepath"
)

func ValidDigest(value string) bool {
	b, err := hex.DecodeString(value)
	return err == nil && len(b) == 32 && value == hex.EncodeToString(b)
}

// Only CLI-verified packages enter this immutable archive. A package digest is
// rechecked on read; disabling/uninstalling leaves historic bytes intact.
func ReadArchivedAsset(dir, digest, name string) ([]byte, error) {
	if !ValidDigest(digest) || !safeEntryName(name) {
		return nil, errors.New("invalid asset reference")
	}
	pkg, err := ReadPackageBundle(filepath.Join(dir, "archive", digest+".apg"))
	if err != nil {
		return nil, err
	}
	if pkg.Digest != digest {
		return nil, errors.New("archive digest mismatch")
	}
	data, ok := pkg.Assets[name]
	if !ok {
		return nil, errors.New("missing asset")
	}
	return data, nil
}
