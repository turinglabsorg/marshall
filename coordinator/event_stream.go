package coordinator

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

func (server *Server) eventStream(response http.ResponseWriter, request *http.Request) {
	flusher, ok := response.(http.Flusher)
	if !ok {
		writeJSON(response, http.StatusInternalServerError, map[string]string{"error": "streaming is not supported"})
		return
	}

	lastID := request.Header.Get("Last-Event-ID")
	if lastID == "" {
		lastID = request.URL.Query().Get("last_id")
	}

	response.Header().Set("Content-Type", "text/event-stream")
	response.Header().Set("Cache-Control", "no-cache")
	response.Header().Set("Connection", "keep-alive")
	response.Header().Set("X-Accel-Buffering", "no")

	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()

	for {
		events, err := server.store.Events(request.Context(), 200)
		if err == nil {
			for _, event := range events {
				if lastID != "" && compareEventID(event.ID, lastID) <= 0 {
					continue
				}
				if writeSSEEvent(response, event) {
					lastID = event.ID
				}
			}
			flusher.Flush()
		}

		select {
		case <-request.Context().Done():
			return
		case <-ticker.C:
		}
	}
}

func writeSSEEvent(response http.ResponseWriter, event Event) bool {
	payload, err := json.Marshal(event)
	if err != nil {
		return false
	}
	_, _ = fmt.Fprintf(response, "id: %s\n", event.ID)
	_, _ = fmt.Fprint(response, "event: marshall_event\n")
	_, _ = fmt.Fprintf(response, "data: %s\n\n", payload)
	return true
}

func compareEventID(left string, right string) int {
	leftTime, leftSequence, leftOK := parseEventID(left)
	rightTime, rightSequence, rightOK := parseEventID(right)
	if !leftOK || !rightOK {
		return strings.Compare(left, right)
	}
	if leftTime < rightTime {
		return -1
	}
	if leftTime > rightTime {
		return 1
	}
	if leftSequence < rightSequence {
		return -1
	}
	if leftSequence > rightSequence {
		return 1
	}
	return 0
}

func parseEventID(value string) (int64, int64, bool) {
	parts := strings.Split(value, "-")
	if len(parts) != 2 {
		return 0, 0, false
	}
	eventTime, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return 0, 0, false
	}
	sequence, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		return 0, 0, false
	}
	return eventTime, sequence, true
}
