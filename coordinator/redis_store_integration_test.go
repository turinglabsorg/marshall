package coordinator

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"sync"
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
		DatasetURI: "inline://tiny-italian-v1",
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
	if _, err := store.RegisterWorker(ctx, Worker{
		WorkerID:      "validator_test_001",
		PeerID:        "12D3KooWValidatorTest",
		Backend:       "cpu",
		DeviceFamily:  "generic_cpu",
		MemoryGB:      8,
		SupportedJobs: []string{"validate_artifact"},
	}); err != nil {
		t.Fatal(err)
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
		DatasetURI: "inline://tiny-italian-v1",
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
	timeoutReputation, err := store.WorkerReputation(ctx, "worker_mlx_001")
	if err != nil {
		t.Fatal(err)
	}
	if timeoutReputation.TimeoutJobs != 1 || timeoutReputation.Score != 85 || timeoutReputation.Status != "active" {
		t.Fatalf("expected timeout to reduce reputation without suspending worker, got %+v", timeoutReputation)
	}
	requeuedJob, err := store.GetJob(ctx, "job_expiring_001")
	if err != nil {
		t.Fatal(err)
	}
	if requeuedJob.Status != "queued" || requeuedJob.WorkerID != "" {
		t.Fatalf("expected expired job to return to queue, got %+v", requeuedJob)
	}

	verdict, err := store.RecordArtifactVerdict(ctx, ArtifactVerdict{
		JobID:       "job_eval_001",
		WorkerID:    "worker_mlx_001",
		ValidatorID: "validator_test_001",
		Verdict:     "malicious",
		Reason:      "canary labels were inverted",
	})
	if err != nil {
		t.Fatal(err)
	}
	if verdict.ScoreDelta != -100 || verdict.Reputation.Status != "suspended" || verdict.ParticipationOK {
		t.Fatalf("expected malicious verdict to suspend worker, got %+v", verdict)
	}
	if _, err := store.CreateJob(ctx, Job{
		JobID:      "job_after_suspend_001",
		RunID:      "run_test_001",
		JobType:    "train_mlx_smoke",
		Backend:    "mlx",
		DatasetURI: "inline://tiny-italian-v1",
	}); err != nil {
		t.Fatal(err)
	}
	suspendedClaim, err := store.ClaimJob(ctx, JobClaim{
		JobID:        "job_after_suspend_001",
		WorkerID:     "worker_mlx_001",
		PeerID:       "12D3KooWTest",
		LeaseSeconds: 60,
	})
	if err != nil {
		t.Fatal(err)
	}
	if suspendedClaim.Accepted || suspendedClaim.Reason != "worker suspended" {
		t.Fatalf("expected suspended worker claim rejected, got %+v", suspendedClaim)
	}
	verdictArtifact, err := store.GetArtifact(ctx, "job_eval_001")
	if err != nil {
		t.Fatal(err)
	}
	if verdictArtifact.Verdict != "malicious" || verdictArtifact.VerdictAt == "" {
		t.Fatalf("expected artifact verdict fields, got %+v", verdictArtifact)
	}

	unregisteredClaim, err := store.ClaimJob(ctx, JobClaim{
		JobID:        "job_after_suspend_001",
		WorkerID:     "worker_unknown",
		PeerID:       "12D3KooWUnknown",
		LeaseSeconds: 60,
	})
	if err != nil {
		t.Fatal(err)
	}
	if unregisteredClaim.Accepted || unregisteredClaim.Reason != "worker not registered" {
		t.Fatalf("expected unregistered worker claim rejected, got %+v", unregisteredClaim)
	}

	events, err := store.Events(ctx, 40)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, event := range events {
		seen[event.Type] = true
	}
	for _, eventType := range []string{"run_created", "worker_registered", "worker_heartbeat", "job_created", "job_claimed", "job_status_updated", "artifact_published", "job_requeued", "worker_reputation_updated", "artifact_verdict_recorded"} {
		if !seen[eventType] {
			t.Fatalf("missing event type %s in %#v", eventType, events)
		}
	}
}

