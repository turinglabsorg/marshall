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

	response, err := http.Get(server.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || !strings.Contains(response.Header.Get("Content-Type"), "text/html") {
		t.Fatalf("unexpected index response: %s %s", response.Status, response.Header.Get("Content-Type"))
	}

	response, err = http.Get(server.URL + "/AGENTS.md")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || !strings.Contains(response.Header.Get("Content-Type"), "text/markdown") {
		t.Fatalf("unexpected agents response: %s %s", response.Status, response.Header.Get("Content-Type"))
	}

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
	postJSON(t, server.URL+"/workers", Worker{
		WorkerID:      "validator_http_001",
		PeerID:        "12D3KooWHTTPValidator",
		Backend:       "cpu",
		DeviceFamily:  "generic_cpu",
		MemoryGB:      8,
		SupportedJobs: []string{"validate_artifact"},
	}, http.StatusOK)
	postJSON(t, server.URL+"/workers/worker_http_001/heartbeat", WorkerHeartbeat{
		WorkerID:  "worker_http_001",
		PeerID:    "12D3KooWHTTP",
		Status:    "idle",
		Timestamp: nowUTC(),
	}, http.StatusOK)
	postJSON(t, server.URL+"/jobs", Job{
		JobID:      "job_http_001",
		RunID:      "run_http_001",
		JobType:    "train_mlx_smoke",
		Backend:    "mlx",
		DatasetURI: "inline://tiny-italian-v1",
		JobSpec:    json.RawMessage(`{"job_id":"job_http_001","run_id":"run_http_001","job_type":"train_mlx_smoke"}`),
	}, http.StatusOK)
	var persistedJob Job
	getJSONInto(t, server.URL+"/jobs/job_http_001", http.StatusOK, &persistedJob)
	if persistedJob.JobID != "job_http_001" || len(persistedJob.JobSpec) == 0 {
		t.Fatalf("unexpected persisted job: %+v", persistedJob)
	}

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
	var persistedArtifact Artifact
	getJSONInto(t, server.URL+"/artifacts/job_http_001", http.StatusOK, &persistedArtifact)
	if persistedArtifact.ArtifactType != "mlx_smoke_result" || persistedArtifact.ArtifactHash != "sha256:http" {
		t.Fatalf("unexpected persisted artifact: %+v", persistedArtifact)
	}
	var artifacts []Artifact
	getJSONInto(t, server.URL+"/artifacts", http.StatusOK, &artifacts)
	if len(artifacts) != 1 || artifacts[0].JobID != "job_http_001" {
		t.Fatalf("unexpected artifact list: %+v", artifacts)
	}
	var verdict ArtifactVerdictResult
	postJSONInto(t, server.URL+"/artifacts/job_http_001/verdict", ArtifactVerdict{
		WorkerID:    "worker_http_001",
		ValidatorID: "validator_http_001",
		Verdict:     "accepted",
		Reason:      "artifact passed smoke validation",
	}, http.StatusOK, &verdict)
	if verdict.Reputation.Status != "active" || verdict.Reputation.Score != 100 || !verdict.ParticipationOK {
		t.Fatalf("unexpected verdict result: %+v", verdict)
	}
	var reputation WorkerReputation
	getJSONInto(t, server.URL+"/workers/worker_http_001/reputation", http.StatusOK, &reputation)
	if reputation.WorkerID != "worker_http_001" || reputation.AcceptedArtifacts != 1 {
		t.Fatalf("unexpected worker reputation: %+v", reputation)
	}

	request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL+"/events?count=20", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err = http.DefaultClient.Do(request)
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

	var dashboard DashboardSnapshot
	getJSONInto(t, server.URL+"/dashboard", http.StatusOK, &dashboard)
	if dashboard.Summary.WorkersRegistered != 2 || dashboard.Summary.JobsCompleted != 1 || dashboard.Summary.ArtifactsPublished != 1 {
		t.Fatalf("unexpected dashboard summary: %+v", dashboard.Summary)
	}
	if len(dashboard.Workers) != 2 {
		t.Fatalf("unexpected dashboard workers: %+v", dashboard.Workers)
	}
}

func TestHTTPServerAuthProtectsWrites(t *testing.T) {
	addr := os.Getenv("MARSHALL_REDIS_ADDR")
	if addr == "" {
		t.Skip("MARSHALL_REDIS_ADDR is required for Redis integration tests")
	}

	prefix := "marshall:http-auth-test:" + strings.ReplaceAll(time.Now().UTC().Format(time.RFC3339Nano), ":", "-")
	server := httptest.NewServer(NewServer(NewRedisStore(addr, prefix), WithAuthToken("secret-token")))
	defer server.Close()

	getJSONInto(t, server.URL+"/health", http.StatusOK, &map[string]string{})
	postJSON(t, server.URL+"/runs", Run{
		RunID:     "run_auth_001",
		Objective: "unauthorized write",
	}, http.StatusUnauthorized)
	postJSON(t, server.URL+"/artifacts/job_auth_001/verdict", ArtifactVerdict{
		WorkerID: "worker_auth_001",
		Verdict:  "accepted",
	}, http.StatusUnauthorized)
	postJSONWithToken(t, server.URL+"/runs", "wrong-token", Run{
		RunID:     "run_auth_001",
		Objective: "wrong token write",
	}, http.StatusUnauthorized)
	postJSONWithToken(t, server.URL+"/runs", "secret-token", Run{
		RunID:     "run_auth_001",
		Objective: "authorized write",
	}, http.StatusOK)
}

func getJSONInto(t *testing.T, url string, status int, output any) {
	t.Helper()
	response, err := http.Get(url)
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

func postJSON(t *testing.T, url string, payload any, status int) {
	t.Helper()
	var output map[string]any
	postJSONInto(t, url, payload, status, &output)
}

func postJSONWithToken(t *testing.T, url string, token string, payload any, status int) {
	t.Helper()
	var output map[string]any
	postJSONIntoWithToken(t, url, token, payload, status, &output)
}

func postJSONInto(t *testing.T, url string, payload any, status int, output any) {
	t.Helper()
	postJSONIntoWithToken(t, url, "", payload, status, output)
}

func postJSONIntoWithToken(t *testing.T, url string, token string, payload any, status int, output any) {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequestWithContext(context.Background(), http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := http.DefaultClient.Do(request)
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
