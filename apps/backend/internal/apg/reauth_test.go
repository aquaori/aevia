package apg

import (
	"reflect"
	"testing"
)

func reauthBasePackage() Package {
	return Package{
		Manifest: Manifest{
			ManifestVersion: ManifestVersion2,
			ID:              "acme.tools",
			Name:            "Acme tools",
			Version:         "1.0.0",
			Scope:           "system",
			APIVersion:      APIVersion,
			Permissions:     []string{"scene.read"},
			Main:            "main.js",
			Contributes: Contributes{
				Palettes: []Palette{{ID: "brand", Label: "Brand", Colors: []string{"#AABBCC"}}},
				Brushes:  []Brush{{ID: "marker", Label: "Marker", Base: "marker"}},
				Commands: []Command{{ID: "inspect", Label: "Inspect", Resource: "assets/card.json"}},
			},
		},
	}
}

func TestReauthorizationChanges(t *testing.T) {
	ptr := func(value float64) *float64 { return &value }
	tests := []struct {
		name      string
		oldMutate func(*Package)
		mutate    func(*Package)
		want      []string
	}{
		{
			name:   "identical package",
			mutate: func(*Package) {},
		},
		{
			name: "permission added",
			mutate: func(pkg *Package) {
				pkg.Manifest.Permissions = []string{"scene.read", "scene.write"}
			},
			want: []string{`permission added: "scene.write"`},
		},
		{
			name: "permission removed is not an expansion",
			mutate: func(pkg *Package) {
				pkg.Manifest.Permissions = nil
			},
		},
		{
			name: "scope change",
			mutate: func(pkg *Package) {
				pkg.Manifest.Scope = "user"
				pkg.Manifest.Contributes.Brushes = nil
				pkg.Manifest.Permissions = nil
			},
			want: []string{`scope changed from "system" to "user"`},
		},
		{
			name: "palette changed",
			mutate: func(pkg *Package) {
				pkg.Manifest.Contributes.Palettes[0].Colors = []string{"#112233"}
			},
			want: []string{`palette changed: "brand"`},
		},
		{
			name: "palette added",
			mutate: func(pkg *Package) {
				pkg.Manifest.Contributes.Palettes = append(pkg.Manifest.Contributes.Palettes, Palette{ID: "studio", Label: "Studio", Colors: []string{"#FFFFFF"}})
			},
			want: []string{`palette added: "studio"`},
		},
		{
			name: "brush changed",
			mutate: func(pkg *Package) {
				pkg.Manifest.Contributes.Brushes[0].Size = ptr(4)
			},
			want: []string{`brush changed: "marker"`},
		},
		{
			name: "brush added",
			mutate: func(pkg *Package) {
				pkg.Manifest.Contributes.Brushes = append(pkg.Manifest.Contributes.Brushes, Brush{ID: "soft", Label: "Soft", Base: "pencil"})
			},
			want: []string{`brush added: "soft"`},
		},
		{
			name: "command resource changed",
			mutate: func(pkg *Package) {
				pkg.Manifest.Contributes.Commands[0].Resource = "assets/other.json"
			},
			want: []string{`command changed: "inspect" (resource "assets/card.json" -> "assets/other.json")`},
		},
		{
			name: "command shortcut changed",
			mutate: func(pkg *Package) {
				pkg.Manifest.Contributes.Commands[0].Shortcut = "Alt+Shift+3"
			},
			want: []string{`command changed: "inspect"`},
		},
		{
			name: "command added",
			mutate: func(pkg *Package) {
				pkg.Manifest.Contributes.Commands = append(pkg.Manifest.Contributes.Commands, Command{ID: "count", Label: "Count"})
			},
			want: []string{`command added: "count"`},
		},
		{
			name: "signing key changed",
			mutate: func(pkg *Package) {
				pkg.Signature = &PackageSignature{KeyID: "next-key"}
			},
			want: []string{`signing key changed from "test" to "next-key"`},
		},
		{
			name:      "unsigned to signed is not an expansion",
			oldMutate: func(pkg *Package) { pkg.Signature = nil },
			mutate:    func(*Package) {},
		},
		{
			name: "signed to unsigned",
			mutate: func(pkg *Package) {
				pkg.Signature = nil
			},
			want: []string{`signing key changed from "test" to ""`},
		},
		{
			name: "multiple changes stay ordered",
			mutate: func(pkg *Package) {
				pkg.Manifest.Permissions = []string{"scene.read", "scene.write"}
				pkg.Manifest.Contributes.Palettes[0].Label = "Renamed"
			},
			want: []string{`permission added: "scene.write"`, `palette changed: "brand"`},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			old := reauthBasePackage()
			old.Signature = &PackageSignature{KeyID: "test"}
			if test.oldMutate != nil {
				test.oldMutate(&old)
			}
			next := old
			next.Manifest = old.Manifest
			next.Manifest.Permissions = append([]string(nil), old.Manifest.Permissions...)
			next.Manifest.Contributes.Palettes = append([]Palette(nil), old.Manifest.Contributes.Palettes...)
			next.Manifest.Contributes.Brushes = append([]Brush(nil), old.Manifest.Contributes.Brushes...)
			next.Manifest.Contributes.Commands = append([]Command(nil), old.Manifest.Contributes.Commands...)
			test.mutate(&next)
			got := ReauthorizationChanges(old, next)
			if !reflect.DeepEqual(got, test.want) {
				t.Fatalf("changes = %#v, want %#v", got, test.want)
			}
		})
	}
}
