package coordinator

import (
	"context"
	"fmt"
	"net/http/httptest"
	"sync"
	"testing"
)

func TestFederatedStoreShardsJobsAndAggregatesReads(t *testing.T) {
	ctx := context.Background()
	token := "federation-test-token"
	local := newMemoryStore()
	remote := newMemoryStore()
	remoteServer := httptest.NewServer(NewServer(remote, WithAuthToken(token), WithInstanceID("remote")))
	defer remoteServer.Close()

	store, err := NewFederatedStore(local, "public-primary", []FederationPeer{{
		ID:  "public-replica-1",
		URL: remoteServer.URL,
	}}, token)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := store.RegisterWorker(ctx, Worker{
		WorkerID:      "worker_federated_001",
		PeerID:        "peer_federated_001",
		Backend:       "mlx",
		DeviceFamily:  "apple_silicon",
		MemoryGB:      32,
		SupportedJobs: []string{"train_adapter"},
	}); err != nil {
		t.Fatal(err)
	}

	for index := 0; index < 24; index++ {
		job := Job{
			JobID:      fmt.Sprintf("job_federated_%03d", index),
			RunID:      "run_federated_001",
			JobType:    "train_adapter",
			Backend:    "mlx",
			DatasetURI: "dataset://federated",
		}
		if _, err := store.CreateJob(ctx, job); err != nil {
			t.Fatal(err)
		}
	}

	localJobs, err := local.Jobs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	remoteJobs, err := remote.Jobs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(localJobs) == 0 || len(remoteJobs) == 0 {
		t.Fatalf("expected jobs sharded across both coordinators, got local=%d remote=%d", len(localJobs), len(remoteJobs))
	}

	jobs, err := store.Jobs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 24 {
		t.Fatalf("expected aggregated jobs, got %d", len(jobs))
	}

	localWorkers, err := local.Workers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	remoteWorkers, err := remote.Workers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(localWorkers) != 1 || len(remoteWorkers) != 1 {
		t.Fatalf("expected worker registration replicated to both coordinators, got local=%d remote=%d", len(localWorkers), len(remoteWorkers))
	}

	remote.setReputation("worker_federated_001", WorkerReputation{
		WorkerID:           "worker_federated_001",
		Score:              0,
		Status:             "suspended",
		MaliciousArtifacts: 1,
		ValidationEvents:   1,
		LastVerdictAt:      "2026-07-02T09:00:00Z",
	})
	reputation, err := store.WorkerReputation(ctx, "worker_federated_001")
	if err != nil {
		t.Fatal(err)
	}
	if reputation.Status != "suspended" || reputation.MaliciousArtifacts != 1 {
		t.Fatalf("expected aggregated suspended reputation, got %+v", reputation)
	}

	claim, err := store.ClaimJob(ctx, JobClaim{
		JobID:    "job_federated_000",
		WorkerID: "worker_federated_001",
		PeerID:   "peer_federated_001",
	})
	if err != nil {
		t.Fatal(err)
	}
	if claim.Accepted || claim.Reason != "worker suspended" {
		t.Fatalf("expected federated reputation to block claim, got %+v", claim)
	}
}

type memoryStore struct {
	mu          sync.Mutex
	workers     map[string]Worker
	jobs        map[string]Job
	reputations map[string]WorkerReputation
}

func newMemoryStore() *memoryStore {
	return &memoryStore{
		workers:     map[string]Worker{},
		jobs:        map[string]Job{},
		reputations: map[string]WorkerReputation{},
	}
}

func (store *memoryStore) CreateRun(context.Context, Run) (Event, error) {
	return Event{ID: "memory-run", Type: "run_created", Fields: map[string]string{}}, nil
}

func (store *memoryStore) RegisterWorker(_ context.Context, worker Worker) (Event, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.workers[worker.WorkerID] = worker
	if _, exists := store.reputations[worker.WorkerID]; !exists {
		store.reputations[worker.WorkerID] = WorkerReputation{
			WorkerID: worker.WorkerID,
			Score:    defaultReputationScore,
			Status:   reputationStatus(defaultReputationScore),
		}
	}
	return Event{ID: "memory-worker", Type: "worker_registered", Fields: map[string]string{"worker_id": worker.WorkerID}}, nil
}

func (store *memoryStore) WorkerHeartbeat(context.Context, WorkerHeartbeat) (Event, error) {
	return Event{ID: "memory-heartbeat", Type: "worker_heartbeat", Fields: map[string]string{}}, nil
}

func (store *memoryStore) Workers(context.Context) ([]Worker, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	workers := make([]Worker, 0, len(store.workers))
	for _, worker := range store.workers {
		workers = append(workers, worker)
	}
	return workers, nil
}

func (store *memoryStore) CreateJob(_ context.Context, job Job) (Event, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.jobs[job.JobID] = job
	return Event{ID: "memory-job", Type: "job_created", Fields: map[string]string{"job_id": job.JobID}}, nil
}

func (store *memoryStore) GetJob(_ context.Context, jobID string) (Job, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	job, ok := store.jobs[jobID]
	if !ok {
		return Job{}, fmt.Errorf("job not found")
	}
	return job, nil
}

func (store *memoryStore) Jobs(context.Context) ([]Job, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	jobs := make([]Job, 0, len(store.jobs))
	for _, job := range store.jobs {
		jobs = append(jobs, job)
	}
	return jobs, nil
}

func (store *memoryStore) ClaimJob(context.Context, JobClaim) (JobClaimResult, error) {
	return JobClaimResult{}, nil
}

func (store *memoryStore) RequeueExpiredJobs(context.Context) (RequeueResult, error) {
	return RequeueResult{}, nil
}

func (store *memoryStore) UpdateJobStatus(context.Context, JobStatus) (Event, error) {
	return Event{}, nil
}

func (store *memoryStore) PublishArtifact(context.Context, Artifact) (Event, error) {
	return Event{}, nil
}

func (store *memoryStore) GetArtifact(context.Context, string) (Artifact, error) {
	return Artifact{}, nil
}

func (store *memoryStore) Artifacts(context.Context) ([]Artifact, error) {
	return nil, nil
}

func (store *memoryStore) RecordArtifactVerdict(context.Context, ArtifactVerdict) (ArtifactVerdictResult, error) {
	return ArtifactVerdictResult{}, nil
}

func (store *memoryStore) WorkerReputation(_ context.Context, workerID string) (WorkerReputation, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	reputation, ok := store.reputations[workerID]
	if !ok {
		return WorkerReputation{}, fmt.Errorf("worker not found")
	}
	return reputation, nil
}

func (store *memoryStore) Events(context.Context, int) ([]Event, error) {
	return nil, nil
}

func (store *memoryStore) setReputation(workerID string, reputation WorkerReputation) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.reputations[workerID] = reputation
}
