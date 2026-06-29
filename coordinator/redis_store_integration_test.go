package coordinator

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

func TestRedisStoreLifecycle(t *testing.T) {
	addr := os.Getenv("MARSHALL_REDIS_ADDR")
	if addr == "" {
		t.Skip("MARSHALL_REDIS_ADDR is required for Redis integration tests")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	prefix := "marshall:test:" + strings.ReplaceAll(time.Now().UTC().Format(time.RFC3339Nano), ":", "-")
	store := NewRedisStore(addr, prefix)

	runEvent, err := store.CreateRun(ctx, Run{
		RunID:     "run_test_001",
		Objective: "prove redis-backed coordinator state",
	})
	if err != nil {
		t.Fatal(err)
	}
	if runEvent.Type != "run_created" {
		t.Fatalf("unexpected run event type: %s", runEvent.Type)
	}

	if _, err := store.RegisterWorker(ctx, Worker{
		WorkerID:      "worker_mlx_001",
		PeerID:        "12D3KooWTest",
		Backend:       "mlx",
		DeviceFamily:  "apple_silicon",
		MemoryGB:      32,
		SupportedJobs: []string{"train_mlx_smoke", "train_toy_model"},
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := store.CreateJob(ctx, Job{
		JobID:      "job_test_001",
		RunID:      "run_test_001",
		JobType:    "train_mlx_smoke",
		Backend:    "mlx",
		DatasetURI: "file://examples/datasets/tiny-italian.jsonl",
	}); err != nil {
		t.Fatal(err)
	}

	claim, err := store.ClaimJob(ctx, JobClaim{
		JobID:        "job_test_001",
		WorkerID:     "worker_mlx_001",
		PeerID:       "12D3KooWTest",
		LeaseSeconds: 60,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !claim.Accepted {
		t.Fatalf("expected first claim to be accepted: %+v", claim)
	}

	secondClaim, err := store.ClaimJob(ctx, JobClaim{
		JobID:        "job_test_001",
		WorkerID:     "worker_mlx_002",
		PeerID:       "12D3KooWOther",
		LeaseSeconds: 60,
	})
	if err != nil {
		t.Fatal(err)
	}
	if secondClaim.Accepted {
		t.Fatalf("expected second claim to be rejected: %+v", secondClaim)
	}

	if _, err := store.UpdateJobStatus(ctx, JobStatus{
		JobID:    "job_test_001",
		WorkerID: "worker_mlx_001",
		Status:   "completed",
		Message:  "mlx smoke finished",
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := store.PublishArtifact(ctx, Artifact{
		JobID:        "job_test_001",
		WorkerID:     "worker_mlx_001",
		PeerID:       "12D3KooWTest",
		ArtifactType: "mlx_smoke_result",
		ArtifactURI:  "file://artifacts/job_test_001/result.json",
		ArtifactHash: "sha256:test",
		ConfigHash:   "sha256:config",
	}); err != nil {
		t.Fatal(err)
	}

	events, err := store.Events(ctx, 20)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, event := range events {
		seen[event.Type] = true
	}
	for _, eventType := range []string{"run_created", "worker_registered", "job_created", "job_claimed", "job_status_updated", "artifact_published"} {
		if !seen[eventType] {
			t.Fatalf("missing event type %s in %#v", eventType, events)
		}
	}
}
