package coordinator

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestHTTPServerLifecycle(t *testing.T) {
	addr := os.Getenv("MARSHALL_REDIS_ADDR")
	if addr == "" {
		t.Skip("MARSHALL_REDIS_ADDR is required for Redis integration tests")
	}

	prefix := "marshall:http-test:" + strings.ReplaceAll(time.Now().UTC().Format(time.RFC3339Nano), ":", "-")
	server := httptest.NewServer(NewServer(NewRedisStore(addr, prefix)))
	defer server.Close()

	postJSON(t, server.URL+"/runs", Run{
		RunID:     "run_http_001",
		Objective: "prove coordinator HTTP lifecycle",
	}, http.StatusOK)
	postJSON(t, server.URL+"/workers", Worker{
		WorkerID:      "worker_http_001",
		PeerID:        "12D3KooWHTTP",
		Backend:       "mlx",
		DeviceFamily:  "apple_silicon",
		MemoryGB:      32,
		SupportedJobs: []string{"train_mlx_smoke"},
	}, http.StatusOK)
	postJSON(t, server.URL+"/jobs", Job{
		JobID:      "job_http_001",
		RunID:      "run_http_001",
		JobType:    "train_mlx_smoke",
		Backend:    "mlx",
		DatasetURI: "file://examples/datasets/tiny-italian.jsonl",
	}, http.StatusOK)

	var claim JobClaimResult
	postJSONInto(t, server.URL+"/jobs/job_http_001/claim", JobClaim{
		WorkerID:     "worker_http_001",
		PeerID:       "12D3KooWHTTP",
		LeaseSeconds: 60,
	}, http.StatusOK, &claim)
	if !claim.Accepted {
		t.Fatalf("expected HTTP claim accepted: %+v", claim)
	}

	postJSON(t, server.URL+"/jobs/job_http_001/status", JobStatus{
		WorkerID: "worker_http_001",
		Status:   "completed",
		Message:  "done",
	}, http.StatusOK)
	postJSON(t, server.URL+"/artifacts", Artifact{
		JobID:        "job_http_001",
		WorkerID:     "worker_http_001",
		PeerID:       "12D3KooWHTTP",
		ArtifactType: "mlx_smoke_result",
		ArtifactURI:  "file://artifacts/job_http_001/result.json",
		ArtifactHash: "sha256:http",
		ConfigHash:   "sha256:http-config",
	}, http.StatusOK)

	request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL+"/events?count=20", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("unexpected events status: %s", response.Status)
	}
	var events []Event
	if err := json.NewDecoder(response.Body).Decode(&events); err != nil {
		t.Fatal(err)
	}
	if len(events) < 6 {
		t.Fatalf("expected at least 6 lifecycle events, got %d", len(events))
	}
}

func postJSON(t *testing.T, url string, payload any, status int) {
	t.Helper()
	var output map[string]any
	postJSONInto(t, url, payload, status, &output)
}

func postJSONInto(t *testing.T, url string, payload any, status int, output any) {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != status {
		t.Fatalf("unexpected status for %s: got %s want %d", url, response.Status, status)
	}
	if err := json.NewDecoder(response.Body).Decode(output); err != nil {
		t.Fatal(err)
	}
}
