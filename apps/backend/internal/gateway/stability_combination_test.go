package gateway

import (
	"net/http"
	"testing"

	"github.com/coder/websocket"
)

func TestDeleteRoomAndRecreateSameIDKeepsCleanStateAndRevokesOldTokens(t *testing.T) {
	server := newTestServer(t)
	ownerToken, ownerID := registerTestAccount(t, server, "lifecycleowner")
	const roomID = "777901"

	if st, body := do(t, server, "POST", "/v2/rooms", map[string]any{"roomId": roomID, "roomName": "First"}, ownerToken); st != http.StatusOK {
		t.Fatalf("create room: %d %+v", st, body)
	}
	st, adm := do(t, server, "POST", "/v2/rooms/"+roomID+"/admission", map[string]any{}, ownerToken)
	if st != http.StatusOK {
		t.Fatalf("admission: %d %+v", st, adm)
	}
	oldGrant := adm.Data["token"].(string)

	conn := dialGatewayWebsocket(t, server, oldGrant)
	readGatewayWSType(t, conn, "init-complete")
	writeGatewayWSJSON(t, conn, testScenePush("pre-delete-stroke", ownerID, roomID))
	readGatewayWSType(t, conn, "ack.accepted")
	conn.Close(websocket.StatusNormalClosure, "")

	if st, body := do(t, server, "DELETE", "/v2/rooms/"+roomID, nil, ownerToken); st != http.StatusOK {
		t.Fatalf("delete room: %d %+v", st, body)
	}
	if st, _ := do(t, server, "GET", "/get-page-review?roomId="+roomID+"&pageId=0", nil, oldGrant); st == http.StatusOK {
		t.Fatalf("expected deleted room old token to fail page review, got 200")
	}
	if st, _ := do(t, server, "POST", "/renew-room-session", map[string]any{"roomId": roomID}, oldGrant); st == http.StatusOK {
		t.Fatalf("expected deleted room old token to fail renew, got 200")
	}

	// Recreate the same room ID and verify zero leaked state and old grant still rejected.
	if st, body := do(t, server, "POST", "/v2/rooms", map[string]any{"roomId": roomID, "roomName": "Recreated"}, ownerToken); st != http.StatusOK {
		t.Fatalf("recreate room: %d %+v", st, body)
	}
	if st, _ := do(t, server, "GET", "/get-page-review?roomId="+roomID+"&pageId=0", nil, oldGrant); st == http.StatusOK {
		t.Fatalf("expected pre-delete room token to fail against recreated room, got 200")
	}
	st, nextAdm := do(t, server, "POST", "/v2/rooms/"+roomID+"/admission", map[string]any{}, ownerToken)
	if st != http.StatusOK {
		t.Fatalf("re-admission: %d %+v", st, nextAdm)
	}
	recreatedConn := dialGatewayWebsocket(t, server, nextAdm.Data["token"].(string))
	defer recreatedConn.Close(websocket.StatusNormalClosure, "")
	initIDs := readGatewayInitCommandIDs(t, recreatedConn)
	for _, id := range initIDs {
		if id == "pre-delete-stroke" {
			t.Fatalf("deleted room command leaked into recreated room: %v", initIDs)
		}
	}
}

