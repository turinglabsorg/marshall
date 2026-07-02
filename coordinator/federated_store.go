package coordinator

import (
	"context"
	"fmt"
	"hash/fnv"
	"sort"
)

type federationContextKey string

const federationLocalOnlyKey federationContextKey = "marshall_federation_local_only"

type FederationPeer struct {
	ID  string
	URL string
}

type FederatedStore struct {
	local   Store
	selfID  string
	peers   map[string]Store
	members []string
}

func NewFederatedStore(local Store, selfID string, peers []FederationPeer, token string) (*FederatedStore, error) {
	if selfID == "" {
		return nil, fmt.Errorf("federation self id is required")
	}
	peerStores := map[string]Store{}
	members := []string{selfID}
	for _, peer := range peers {
		if peer.ID == "" || peer.URL == "" {
			return nil, fmt.Errorf("federation peer id and url are required")
		}
		if peer.ID == selfID {
			continue
		}
		if _, exists := peerStores[peer.ID]; exists {
			return nil, fmt.Errorf("duplicate federation peer %s", peer.ID)
		}
		peerStores[peer.ID] = NewRemoteStore(peer.URL, token)
		members = append(members, peer.ID)
	}
	sort.Strings(members)
	return &FederatedStore{
		local:   local,
		selfID:  selfID,
		peers:   peerStores,
		members: members,
	}, nil
}

func WithFederationLocalOnly(ctx context.Context) context.Context {
	return context.WithValue(ctx, federationLocalOnlyKey, true)
}

func federationLocalOnly(ctx context.Context) bool {
	value, _ := ctx.Value(federationLocalOnlyKey).(bool)
	return value
}

func (store *FederatedStore) CreateRun(ctx context.Context, run Run) (Event, error) {
	if federationLocalOnly(ctx) {
		return store.local.CreateRun(ctx, run)
	}
	event, err := store.local.CreateRun(ctx, run)
	if err != nil {
		return Event{}, err
	}
	for _, peer := range store.peers {
		if _, err := peer.CreateRun(ctx, run); err != nil {
			return Event{}, err
		}
	}
	return event, nil
}

func (store *FederatedStore) RegisterWorker(ctx context.Context, worker Worker) (Event, error) {
	if federationLocalOnly(ctx) {
		return store.local.RegisterWorker(ctx, worker)
	}
	event, err := store.local.RegisterWorker(ctx, worker)
	if err != nil {
		return Event{}, err
	}
	for _, peer := range store.peers {
		if _, err := peer.RegisterWorker(ctx, worker); err != nil {
			return Event{}, err
		}
	}
	return event, nil
}

func (store *FederatedStore) WorkerHeartbeat(ctx context.Context, heartbeat WorkerHeartbeat) (Event, error) {
	if federationLocalOnly(ctx) || heartbeat.CurrentJobID == "" {
		return store.local.WorkerHeartbeat(ctx, heartbeat)
	}
	return store.owner(heartbeat.CurrentJobID).WorkerHeartbeat(ctx, heartbeat)
}

func (store *FederatedStore) Workers(ctx context.Context) ([]Worker, error) {
	if federationLocalOnly(ctx) {
		return store.local.Workers(ctx)
	}
	var all []Worker
	local, err := store.local.Workers(ctx)
	if err != nil {
		return nil, err
	}
	all = append(all, local...)
	for _, peer := range store.peers {
		workers, err := peer.Workers(ctx)
		if err != nil {
			return nil, err
		}
		all = append(all, workers...)
	}
	return dedupeWorkers(all), nil
}

func (store *FederatedStore) CreateJob(ctx context.Context, job Job) (Event, error) {
	if federationLocalOnly(ctx) {
		return store.local.CreateJob(ctx, job)
	}
	return store.owner(job.JobID).CreateJob(ctx, job)
}

func (store *FederatedStore) GetJob(ctx context.Context, jobID string) (Job, error) {
	if federationLocalOnly(ctx) {
		return store.local.GetJob(ctx, jobID)
	}
	return store.owner(jobID).GetJob(ctx, jobID)
}

