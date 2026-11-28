package apg

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type manifestCorpus struct {
	SchemaVersion int `json:"schemaVersion"`
	Cases         []struct {
		Name   string `json:"name"`
		Expect struct {
			Go string `json:"go"`
		} `json:"expect"`
		Manifest any `json:"manifest"`
	} `json:"cases"`
	Divergences []struct {
		Name   string `json:"name"`
		Expect struct {
			Go string `json:"go"`
		} `json:"expect"`
		RawManifest string `json:"rawManifest"`
	} `json:"divergences"`
}

// TestManifestCorpus pins the Go validator to the shared cross-language APG
// contract corpus. The frontend parser consumes the same file.
func TestManifestCorpus(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "tests", "fixtures", "apg", "manifests.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read corpus: %v", err)
	}
	var corpus manifestCorpus
	if err := json.Unmarshal(data, &corpus); err != nil {
		t.Fatalf("decode corpus: %v", err)
	}
	if corpus.SchemaVersion != 1 {
		t.Fatalf("unsupported corpus schemaVersion %d", corpus.SchemaVersion)
	}
	for _, test := range corpus.Cases {
		manifest, err := json.Marshal(test.Manifest)
		if err != nil {
			t.Fatalf("case %q: marshal manifest: %v", test.Name, err)
		}
		_, validateErr := ValidateManifestJSON(manifest)
		switch test.Expect.Go {
		case "accept":
			if validateErr != nil {
				t.Fatalf("case %q: expected accept, got %v", test.Name, validateErr)
			}
		case "reject":
			if validateErr == nil {
				t.Fatalf("case %q: expected reject, got accept", test.Name)
			}
		default:
			t.Fatalf("case %q: missing or unknown go expectation %q", test.Name, test.Expect.Go)
		}
	}
	if len(corpus.Divergences) == 0 {
		t.Fatal("corpus has no documented divergences")
	}
	for _, test := range corpus.Divergences {
		_, validateErr := ValidateManifestJSON([]byte(test.RawManifest))
		if validateErr == nil {
			t.Fatalf("divergence %q: expected Go rejection, got accept", test.Name)
		}
		if !strings.Contains(strings.ToLower(validateErr.Error()), "duplicate") {
			t.Fatalf("divergence %q: rejection does not mention a duplicate key: %v", test.Name, validateErr)
		}
	}
}
