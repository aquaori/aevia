import fs from "node:fs";
import path from "node:path";

const probes: Record<string, Array<[string, string, string]>> = {
	"cmd/aevia-backend/main.go": [["main", "main", ""]],
	"internal/gateway/ws_handler.go": [["wsClient", "writeOutbound", "len(msg.Binary) + len(msg.Text)"]],
	"internal/gateway/ws_messages.go": [["", "handleBinaryClientMessage", "0"], ["", "handleTextClientMessage", "0"]],
	"internal/room/actor.go": [["Actor", "handleJoin", "len(a.inbox)"], ["Actor", "handlePageChange", "len(a.inbox)"], ["", "readSnapshot", "0"], ["", "sendOutbound", "len(ch)"]],
	"internal/room/stream_send.go": [["", "sendRenderStream", "0"], ["", "sendCommandStream", "0"], ["", "sendStreamOutbound", "0"]],
	"internal/room/snapshot_builder.go": [["SnapshotBuilder", "build", "len(state.Commands)"]],
	"internal/storage/writer.go": [["Writer", "enqueue", "len(w.writes)"], ["Writer", "applyBatchWithRecovery", "len(batch)"], ["Writer", "applyBatch", "len(batch)"]],
};

const runtime = `package config

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type profileEvent struct {
	Name string \`json:"name"\`
	Start float64 \`json:"startMs"\`
	End float64 \`json:"endMs"\`
	Count int \`json:"count"\`
}

var profileOrigin = time.Now()
var profileLock sync.Mutex
var profileActive = false
var profileSpans []profileEvent
var profileDropped int
var profileGeneration uint64

func profileNow() float64 { return float64(time.Since(profileOrigin)) / float64(time.Millisecond) }

func ProfileQueueStart() float64 { return profileNow() }
func ProfileQueueEnd(name string, start float64, depth int) {
	if start <= 0 { return }
	end := profileNow()
	profileLock.Lock()
	defer profileLock.Unlock()
	if !profileActive { return }
	if len(profileSpans) < 20000 {
		profileSpans = append(profileSpans, profileEvent{name, start, end, depth})
	} else { profileDropped++ }
}

func ProfileSpan(name string, count int) func() {
	profileLock.Lock()
	active, generation := profileActive, profileGeneration
	profileLock.Unlock()
	if !active { return func() {} }
	start := profileNow()
	return func() {
		end := profileNow()
		profileLock.Lock()
		defer profileLock.Unlock()
		if profileActive && profileGeneration == generation {
			if len(profileSpans) < 20000 {
				profileSpans = append(profileSpans, profileEvent{name, start, end, count})
			} else { profileDropped++ }
		}
	}
}

func StartProfileControl() {
	dir := os.Getenv("AEVIA_PROFILE_CONTROL")
	if dir == "" { return }
	go func() {
		reader := bufio.NewScanner(os.Stdin)
		for reader.Scan() {
			fields := strings.Fields(reader.Text())
			if len(fields) != 2 { continue }
			command, id := fields[0], fields[1]
			if strings.ContainsAny(id, "/\\\\.") { continue }
			profileLock.Lock()
			if command == "begin" {
				profileGeneration++
				profileActive, profileSpans, profileDropped = true, nil, 0
			}
			now := profileNow()
			var outputErr error
			if command == "end" {
				profileActive = false
				data, err := json.Marshal(map[string]any{"rows": profileSpans, "dropped": profileDropped})
				outputErr = err
				if err == nil { outputErr = os.WriteFile(filepath.Join(dir, id+".json"), data, 0600) }
				profileSpans = nil
			}
			profileLock.Unlock()
			fmt.Printf("AEVIA_PROFILE %s %.6f %t\\n", id, now, outputErr == nil)
		}
	}()
}
`;

export function createOverlay(root: string, output: string) {
	fs.mkdirSync(output, { recursive: true });
	const backend = path.join(root, "apps/backend");
	const replace: Record<string, string> = {};
	const put = (source: string, contents: string) => {
		const target = path.join(output, source.replaceAll("/", "-"));
		fs.writeFileSync(target, contents);
		replace[path.join(backend, source)] = target;
	};
	put("internal/config/profile_generated.go", runtime);
	const messages = "internal/room/messages.go";
	put(messages, fs.readFileSync(path.join(backend, messages), "utf8").replace("type clientEventMessage struct {", "type clientEventMessage struct {\n\tprofileQueuedAt float64"));
	for (const [file, entries] of Object.entries(probes)) {
		let code = fs.readFileSync(path.join(backend, file), "utf8");
		code = code.replace(/^(package \w+\r?\n)/, '$1\nimport profileDiagnostic "collaborative-whiteboard/apps/backend/internal/config"\n');
		for (const [receiver, name, count] of entries) {
			const prefix = receiver && receiver !== "main" ? `\\([^)]*\\b${receiver}\\) ` : "";
			const pattern = new RegExp(`^func ${prefix}${name}\\([^\\n]*? \\{`, "gm");
			const matches = [...code.matchAll(pattern)];
			if (matches.length !== 1) throw new Error(`Profiling anchor changed: ${file} ${name}`);
			const statement = receiver === "main" ? "profileDiagnostic.StartProfileControl()" :
				`defer profileDiagnostic.ProfileSpan("${file}:${name}", ${count})()`;
			code = code.replace(pattern, match => `${match}\n\t${statement}`);
		}
		if (file === "internal/room/actor.go") {
			code = code.replace("func (a *Actor) sendReliable(msg actorMessage) error {", `$&\n	if event, ok := msg.(clientEventMessage); ok { event.profileQueuedAt = profileDiagnostic.ProfileQueueStart(); msg = event }`)
				.replace(/case clientEventMessage:\r?\n/, '$&\t\tprofileDiagnostic.ProfileQueueEnd("actor.reliable.wait", m.profileQueuedAt, len(a.inbox))\n');
		}
		if (file === "internal/storage/writer.go") {
			code = code.replace("type writeRequest struct {", "$&\n\tprofileQueuedAt float64")
				.replace("func (w *Writer) enqueue(req writeRequest, wait bool) error {", "$&\n\treq.profileQueuedAt = profileDiagnostic.ProfileQueueStart()")
				.replace("results, err := w.applyBatchWithRecovery", `for _, req := range batch { profileDiagnostic.ProfileQueueEnd("sqlite.batch.wait", req.profileQueuedAt, len(w.writes)) }\n		results, err := w.applyBatchWithRecovery`);
		}
		put(file, code);
	}
	const file = path.join(output, "overlay.json");
	fs.writeFileSync(file, JSON.stringify({ Replace: replace }));
	return file;
}
