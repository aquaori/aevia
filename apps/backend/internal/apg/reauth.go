package apg

import (
	"fmt"
	"reflect"
	"sort"
)

// ReauthorizationChanges reports capability expansions between the installed
// package and its replacement. Any non-empty result means the deployer must
// explicitly disable the plugin before the new capabilities become active.
// Removals and unsigned-to-signed transitions are not expansions and are not
// reported.
func ReauthorizationChanges(old, next Package) []string {
	var changes []string
	oldManifest, nextManifest := old.Manifest, next.Manifest

	if oldManifest.Scope != nextManifest.Scope {
		changes = append(changes, fmt.Sprintf("scope changed from %q to %q", oldManifest.Scope, nextManifest.Scope))
	}

	oldPermissions := make(map[string]struct{}, len(oldManifest.Permissions))
	for _, permission := range oldManifest.Permissions {
		oldPermissions[permission] = struct{}{}
	}
	addedPermissions := make([]string, 0)
	for _, permission := range nextManifest.Permissions {
		if _, exists := oldPermissions[permission]; !exists {
			addedPermissions = append(addedPermissions, permission)
		}
	}
	sort.Strings(addedPermissions)
	for _, permission := range addedPermissions {
		changes = append(changes, fmt.Sprintf("permission added: %q", permission))
	}

	if oldKey, nextKey := packageSigner(old), packageSigner(next); oldKey != nextKey && oldKey != "" {
		changes = append(changes, fmt.Sprintf("signing key changed from %q to %q", oldKey, nextKey))
	}

	oldPalettes := make(map[string]Palette, len(oldManifest.Contributes.Palettes))
	for _, palette := range oldManifest.Contributes.Palettes {
		oldPalettes[palette.ID] = palette
	}
	addedPalettes, changedPalettes := make([]string, 0), make([]string, 0)
	for _, palette := range nextManifest.Contributes.Palettes {
		previous, exists := oldPalettes[palette.ID]
		switch {
		case !exists:
			addedPalettes = append(addedPalettes, palette.ID)
		case !reflect.DeepEqual(previous, palette):
			changedPalettes = append(changedPalettes, palette.ID)
		}
	}
	for _, id := range sortedStrings(addedPalettes) {
		changes = append(changes, fmt.Sprintf("palette added: %q", id))
	}
	for _, id := range sortedStrings(changedPalettes) {
		changes = append(changes, fmt.Sprintf("palette changed: %q", id))
	}

	oldBrushes := make(map[string]Brush, len(oldManifest.Contributes.Brushes))
	for _, brush := range oldManifest.Contributes.Brushes {
		oldBrushes[brush.ID] = brush
	}
	addedBrushes, changedBrushes := make([]string, 0), make([]string, 0)
	for _, brush := range nextManifest.Contributes.Brushes {
		previous, exists := oldBrushes[brush.ID]
		switch {
		case !exists:
			addedBrushes = append(addedBrushes, brush.ID)
		case !reflect.DeepEqual(previous, brush):
			changedBrushes = append(changedBrushes, brush.ID)
		}
	}
	for _, id := range sortedStrings(addedBrushes) {
		changes = append(changes, fmt.Sprintf("brush added: %q", id))
	}
	for _, id := range sortedStrings(changedBrushes) {
		changes = append(changes, fmt.Sprintf("brush changed: %q", id))
	}

	oldCommands := make(map[string]Command, len(oldManifest.Contributes.Commands))
	for _, command := range oldManifest.Contributes.Commands {
		oldCommands[command.ID] = command
	}
	addedCommands, changedCommands := make([]string, 0), make([]string, 0)
	for _, command := range nextManifest.Contributes.Commands {
		previous, exists := oldCommands[command.ID]
		switch {
		case !exists:
			addedCommands = append(addedCommands, command.ID)
		case !reflect.DeepEqual(previous, command):
			changedCommands = append(changedCommands, command.ID)
		}
	}
	for _, id := range sortedStrings(addedCommands) {
		changes = append(changes, fmt.Sprintf("command added: %q", id))
	}
	for _, id := range sortedStrings(changedCommands) {
		previous := oldCommands[id]
		next := commandByID(nextManifest.Contributes.Commands, id)
		if previous.Resource != next.Resource {
			changes = append(changes, fmt.Sprintf("command changed: %q (resource %q -> %q)", id, previous.Resource, next.Resource))
			continue
		}
		changes = append(changes, fmt.Sprintf("command changed: %q", id))
	}

	return changes
}

func packageSigner(pkg Package) string {
	if pkg.Signature == nil {
		return ""
	}
	return pkg.Signature.KeyID
}

func sortedStrings(values []string) []string {
	sort.Strings(values)
	return values
}

func commandByID(commands []Command, id string) Command {
	for _, command := range commands {
		if command.ID == id {
			return command
		}
	}
	return Command{}
}