func (store *FederatedStore) Jobs(ctx context.Context) ([]Job, error) {
	if federationLocalOnly(ctx) {
		return store.local.Jobs(ctx)
	}
	var all []Job
	local, err := store.local.Jobs(ctx)
	if err != nil {
		return nil, err
	}
	all = append(all, local...)
	for _, peer := range store.peers {
		jobs, err := peer.Jobs(ctx)
		if err != nil {
			return nil, err
		}
		all = append(all, jobs...)
	}
	return dedupeJobs(all), nil
}

func (store *FederatedStore) ClaimJob(ctx context.Context, claim JobClaim) (JobClaimResult, error) {
	if federationLocalOnly(ctx) {
		return store.local.ClaimJob(ctx, claim)
	}
	reputation, err := store.WorkerReputation(ctx, claim.WorkerID)
	if err != nil {
		return JobClaimResult{}, err
	}
	if reputation.Status == "suspended" {
		return JobClaimResult{Accepted: false, JobID: claim.JobID, WorkerID: claim.WorkerID, Reason: "worker suspended"}, nil
	}
	return store.owner(claim.JobID).ClaimJob(ctx, claim)
}

func (store *FederatedStore) RequeueExpiredJobs(ctx context.Context) (RequeueResult, error) {
	if federationLocalOnly(ctx) {
		return store.local.RequeueExpiredJobs(ctx)
	}
	result, err := store.local.RequeueExpiredJobs(ctx)
	if err != nil {
		return RequeueResult{}, err
	}
	for _, peer := range store.peers {
		peerResult, err := peer.RequeueExpiredJobs(ctx)
		if err != nil {
			return RequeueResult{}, err
		}
		result.Requeued = append(result.Requeued, peerResult.Requeued...)
	}
	sort.Strings(result.Requeued)
	return result, nil
}

func (store *FederatedStore) UpdateJobStatus(ctx context.Context, status JobStatus) (Event, error) {
	if federationLocalOnly(ctx) {
		return store.local.UpdateJobStatus(ctx, status)
	}
	return store.owner(status.JobID).UpdateJobStatus(ctx, status)
}

func (store *FederatedStore) PublishArtifact(ctx context.Context, artifact Artifact) (Event, error) {
	if federationLocalOnly(ctx) {
		return store.local.PublishArtifact(ctx, artifact)
	}
	return store.owner(artifact.JobID).PublishArtifact(ctx, artifact)
}

func (store *FederatedStore) GetArtifact(ctx context.Context, jobID string) (Artifact, error) {
	if federationLocalOnly(ctx) {
		return store.local.GetArtifact(ctx, jobID)
	}
	return store.owner(jobID).GetArtifact(ctx, jobID)
}

func (store *FederatedStore) Artifacts(ctx context.Context) ([]Artifact, error) {
	if federationLocalOnly(ctx) {
		return store.local.Artifacts(ctx)
	}
	var all []Artifact
	local, err := store.local.Artifacts(ctx)
	if err != nil {
		return nil, err
	}
	all = append(all, local...)
	for _, peer := range store.peers {
		artifacts, err := peer.Artifacts(ctx)
		if err != nil {
			return nil, err
		}
		all = append(all, artifacts...)
	}
	return dedupeArtifacts(all), nil
}

func (store *FederatedStore) RecordArtifactVerdict(ctx context.Context, verdict ArtifactVerdict) (ArtifactVerdictResult, error) {
	if federationLocalOnly(ctx) {
		return store.local.RecordArtifactVerdict(ctx, verdict)
	}
	return store.owner(verdict.JobID).RecordArtifactVerdict(ctx, verdict)
}

