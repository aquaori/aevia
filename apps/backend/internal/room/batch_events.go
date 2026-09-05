package room

func (a *Actor) handleBatchMove(client ClientInfo, msg clientEventMessage) {
	a.reject(client, msg.Type, "UPGRADE_REQUIRED", "Mutable batch transforms were removed; submit an immutable scene operation.", "")
}

func (a *Actor) handleBatchUpdate(client ClientInfo, msg clientEventMessage) {
	a.reject(client, msg.Type, "UPGRADE_REQUIRED", "Mutable batch transforms were removed; submit an immutable scene operation.", "")
}