func TestMultiClientClearUndoAndImmediateDrawConverge(t *testing.T) {
	server := newTestServer(t)
	ownerToken, ownerID := registerTestAccount(t, server, "clearowner")
	const roomID = "777902"

	if st, body := do(t, server, "POST", "/v2/rooms", map[string]any{"roomId": roomID, "roomName": "ClearRoom"}, ownerToken); st != http.StatusOK {
		t.Fatalf("create room: %d %+v", st, body)
	}
	_, ownerAdm := do(t, server, "POST", "/v2/rooms/"+roomID+"/admission", map[string]any{}, ownerToken)
	_, guestJoin := do(t, server, "POST", "/join-room", map[string]any{"roomId": roomID, "userName": "GuestB"}, "")
	guestToken := guestJoin.Data["sessionToken"].(string)

	connA := dialGatewayWebsocket(t, server, ownerAdm.Data["token"].(string))
	defer connA.Close(websocket.StatusNormalClosure, "")
	readGatewayWSType(t, connA, "init-complete")

	connB := dialGatewayWebsocket(t, server, guestToken)
	defer connB.Close(websocket.StatusNormalClosure, "")
	metaB := readGatewayWSType(t, connB, "init-meta")
	guestID := metaB.Data["userId"].(string)
	readGatewayWSType(t, connB, "init-complete")

	pushStroke := func(conn *websocket.Conn, opID, actorID string, lamport float64) {
		msg := testScenePush(opID, actorID, roomID)
		cmd := msg["data"].(map[string]any)["cmd"].(map[string]any)
		op := cmd["sceneOperation"].(map[string]any)
		cmd["lamport"] = lamport
		op["lamport"] = lamport
		pts := op["payload"].(map[string]any)["points"].([]any)
		pts[0].(map[string]any)["lamport"] = lamport
		writeGatewayWSJSON(t, conn, msg)
		readGatewayWSType(t, conn, "ack.accepted")
	}

	// Both peers draw before clear.
	pushStroke(connA, "stroke-a1", ownerID, 10)
	pushStroke(connB, "stroke-b1", guestID, 11)

	// Peer A clears the page.
	clearMsg := testScenePush("clear-1", ownerID, roomID)
	clearCmd := clearMsg["data"].(map[string]any)["cmd"].(map[string]any)
	clearOp := clearCmd["sceneOperation"].(map[string]any)
	clearCmd["lamport"] = float64(12)
	clearOp["lamport"] = float64(12)
	clearOp["elementId"] = "page:0"
	clearOp["kind"] = "page.clear"
	clearOp["payload"] = map[string]any{
		"before": map[string]any{
			"lamport":     float64(12),
			"opId":        "clear-1",
			"sourceIndex": float64(0),
			"subIndex":    float64(0),
		},
	}
	writeGatewayWSJSON(t, connA, clearMsg)
	readGatewayWSType(t, connA, "ack.accepted")

	// Peer B continues drawing immediately after clear (H05).
	pushStroke(connB, "stroke-b2-after-clear", guestID, 13)

	// Fresh viewer after clear sees stroke-b2-after-clear in active init-commands.
	_, cJoin := do(t, server, "POST", "/join-room", map[string]any{"roomId": roomID, "userName": "ViewerC"}, "")
	connC := dialGatewayWebsocket(t, server, cJoin.Data["sessionToken"].(string))
	afterClearIDs := readGatewayInitCommandIDs(t, connC)
	connC.Close(websocket.StatusNormalClosure, "")
	has := func(list []string, target string) bool {
		for _, item := range list {
			if item == target {
				return true
			}
		}
		return false
	}
	if !has(afterClearIDs, "stroke-b2-after-clear") {
		t.Fatalf("expected post-clear stroke to survive in active window, got %v", afterClearIDs)
	}

	// Peer A undoes clear -> stroke-a1, stroke-b1, and stroke-b2-after-clear must all recover on fresh init (H04/H53).
	undoMsg := testScenePush("undo-clear-1", ownerID, roomID)
	undoCmd := undoMsg["data"].(map[string]any)["cmd"].(map[string]any)
	undoOp := undoCmd["sceneOperation"].(map[string]any)
	undoCmd["lamport"] = float64(14)
	undoOp["lamport"] = float64(14)
	undoOp["kind"] = "history.toggle"
	undoOp["payload"] = map[string]any{"targetHistoryGroupId": "history-clear-1", "enabled": false}
	writeGatewayWSJSON(t, connA, undoMsg)
	readGatewayWSType(t, connA, "ack.accepted")

	_, dJoin := do(t, server, "POST", "/join-room", map[string]any{"roomId": roomID, "userName": "ViewerD"}, "")
	connD := dialGatewayWebsocket(t, server, dJoin.Data["sessionToken"].(string))
	afterUndoIDs := readGatewayInitCommandIDs(t, connD)
	connD.Close(websocket.StatusNormalClosure, "")
	for _, want := range []string{"stroke-a1", "stroke-b1", "stroke-b2-after-clear"} {
		if !has(afterUndoIDs, want) {
			t.Fatalf("expected %q after undoing clear, got %v", want, afterUndoIDs)
		}
	}
}

func TestOutOfOrderSceneOpsProjectAfterLateCreateAndSurviveReconnect(t *testing.T) {
	server := newTestServer(t)
	ownerToken, ownerID := registerTestAccount(t, server, "oooowner")
	const roomID = "777903"

	if st, body := do(t, server, "POST", "/v2/rooms", map[string]any{"roomId": roomID, "roomName": "OOORoom"}, ownerToken); st != http.StatusOK {
		t.Fatalf("create room: %d %+v", st, body)
	}
	_, ownerAdm := do(t, server, "POST", "/v2/rooms/"+roomID+"/admission", map[string]any{}, ownerToken)
	conn := dialGatewayWebsocket(t, server, ownerAdm.Data["token"].(string))
	readGatewayWSType(t, conn, "init-complete")

	// Send element.append BEFORE element.create for "el-ooo-ws", plus orphan text.patch.
	appendMsg := testScenePush("op-ooo-append", ownerID, roomID)
	appendCmd := appendMsg["data"].(map[string]any)["cmd"].(map[string]any)
	appendOp := appendCmd["sceneOperation"].(map[string]any)
	appendCmd["lamport"] = float64(2)
	appendOp["lamport"] = float64(2)
	appendOp["elementId"] = "el-ooo-ws"
	appendOp["kind"] = "element.append"
	appendOp["payload"] = map[string]any{
		"sourceStart": float64(1),
		"points":      []any{map[string]any{"x": 0.4, "y": 0.5, "p": 0.5, "lamport": 2.0}},
	}
	writeGatewayWSJSON(t, conn, appendMsg)
	readGatewayWSType(t, conn, "ack.accepted")

	// Now send the late matching element.create.
	createMsg := testScenePush("op-ooo-create", ownerID, roomID)
	createCmd := createMsg["data"].(map[string]any)["cmd"].(map[string]any)
	createOp := createCmd["sceneOperation"].(map[string]any)
	createCmd["lamport"] = float64(1)
	createOp["lamport"] = float64(1)
	createOp["elementId"] = "el-ooo-ws"
	writeGatewayWSJSON(t, conn, createMsg)
	readGatewayWSType(t, conn, "ack.accepted")
	conn.Close(websocket.StatusNormalClosure, "")

	// Rejoin and verify both operations exist in init-commands AND the render point count includes both points (2 points).
	_, viewerJoin := do(t, server, "POST", "/join-room", map[string]any{"roomId": roomID, "userName": "ViewerOOO"}, "")
	viewerConn := dialGatewayWebsocket(t, server, viewerJoin.Data["sessionToken"].(string))
	defer viewerConn.Close(websocket.StatusNormalClosure, "")
	initMeta := readGatewayWSType(t, viewerConn, "init-meta")
	summary, _ := initMeta.Data["chunkSummary"].(map[string]any)
	pointCount, _ := summary["pointCount"].(float64)
	if pointCount != 2 {
		t.Fatalf("expected both create and earlier out-of-order append points in PagePointIndex (2), got pointCount=%v summary=%+v", pointCount, summary)
	}
	readGatewayWSType(t, viewerConn, "init-complete")
}