func (store *FederatedStore) WorkerReputation(ctx context.Context, workerID string) (WorkerReputation, error) {
	if federationLocalOnly(ctx) {
		return store.local.WorkerReputation(ctx, workerID)
	}
	reputations := []WorkerReputation{}
	local, err := store.local.WorkerReputation(ctx, workerID)
	if err != nil {
		return WorkerReputation{}, err
	}
	reputations = append(reputations, local)
	for _, peer := range store.peers {
		reputation, err := peer.WorkerReputation(ctx, workerID)
		if err != nil {
			return WorkerReputation{}, err
		}
		reputations = append(reputations, reputation)
	}
	return aggregateReputations(workerID, reputations), nil
}

func (store *FederatedStore) Events(ctx context.Context, count int) ([]Event, error) {
	if federationLocalOnly(ctx) {
		return store.local.Events(ctx, count)
	}
	var all []Event
	local, err := store.local.Events(ctx, count)
	if err != nil {
		return nil, err
	}
	all = append(all, local...)
	for _, peer := range store.peers {
		events, err := peer.Events(ctx, count)
		if err != nil {
			return nil, err
		}
		all = append(all, events...)
	}
	sort.Slice(all, func(left, right int) bool {
		return all[left].ID < all[right].ID
	})
	if count > 0 && len(all) > count {
		all = all[len(all)-count:]
	}
	return all, nil
}

func (store *FederatedStore) owner(key string) Store {
	ownerID := store.ownerID(key)
	if ownerID == store.selfID {
		return store.local
	}
	peer, ok := store.peers[ownerID]
	if !ok {
		return store.local
	}
	return peer
}

func (store *FederatedStore) ownerID(key string) string {
	if len(store.members) == 1 {
		return store.selfID
	}
	hash := fnv.New32a()
	_, _ = hash.Write([]byte(key))
	return store.members[int(hash.Sum32())%len(store.members)]
}

func dedupeWorkers(workers []Worker) []Worker {
	byID := map[string]Worker{}
	for _, worker := range workers {
		if worker.WorkerID != "" {
			byID[worker.WorkerID] = worker
		}
	}
	return sortedValues(byID)
}

func dedupeJobs(jobs []Job) []Job {
	byID := map[string]Job{}
	for _, job := range jobs {
		if job.JobID != "" {
			byID[job.JobID] = job
		}
	}
	return sortedValues(byID)
}

func dedupeArtifacts(artifacts []Artifact) []Artifact {
	byID := map[string]Artifact{}
	for _, artifact := range artifacts {
		if artifact.JobID != "" {
			byID[artifact.JobID] = artifact
		}
	}
	return sortedValues(byID)
}

func aggregateReputations(workerID string, reputations []WorkerReputation) WorkerReputation {
	aggregate := WorkerReputation{
		WorkerID: workerID,
		Score:    defaultReputationScore,
		Status:   reputationStatus(defaultReputationScore),
	}
	for _, reputation := range reputations {
		aggregate.AcceptedArtifacts += reputation.AcceptedArtifacts
		aggregate.PoorArtifacts += reputation.PoorArtifacts
		aggregate.RejectedArtifacts += reputation.RejectedArtifacts
		aggregate.MaliciousArtifacts += reputation.MaliciousArtifacts
		aggregate.TimeoutJobs += reputation.TimeoutJobs
		aggregate.ValidationEvents += reputation.ValidationEvents
		if reputation.LastVerdictAt > aggregate.LastVerdictAt {
			aggregate.LastVerdictAt = reputation.LastVerdictAt
		}
	}
	score := defaultReputationScore
	score += aggregate.AcceptedArtifacts * reputationDelta("accepted")
	score += aggregate.PoorArtifacts * reputationDelta("poor")
	score += aggregate.RejectedArtifacts * reputationDelta("rejected")
	score += aggregate.MaliciousArtifacts * reputationDelta("malicious")
	score += aggregate.TimeoutJobs * reputationDelta("timeout")
	aggregate.Score = clampInt(score, 0, defaultReputationScore)
	aggregate.Status = reputationStatus(aggregate.Score)
	return aggregate
}

type keyed interface {
	Worker | Job | Artifact
}

func sortedValues[T keyed](values map[string]T) []T {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]T, 0, len(keys))
	for _, key := range keys {
		result = append(result, values[key])
	}
	return result
}
