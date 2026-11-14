package room

import "testing"

func TestReadOnlyRejectionIdentifiesUnsavedCommand(t *testing.T) {
	out := make(chan Outbound, 1)
	actor := &Actor{roomID: "room", state: State{ReadOnly: true}}
	if actor.ensureWritable(ClientInfo{UserID: "user", Send: out}, "push-cmd", "unsaved-op") {
		t.Fatal("read-only room accepted a write")
	}
	message := (<-out).JSON.(Envelope)
	data := message.Data
	if message.Type != "op-rejected" || data["code"] != "DEGRADED_READ_ONLY" || data["cmdId"] != "unsaved-op" {
		t.Fatalf("unexpected rejection: %#v", message)
	}
}
