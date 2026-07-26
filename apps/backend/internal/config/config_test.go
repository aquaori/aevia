package config

import "testing"

// TestLoadRequiresSecretInProduction pins the guard that was missing entirely:
// without it a production deployment silently signed room session tokens with the
// public development secret, so anyone could forge admission.
func TestLoadRequiresSecretInProduction(t *testing.T) {
	t.Setenv("APP_ENV", "production")
	t.Setenv("JWT_SECRET", "")

	if _, err := Load(); err == nil {
		t.Fatal("expected Load to fail in production without JWT_SECRET")
	}
}

func TestLoadAcceptsExplicitSecretInProduction(t *testing.T) {
	t.Setenv("APP_ENV", "production")
	t.Setenv("JWT_SECRET", "a-real-secret")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("expected Load to succeed: %v", err)
	}
	if cfg.JWTSecret != "a-real-secret" {
		t.Fatalf("unexpected secret %q", cfg.JWTSecret)
	}
	if !cfg.IsProduction() {
		t.Fatal("expected IsProduction to be true")
	}
}

func TestLoadFallsBackToDevSecretOutsideProduction(t *testing.T) {
	t.Setenv("APP_ENV", "development")
	t.Setenv("JWT_SECRET", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("expected Load to succeed in development: %v", err)
	}
	if cfg.JWTSecret != DevJWTSecret {
		t.Fatalf("expected the development secret, got %q", cfg.JWTSecret)
	}
	if cfg.IsProduction() {
		t.Fatal("expected IsProduction to be false")
	}
}

func TestRenderChunkSizeIsClampedToIndexableRange(t *testing.T) {
	t.Setenv("INIT_FLAT_POINT_CHUNK_SIZE", "100000")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	// Out-of-range values fall back to the default rather than allowing a chunk
	// whose command dictionary could overflow the uint16 index.
	if cfg.InitFlatPointChunkSize > MaxRenderChunkPoints {
		t.Fatalf("chunk size %d exceeds the indexable maximum", cfg.InitFlatPointChunkSize)
	}
}

func TestEnvBoolParsing(t *testing.T) {
	cases := map[string]bool{"1": true, "true": true, "YES": true, "on": true, "0": false, "false": false, "nope": false}
	for value, want := range cases {
		t.Setenv("TRUST_PROXY_HEADERS", value)
		cfg, err := Load()
		if err != nil {
			t.Fatalf("load with %q: %v", value, err)
		}
		if cfg.TrustProxyHeaders != want {
			t.Fatalf("TRUST_PROXY_HEADERS=%q: got %v want %v", value, cfg.TrustProxyHeaders, want)
		}
	}
}

func TestTrustedProxiesParsing(t *testing.T) {
	t.Setenv("TRUSTED_PROXIES", " 10.0.0.0/8 , 192.168.1.1 ,, ")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(cfg.TrustedProxies) != 2 {
		t.Fatalf("expected 2 entries, got %v", cfg.TrustedProxies)
	}
}

func TestInvalidIntFallsBackToDefault(t *testing.T) {
	t.Setenv("PORT", "not-a-number")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if cfg.Port != 4646 {
		t.Fatalf("expected the default port, got %d", cfg.Port)
	}
}
