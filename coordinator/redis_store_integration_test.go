package coordinator

import (
	"context"
	"encoding/json"
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
	workers, err := store.Workers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(workers) != 1 || workers[0].WorkerID != "worker_mlx_001" || workers[0].MemoryGB != 32 {
		t.Fatalf("unexpected workers listing: %+v", workers)
	}
	if _, err := store.WorkerHeartbeat(ctx, WorkerHeartbeat{
		WorkerID:  "worker_mlx_001",
		PeerID:    "12D3KooWTest",
		Status:    "idle",
		Timestamp: nowUTC(),
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
	evalSpec := json.RawMessage(`{"job_id":"job_eval_001","run_id":"run_test_001","round_id":"round_001","job_type":"evaluate_adapter","backend":"mlx","adapter":{"adapter_id":"job_adapter_001","artifact_uri":"file://artifacts/job_adapter_001/adapters","artifact_hash":"sha256:adapter"},"eval_shard":{"id":"eval_jsonl","uri":"file://datasets/eval.jsonl","token_estimate":1,"hash":"sha256:eval"},"model":"mlx-community/Qwen2.5-0.5B-Instruct-4bit","max_examples":40,"max_tokens":8}`)
	if _, err := store.CreateJob(ctx, Job{
		JobID:      "job_eval_001",
		RunID:      "run_test_001",
		JobType:    "evaluate_adapter",
		Backend:    "mlx",
		DatasetURI: "file://datasets/eval.jsonl",
		JobSpec:    evalSpec,
	}); err != nil {
		t.Fatal(err)
	}
	evalJob, err := store.GetJob(ctx, "job_eval_001")
	if err != nil {
		t.Fatal(err)
	}
	if evalJob.JobType != "evaluate_adapter" || string(evalJob.JobSpec) != string(evalSpec) {
		t.Fatalf("unexpected persisted eval job: %+v", evalJob)
	}
	jobs, err := store.Jobs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 2 {
		t.Fatalf("expected two persisted jobs, got %+v", jobs)
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
	if _, err := store.WorkerHeartbeat(ctx, WorkerHeartbeat{
		WorkerID:     "worker_mlx_001",
		PeerID:       "12D3KooWTest",
		Status:       "working",
		CurrentJobID: "job_test_001",
		LeaseSeconds: 60,
		Timestamp:    nowUTC(),
	}); err != nil {
		t.Fatal(err)
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
	evalClaim, err := store.ClaimJob(ctx, JobClaim{
		JobID:        "job_eval_001",
		WorkerID:     "worker_mlx_001",
		PeerID:       "12D3KooWTest",
		LeaseSeconds: 60,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !evalClaim.Accepted {
		t.Fatalf("expected eval claim to be accepted: %+v", evalClaim)
	}
	if _, err := store.PublishArtifact(ctx, Artifact{
		JobID:        "job_eval_001",
		WorkerID:     "worker_mlx_001",
		PeerID:       "12D3KooWTest",
		ArtifactType: "adapter_evaluation",
		ArtifactURI:  "file://eval-artifacts/job_eval_001/metrics.json",
		ArtifactHash: "sha256:eval-artifact",
		ConfigHash:   "sha256:eval-config",
		MetricsURI:   "file://eval-artifacts/job_eval_001/metrics.json",
	}); err != nil {
		t.Fatal(err)
	}
	evalArtifact, err := store.GetArtifact(ctx, "job_eval_001")
	if err != nil {
		t.Fatal(err)
	}
	if evalArtifact.ArtifactType != "adapter_evaluation" || evalArtifact.MetricsURI == "" {
		t.Fatalf("unexpected persisted eval artifact: %+v", evalArtifact)
	}
	artifacts, err := store.Artifacts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(artifacts) != 2 {
		t.Fatalf("expected two persisted artifacts, got %+v", artifacts)
	}

	if _, err := store.CreateJob(ctx, Job{
		JobID:      "job_expiring_001",
		RunID:      "run_test_001",
		JobType:    "train_mlx_smoke",
		Backend:    "mlx",
		DatasetURI: "file://examples/datasets/tiny-italian.jsonl",
	}); err != nil {
		t.Fatal(err)
	}
	expiringClaim, err := store.ClaimJob(ctx, JobClaim{
		JobID:        "job_expiring_001",
		WorkerID:     "worker_mlx_001",
		PeerID:       "12D3KooWTest",
		LeaseSeconds: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !expiringClaim.Accepted {
		t.Fatalf("expected expiring claim to be accepted: %+v", expiringClaim)
	}
	time.Sleep(1100 * time.Millisecond)
	requeued, err := store.RequeueExpiredJobs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(requeued.Requeued) != 1 || requeued.Requeued[0] != "job_expiring_001" {
		t.Fatalf("unexpected requeue result: %+v", requeued)
	}
	requeuedJob, err := store.GetJob(ctx, "job_expiring_001")
	if err != nil {
		t.Fatal(err)
	}
	if requeuedJob.Status != "queued" || requeuedJob.WorkerID != "" {
		t.Fatalf("expected expired job to return to queue, got %+v", requeuedJob)
	}

	events, err := store.Events(ctx, 20)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, event := range events {
		seen[event.Type] = true
	}
	for _, eventType := range []string{"run_created", "worker_registered", "worker_heartbeat", "job_created", "job_claimed", "job_status_updated", "artifact_published", "job_requeued"} {
		if !seen[eventType] {
			t.Fatalf("missing event type %s in %#v", eventType, events)
		}
	}
}