func TestRedisStoreRequeueExpiredJobsIsIdempotentAndClaimable(t *testing.T) {
	addr := os.Getenv("MARSHALL_REDIS_ADDR")
	if addr == "" {
		t.Skip("MARSHALL_REDIS_ADDR is required for Redis integration tests")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	prefix := "marshall:requeue-idempotent-test:" + strings.ReplaceAll(time.Now().UTC().Format(time.RFC3339Nano), ":", "-")
	store := NewRedisStore(addr, prefix)

	if _, err := store.CreateRun(ctx, Run{
		RunID:     "run_requeue_001",
		Objective: "prove expired jobs requeue exactly once",
	}); err != nil {
		t.Fatal(err)
	}
	for _, worker := range []struct {
		workerID string
		peerID   string
	}{
		{"worker_requeue_timeout_001", "12D3KooWRequeueTimeout"},
		{"worker_requeue_reclaim_001", "12D3KooWRequeueReclaim"},
	} {
		if _, err := store.RegisterWorker(ctx, Worker{
			WorkerID:      worker.workerID,
			PeerID:        worker.peerID,
			Backend:       "mlx",
			DeviceFamily:  "apple_silicon",
			MemoryGB:      32,
			SupportedJobs: []string{"train_mlx_smoke"},
		}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.CreateJob(ctx, Job{
		JobID:      "job_requeue_001",
		RunID:      "run_requeue_001",
		JobType:    "train_mlx_smoke",
		Backend:    "mlx",
		DatasetURI: "inline://tiny-italian-v1",
	}); err != nil {
		t.Fatal(err)
	}
	claim, err := store.ClaimJob(ctx, JobClaim{
		JobID:        "job_requeue_001",
		WorkerID:     "worker_requeue_timeout_001",
		PeerID:       "12D3KooWRequeueTimeout",
		LeaseSeconds: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !claim.Accepted {
		t.Fatalf("expected original claim accepted: %+v", claim)
	}

	time.Sleep(1100 * time.Millisecond)
	firstRequeue, err := store.RequeueExpiredJobs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(firstRequeue.Requeued) != 1 || firstRequeue.Requeued[0] != "job_requeue_001" {
		t.Fatalf("expected job requeued once, got %+v", firstRequeue)
	}
	secondRequeue, err := store.RequeueExpiredJobs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(secondRequeue.Requeued) != 0 {
		t.Fatalf("expected second requeue scan to be idempotent, got %+v", secondRequeue)
	}
	timeoutReputation, err := store.WorkerReputation(ctx, "worker_requeue_timeout_001")
	if err != nil {
		t.Fatal(err)
	}
	if timeoutReputation.TimeoutJobs != 1 || timeoutReputation.Score != 85 {
		t.Fatalf("expected one timeout reputation penalty, got %+v", timeoutReputation)
	}

	reclaim, err := store.ClaimJob(ctx, JobClaim{
		JobID:        "job_requeue_001",
		WorkerID:     "worker_requeue_reclaim_001",
		PeerID:       "12D3KooWRequeueReclaim",
		LeaseSeconds: 60,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !reclaim.Accepted {
		t.Fatalf("expected requeued job to be claimable by another worker: %+v", reclaim)
	}
	job, err := store.GetJob(ctx, "job_requeue_001")
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != "claimed" || job.WorkerID != "worker_requeue_reclaim_001" {
		t.Fatalf("expected job reclaimed by second worker, got %+v", job)
	}
}

func TestRedisStoreArtifactVerdictQuorum(t *testing.T) {
	addr := os.Getenv("MARSHALL_REDIS_ADDR")
	if addr == "" {
		t.Skip("MARSHALL_REDIS_ADDR is required for Redis integration tests")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	prefix := "marshall:quorum-test:" + strings.ReplaceAll(time.Now().UTC().Format(time.RFC3339Nano), ":", "-")
	store := NewRedisStore(addr, prefix)

	if _, err := store.CreateRun(ctx, Run{
		RunID:     "run_quorum_001",
		Objective: "prove validator quorum before artifact finalization",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.RegisterWorker(ctx, Worker{
		WorkerID:      "worker_quorum_target_001",
		PeerID:        "12D3KooWQuorumTarget",
		Backend:       "mlx",
		DeviceFamily:  "apple_silicon",
		MemoryGB:      32,
		SupportedJobs: []string{"evaluate_adapter"},
	}); err != nil {
		t.Fatal(err)
	}
	for _, validator := range []struct {
		workerID string
		peerID   string
	}{
		{"validator_quorum_001", "12D3KooWQuorumValidatorOne"},
		{"validator_quorum_002", "12D3KooWQuorumValidatorTwo"},
		{"validator_quorum_003", "12D3KooWQuorumValidatorThree"},
	} {
		if _, err := store.RegisterWorker(ctx, Worker{
			WorkerID:      validator.workerID,
			PeerID:        validator.peerID,
			Backend:       "cpu",
			DeviceFamily:  "generic_cpu",
			MemoryGB:      8,
			SupportedJobs: []string{"validate_artifact"},
		}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.CreateJob(ctx, Job{
		JobID:      "job_quorum_eval_001",
		RunID:      "run_quorum_001",
		JobType:    "evaluate_adapter",
		Backend:    "mlx",
		DatasetURI: "file://datasets/eval.jsonl",
	}); err != nil {
		t.Fatal(err)
	}
	claim, err := store.ClaimJob(ctx, JobClaim{
		JobID:        "job_quorum_eval_001",
		WorkerID:     "worker_quorum_target_001",
		PeerID:       "12D3KooWQuorumTarget",
		LeaseSeconds: 60,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !claim.Accepted {
		t.Fatalf("expected target job claim accepted: %+v", claim)
	}
	if _, err := store.PublishArtifact(ctx, Artifact{
		JobID:        "job_quorum_eval_001",
		WorkerID:     "worker_quorum_target_001",
		PeerID:       "12D3KooWQuorumTarget",
		ArtifactType: "adapter_evaluation",
		ArtifactURI:  "file://eval-artifacts/job_quorum_eval_001/metrics.json",
		ArtifactHash: "sha256:quorum-eval",
		ConfigHash:   "sha256:quorum-config",
		MetricsURI:   "file://eval-artifacts/job_quorum_eval_001/metrics.json",
	}); err != nil {
		t.Fatal(err)
	}

	first, err := store.RecordArtifactVerdict(ctx, ArtifactVerdict{
		JobID:       "job_quorum_eval_001",
		WorkerID:    "worker_quorum_target_001",
		ValidatorID: "validator_quorum_001",
		Verdict:     "accepted",
		Reason:      "first validator accepted",
		Quorum:      2,
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.Finalized || first.ScoreDelta != 0 || first.Votes != 1 || first.Quorum != 2 || first.Tally["accepted"] != 1 {
		t.Fatalf("expected first vote to remain pending, got %+v", first)
	}
	artifact, err := store.GetArtifact(ctx, "job_quorum_eval_001")
	if err != nil {
		t.Fatal(err)
	}
	if artifact.Verdict != "" || artifact.VerdictStatus != "pending" || artifact.VerdictVotes != 1 || artifact.VerdictQuorum != 2 {
		t.Fatalf("expected pending artifact after first vote, got %+v", artifact)
	}
	reputation, err := store.WorkerReputation(ctx, "worker_quorum_target_001")
	if err != nil {
		t.Fatal(err)
	}
	if reputation.AcceptedArtifacts != 0 || reputation.RejectedArtifacts != 0 || reputation.Score != 100 {
		t.Fatalf("expected pending vote not to affect reputation, got %+v", reputation)
	}

	second, err := store.RecordArtifactVerdict(ctx, ArtifactVerdict{
		JobID:       "job_quorum_eval_001",
		WorkerID:    "worker_quorum_target_001",
		ValidatorID: "validator_quorum_002",
		Verdict:     "rejected",
		Reason:      "second validator rejected",
		Quorum:      2,
	})
	if err != nil {
		t.Fatal(err)
	}
	if second.Finalized || second.Votes != 2 || second.Tally["accepted"] != 1 || second.Tally["rejected"] != 1 {
		t.Fatalf("expected split vote to remain pending, got %+v", second)
	}

	third, err := store.RecordArtifactVerdict(ctx, ArtifactVerdict{
		JobID:       "job_quorum_eval_001",
		WorkerID:    "worker_quorum_target_001",
		ValidatorID: "validator_quorum_003",
		Verdict:     "rejected",
		Reason:      "third validator rejected",
		Quorum:      2,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !third.Finalized || third.FinalVerdict != "rejected" || third.ScoreDelta != -25 || third.Reputation.Score != 75 || third.Reputation.RejectedArtifacts != 1 {
		t.Fatalf("expected rejected quorum to finalize once, got %+v", third)
	}
	validatorUpdates := validatorUpdatesByID(third.ValidatorReputations)
	if validatorUpdates["validator_quorum_001"].Aligned || validatorUpdates["validator_quorum_001"].ScoreDelta != -25 {
		t.Fatalf("expected diverging validator to be penalized, got %+v", validatorUpdates["validator_quorum_001"])
	}
	if !validatorUpdates["validator_quorum_002"].Aligned || validatorUpdates["validator_quorum_002"].Reputation.AcceptedArtifacts != 1 {
		t.Fatalf("expected aligned validator to be rewarded, got %+v", validatorUpdates["validator_quorum_002"])
	}
	artifact, err = store.GetArtifact(ctx, "job_quorum_eval_001")
	if err != nil {
		t.Fatal(err)
	}
	if artifact.Verdict != "rejected" || artifact.VerdictStatus != "finalized" || artifact.VerdictVotes != 3 || artifact.VerdictQuorum != 2 {
		t.Fatalf("expected finalized rejected artifact, got %+v", artifact)
	}

	duplicate, err := store.RecordArtifactVerdict(ctx, ArtifactVerdict{
		JobID:       "job_quorum_eval_001",
		WorkerID:    "worker_quorum_target_001",
		ValidatorID: "validator_quorum_003",
		Verdict:     "rejected",
		Reason:      "duplicate vote",
		Quorum:      2,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !duplicate.Finalized || duplicate.Reputation.RejectedArtifacts != 1 {
		t.Fatalf("expected duplicate finalized response without extra reputation change, got %+v", duplicate)
	}
}

func TestRedisStoreMaliciousArtifactSuspendsCoveringValidator(t *testing.T) {
	addr := os.Getenv("MARSHALL_REDIS_ADDR")
	if addr == "" {
		t.Skip("MARSHALL_REDIS_ADDR is required for Redis integration tests")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	prefix := "marshall:malicious-validator-test:" + strings.ReplaceAll(time.Now().UTC().Format(time.RFC3339Nano), ":", "-")
	store := NewRedisStore(addr, prefix)

	if _, err := store.CreateRun(ctx, Run{
		RunID:     "run_malicious_validator_001",
		Objective: "prove validators are slashed for covering malicious artifacts",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.RegisterWorker(ctx, Worker{
		WorkerID:      "worker_malicious_target_001",
		PeerID:        "12D3KooWMaliciousTarget",
		Backend:       "mlx",
		DeviceFamily:  "apple_silicon",
		MemoryGB:      32,
		SupportedJobs: []string{"evaluate_adapter"},
	}); err != nil {
		t.Fatal(err)
	}
	for _, validator := range []struct {
		workerID string
		peerID   string
	}{
		{"validator_malicious_cover_001", "12D3KooWMaliciousCover"},
		{"validator_malicious_detect_001", "12D3KooWMaliciousDetectOne"},
		{"validator_malicious_detect_002", "12D3KooWMaliciousDetectTwo"},
	} {
		if _, err := store.RegisterWorker(ctx, Worker{
			WorkerID:      validator.workerID,
			PeerID:        validator.peerID,
			Backend:       "cpu",
			DeviceFamily:  "generic_cpu",
			MemoryGB:      8,
			SupportedJobs: []string{"validate_artifact"},
		}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.CreateJob(ctx, Job{
		JobID:      "job_malicious_eval_001",
		RunID:      "run_malicious_validator_001",
		JobType:    "evaluate_adapter",
		Backend:    "mlx",
		DatasetURI: "file://datasets/eval.jsonl",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ClaimJob(ctx, JobClaim{
		JobID:        "job_malicious_eval_001",
		WorkerID:     "worker_malicious_target_001",
		PeerID:       "12D3KooWMaliciousTarget",
		LeaseSeconds: 60,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.PublishArtifact(ctx, Artifact{
		JobID:        "job_malicious_eval_001",
		WorkerID:     "worker_malicious_target_001",
		PeerID:       "12D3KooWMaliciousTarget",
		ArtifactType: "adapter_evaluation",
		ArtifactURI:  "file://eval-artifacts/job_malicious_eval_001/metrics.json",
		ArtifactHash: "sha256:malicious-eval",
		ConfigHash:   "sha256:malicious-config",
		MetricsURI:   "file://eval-artifacts/job_malicious_eval_001/metrics.json",
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := store.RecordArtifactVerdict(ctx, ArtifactVerdict{
		JobID:       "job_malicious_eval_001",
		WorkerID:    "worker_malicious_target_001",
		ValidatorID: "validator_malicious_cover_001",
		Verdict:     "accepted",
		Reason:      "covering malicious artifact",
		Quorum:      2,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.RecordArtifactVerdict(ctx, ArtifactVerdict{
		JobID:       "job_malicious_eval_001",
		WorkerID:    "worker_malicious_target_001",
		ValidatorID: "validator_malicious_detect_001",
		Verdict:     "malicious",
		Reason:      "hash mismatch",
		Quorum:      2,
	}); err != nil {
		t.Fatal(err)
	}
	final, err := store.RecordArtifactVerdict(ctx, ArtifactVerdict{
		JobID:       "job_malicious_eval_001",
		WorkerID:    "worker_malicious_target_001",
		ValidatorID: "validator_malicious_detect_002",
		Verdict:     "malicious",
		Reason:      "hash mismatch",
		Quorum:      2,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !final.Finalized || final.FinalVerdict != "malicious" || final.Reputation.Status != "suspended" {
		t.Fatalf("expected malicious quorum to suspend target worker, got %+v", final)
	}
	validatorUpdates := validatorUpdatesByID(final.ValidatorReputations)
	if validatorUpdates["validator_malicious_cover_001"].ScoreDelta != -100 || validatorUpdates["validator_malicious_cover_001"].Reputation.Status != "suspended" {
		t.Fatalf("expected covering validator to be suspended, got %+v", validatorUpdates["validator_malicious_cover_001"])
	}
	if !validatorUpdates["validator_malicious_detect_001"].Aligned || validatorUpdates["validator_malicious_detect_001"].Reputation.AcceptedArtifacts != 1 {
		t.Fatalf("expected aligned validator to be rewarded, got %+v", validatorUpdates["validator_malicious_detect_001"])
	}
}

func TestRedisStoreArtifactVerdictConcurrentQuorumFinalizesOnce(t *testing.T) {
	addr := os.Getenv("MARSHALL_REDIS_ADDR")
	if addr == "" {
		t.Skip("MARSHALL_REDIS_ADDR is required for Redis integration tests")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	prefix := "marshall:quorum-race-test:" + strings.ReplaceAll(time.Now().UTC().Format(time.RFC3339Nano), ":", "-")
	store := NewRedisStore(addr, prefix)

	if _, err := store.CreateRun(ctx, Run{
		RunID:     "run_quorum_race_001",
		Objective: "prove concurrent validator quorum finalizes once",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.RegisterWorker(ctx, Worker{
		WorkerID:      "worker_quorum_race_target_001",
		PeerID:        "12D3KooWQuorumRaceTarget",
		Backend:       "mlx",
		DeviceFamily:  "apple_silicon",
		MemoryGB:      32,
		SupportedJobs: []string{"evaluate_adapter"},
	}); err != nil {
		t.Fatal(err)
	}
	for _, validator := range []struct {
		workerID string
		peerID   string
	}{
		{"validator_quorum_race_001", "12D3KooWQuorumRaceValidatorOne"},
		{"validator_quorum_race_002", "12D3KooWQuorumRaceValidatorTwo"},
		{"validator_quorum_race_003", "12D3KooWQuorumRaceValidatorThree"},
	} {
		if _, err := store.RegisterWorker(ctx, Worker{
			WorkerID:      validator.workerID,
			PeerID:        validator.peerID,
			Backend:       "cpu",
			DeviceFamily:  "generic_cpu",
			MemoryGB:      8,
			SupportedJobs: []string{"validate_artifact"},
		}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.CreateJob(ctx, Job{
		JobID:      "job_quorum_race_eval_001",
		RunID:      "run_quorum_race_001",
		JobType:    "evaluate_adapter",
		Backend:    "mlx",
		DatasetURI: "file://datasets/eval.jsonl",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ClaimJob(ctx, JobClaim{
		JobID:        "job_quorum_race_eval_001",
		WorkerID:     "worker_quorum_race_target_001",
		PeerID:       "12D3KooWQuorumRaceTarget",
		LeaseSeconds: 60,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.PublishArtifact(ctx, Artifact{
		JobID:        "job_quorum_race_eval_001",
		WorkerID:     "worker_quorum_race_target_001",
		PeerID:       "12D3KooWQuorumRaceTarget",
		ArtifactType: "adapter_evaluation",
		ArtifactURI:  "file://eval-artifacts/job_quorum_race_eval_001/metrics.json",
		ArtifactHash: "sha256:quorum-race-eval",
		ConfigHash:   "sha256:quorum-race-config",
		MetricsURI:   "file://eval-artifacts/job_quorum_race_eval_001/metrics.json",
	}); err != nil {
		t.Fatal(err)
	}

	first, err := store.RecordArtifactVerdict(ctx, ArtifactVerdict{
		JobID:       "job_quorum_race_eval_001",
		WorkerID:    "worker_quorum_race_target_001",
		ValidatorID: "validator_quorum_race_001",
		Verdict:     "accepted",
		Reason:      "first accepted vote",
		Quorum:      2,
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.Finalized {
		t.Fatalf("expected first vote to remain pending, got %+v", first)
	}

	start := make(chan struct{})
	results := make(chan ArtifactVerdictResult, 2)
	errs := make(chan error, 2)
	var wait sync.WaitGroup
	for _, validatorID := range []string{"validator_quorum_race_002", "validator_quorum_race_003"} {
		wait.Add(1)
		go func(id string) {
			defer wait.Done()
			<-start
			result, err := store.RecordArtifactVerdict(ctx, ArtifactVerdict{
				JobID:       "job_quorum_race_eval_001",
				WorkerID:    "worker_quorum_race_target_001",
				ValidatorID: id,
				Verdict:     "accepted",
				Reason:      "concurrent accepted vote",
				Quorum:      2,
			})
			if err != nil {
				errs <- err
				return
			}
			results <- result
		}(validatorID)
	}
	close(start)
	wait.Wait()
	close(results)
	close(errs)

	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	finalized := 0
	for result := range results {
		if !result.Finalized || result.FinalVerdict != "accepted" {
			t.Fatalf("expected concurrent vote to return finalized accepted verdict, got %+v", result)
		}
		finalized++
	}
	if finalized != 2 {
		t.Fatalf("expected two concurrent responses, got %d", finalized)
	}

	reputation, err := store.WorkerReputation(ctx, "worker_quorum_race_target_001")
	if err != nil {
		t.Fatal(err)
	}
	if reputation.AcceptedArtifacts != 1 || reputation.ValidationEvents != 1 || reputation.Score != 100 {
		t.Fatalf("expected target reputation to be updated exactly once, got %+v", reputation)
	}
	events, err := store.Events(ctx, 100)
	if err != nil {
		t.Fatal(err)
	}
	recorded := 0
	for _, event := range events {
		if event.Type == "artifact_verdict_recorded" && event.Fields["job_id"] == "job_quorum_race_eval_001" {
			recorded++
		}
	}
	if recorded != 1 {
		t.Fatalf("expected one artifact_verdict_recorded event, got %d", recorded)
	}
}

func validatorUpdatesByID(updates []ValidatorReputationUpdate) map[string]ValidatorReputationUpdate {
	byID := map[string]ValidatorReputationUpdate{}
	for _, update := range updates {
		byID[update.ValidatorID] = update
	}
	return byID
}
