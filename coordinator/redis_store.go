package coordinator

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
)

const defaultLeaseSeconds = 300
const defaultReputationScore = 100
const degradedReputationThreshold = 70
const suspendedReputationThreshold = 20

type RedisStore struct {
	client *redisClient
	prefix string
}

func NewRedisStore(addr string, prefix string) *RedisStore {
	if prefix == "" {
		prefix = "marshall"
	}
	return &RedisStore{
		client: newRedisClient(addr),
		prefix: prefix,
	}
}

func (store *RedisStore) CreateRun(ctx context.Context, run Run) (Event, error) {
	if run.RunID == "" || run.Objective == "" {
		return Event{}, fmt.Errorf("run_id and objective are required")
	}
	if run.CreatedAt == "" {
		run.CreatedAt = nowUTC()
	}

	if _, err := store.client.command(ctx, append([]string{"HSET", store.key("run", run.RunID)}, mapArgs(map[string]string{
		"run_id":     run.RunID,
		"objective":  run.Objective,
		"created_at": run.CreatedAt,
	})...)...); err != nil {
		return Event{}, err
	}
	if _, err := store.client.command(ctx, "SADD", store.key("runs"), run.RunID); err != nil {
		return Event{}, err
	}
	return store.appendEvent(ctx, "run_created", map[string]string{
		"run_id":     run.RunID,
		"objective":  run.Objective,
		"created_at": run.CreatedAt,
	})
}

func (store *RedisStore) RegisterWorker(ctx context.Context, worker Worker) (Event, error) {
	if worker.WorkerID == "" || worker.PeerID == "" || worker.Backend == "" {
		return Event{}, fmt.Errorf("worker_id, peer_id, and backend are required")
	}
	existing, err := store.hash(ctx, store.key("worker", worker.WorkerID))
	if err != nil {
		return Event{}, err
	}
	if existing["worker_id"] != "" && existing["peer_id"] != worker.PeerID {
		return Event{}, fmt.Errorf("worker peer does not match existing worker")
	}
	if worker.CreatedAt == "" {
		worker.CreatedAt = existing["created_at"]
		if worker.CreatedAt == "" {
			worker.CreatedAt = nowUTC()
		}
	}
	if worker.LastSeenAt == "" {
		worker.LastSeenAt = worker.CreatedAt
	}
	if worker.Status == "" {
		worker.Status = "registered"
	}
	reputation := reputationFromFields(worker.WorkerID, existing)
	if reputation.Score == 0 && existing["reputation_score"] == "" {
		reputation.Score = defaultReputationScore
		reputation.Status = reputationStatus(reputation.Score)
	}

	if _, err := store.client.command(ctx, append([]string{"HSET", store.key("worker", worker.WorkerID)}, mapArgs(map[string]string{
		"worker_id":           worker.WorkerID,
		"peer_id":             worker.PeerID,
		"public_key":          worker.PublicKey,
		"backend":             worker.Backend,
		"device_family":       worker.DeviceFamily,
		"memory_gb":           strconv.FormatFloat(worker.MemoryGB, 'f', -1, 64),
		"supported_jobs":      strings.Join(worker.SupportedJobs, ","),
		"created_at":          worker.CreatedAt,
		"status":              worker.Status,
		"current_job_id":      worker.CurrentJobID,
		"last_seen_at":        worker.LastSeenAt,
		"reputation_score":    strconv.Itoa(reputation.Score),
		"reputation_status":   reputation.Status,
		"accepted_artifacts":  strconv.Itoa(reputation.AcceptedArtifacts),
		"poor_artifacts":      strconv.Itoa(reputation.PoorArtifacts),
		"rejected_artifacts":  strconv.Itoa(reputation.RejectedArtifacts),
		"malicious_artifacts": strconv.Itoa(reputation.MaliciousArtifacts),
		"timeout_jobs":        strconv.Itoa(reputation.TimeoutJobs),
		"validation_events":   strconv.Itoa(reputation.ValidationEvents),
		"last_verdict_at":     reputation.LastVerdictAt,
	})...)...); err != nil {
		return Event{}, err
	}
	if _, err := store.client.command(ctx, "SADD", store.key("workers"), worker.WorkerID); err != nil {
		return Event{}, err
	}
	return store.appendEvent(ctx, "worker_registered", map[string]string{
		"worker_id":         worker.WorkerID,
		"peer_id":           worker.PeerID,
		"backend":           worker.Backend,
		"device_family":     worker.DeviceFamily,
		"memory_gb":         strconv.FormatFloat(worker.MemoryGB, 'f', -1, 64),
		"supported_jobs":    strings.Join(worker.SupportedJobs, ","),
		"created_at":        worker.CreatedAt,
		"status":            worker.Status,
		"last_seen_at":      worker.LastSeenAt,
		"reputation_score":  strconv.Itoa(reputation.Score),
		"reputation_status": reputation.Status,
	})
}

func (store *RedisStore) WorkerHeartbeat(ctx context.Context, heartbeat WorkerHeartbeat) (Event, error) {
	if heartbeat.WorkerID == "" || heartbeat.PeerID == "" || heartbeat.Status == "" {
		return Event{}, fmt.Errorf("worker_id, peer_id, and status are required")
	}
	if heartbeat.Timestamp == "" {
		heartbeat.Timestamp = nowUTC()
	}
	if heartbeat.LeaseSeconds <= 0 {
		heartbeat.LeaseSeconds = defaultLeaseSeconds
	}

	workerFields, err := store.hash(ctx, store.key("worker", heartbeat.WorkerID))
	if err != nil {
		return Event{}, err
	}
	if workerFields["worker_id"] == "" {
		return Event{}, fmt.Errorf("worker not found")
	}
	if workerFields["peer_id"] != heartbeat.PeerID {
		return Event{}, fmt.Errorf("heartbeat peer does not match worker")
	}

	if heartbeat.CurrentJobID != "" {
		jobFields, err := store.hash(ctx, store.key("job", heartbeat.CurrentJobID))
		if err != nil {
			return Event{}, err
		}
		if jobFields["job_id"] == "" {
			return Event{}, fmt.Errorf("heartbeat job not found")
		}
		if jobFields["worker_id"] != heartbeat.WorkerID {
			return Event{}, fmt.Errorf("heartbeat worker does not match job")
		}
		if jobFields["status"] == "claimed" || jobFields["status"] == "running" {
			if _, err := store.client.command(ctx, "SET", store.key("job", heartbeat.CurrentJobID, "lease"), heartbeat.WorkerID, "EX", strconv.Itoa(heartbeat.LeaseSeconds)); err != nil {
				return Event{}, err
			}
		}
	}

	if _, err := store.client.command(ctx, "HSET", store.key("worker", heartbeat.WorkerID),
		"status", heartbeat.Status,
		"current_job_id", heartbeat.CurrentJobID,
		"last_seen_at", heartbeat.Timestamp,
	); err != nil {
		return Event{}, err
	}
	return store.appendEvent(ctx, "worker_heartbeat", map[string]string{
		"worker_id":      heartbeat.WorkerID,
		"peer_id":        heartbeat.PeerID,
		"status":         heartbeat.Status,
		"current_job_id": heartbeat.CurrentJobID,
		"created_at":     heartbeat.Timestamp,
	})
}

func (store *RedisStore) Workers(ctx context.Context) ([]Worker, error) {
	ids, err := store.members(ctx, store.key("workers"))
	if err != nil {
		return nil, err
	}
	workers := make([]Worker, 0, len(ids))
	for _, id := range ids {
		fields, err := store.hash(ctx, store.key("worker", id))
		if err != nil {
			return nil, err
		}
		if fields["worker_id"] != "" {
			workers = append(workers, workerFromFields(fields))
		}
	}
	return workers, nil
}

func (store *RedisStore) CreateJob(ctx context.Context, job Job) (Event, error) {
	if job.JobID == "" || job.RunID == "" || job.JobType == "" || job.Backend == "" {
		return Event{}, fmt.Errorf("job_id, run_id, job_type, and backend are required")
	}
	if job.CreatedAt == "" {
		job.CreatedAt = nowUTC()
	}
	if job.Status == "" {
		job.Status = "queued"
	}
	if len(job.JobSpec) > 0 && !json.Valid(job.JobSpec) {
		return Event{}, fmt.Errorf("job_spec must be valid JSON")
	}

	fields := map[string]string{
		"job_id":      job.JobID,
		"run_id":      job.RunID,
		"job_type":    job.JobType,
		"backend":     job.Backend,
		"dataset_uri": job.DatasetURI,
		"status":      job.Status,
		"created_at":  job.CreatedAt,
	}
	if len(job.JobSpec) > 0 {
		fields["job_spec"] = string(job.JobSpec)
	}
	if _, err := store.client.command(ctx, append([]string{"HSET", store.key("job", job.JobID)}, mapArgs(fields)...)...); err != nil {
		return Event{}, err
	}
	if _, err := store.client.command(ctx, "SADD", store.key("jobs"), job.JobID); err != nil {
		return Event{}, err
	}
	if _, err := store.client.command(ctx, "SADD", store.key("run", job.RunID, "jobs"), job.JobID); err != nil {
		return Event{}, err
	}
	return store.appendEvent(ctx, "job_created", map[string]string{
		"job_id":     job.JobID,
		"run_id":     job.RunID,
		"job_type":   job.JobType,
		"backend":    job.Backend,
		"created_at": job.CreatedAt,
	})
}

func (store *RedisStore) GetJob(ctx context.Context, jobID string) (Job, error) {
	if jobID == "" {
		return Job{}, fmt.Errorf("job_id is required")
	}
	fields, err := store.hash(ctx, store.key("job", jobID))
	if err != nil {
		return Job{}, err
	}
	if fields["job_id"] == "" {
		return Job{}, fmt.Errorf("job not found")
	}
	return jobFromFields(fields), nil
}

func (store *RedisStore) Jobs(ctx context.Context) ([]Job, error) {
	ids, err := store.members(ctx, store.key("jobs"))
	if err != nil {
		return nil, err
	}
	jobs := make([]Job, 0, len(ids))
	for _, id := range ids {
		fields, err := store.hash(ctx, store.key("job", id))
		if err != nil {
			return nil, err
		}
		if fields["job_id"] != "" {
			jobs = append(jobs, jobFromFields(fields))
		}
	}
	return jobs, nil
}

func (store *RedisStore) ClaimJob(ctx context.Context, claim JobClaim) (JobClaimResult, error) {
	if claim.JobID == "" || claim.WorkerID == "" || claim.PeerID == "" {
		return JobClaimResult{}, fmt.Errorf("job_id, worker_id, and peer_id are required")
	}
	if claim.LeaseSeconds <= 0 {
		claim.LeaseSeconds = defaultLeaseSeconds
	}
	workerFields, err := store.hash(ctx, store.key("worker", claim.WorkerID))
	if err != nil {
		return JobClaimResult{}, err
	}
	if workerFields["worker_id"] == "" {
		return JobClaimResult{Accepted: false, JobID: claim.JobID, WorkerID: claim.WorkerID, Reason: "worker not registered"}, nil
	}
	if workerFields["peer_id"] != claim.PeerID {
		return JobClaimResult{Accepted: false, JobID: claim.JobID, WorkerID: claim.WorkerID, Reason: "worker peer mismatch"}, nil
	}
	reputation := reputationFromFields(claim.WorkerID, workerFields)
	if reputation.Status == "suspended" {
		return JobClaimResult{Accepted: false, JobID: claim.JobID, WorkerID: claim.WorkerID, Reason: "worker suspended"}, nil
	}

	script := `
local status = redis.call('HGET', KEYS[2], 'status')
if not status then
  return {-1, 'missing job'}
end
if status ~= 'queued' then
  return {0, redis.call('HGET', KEYS[2], 'worker_id') or ''}
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[5])
redis.call('HSET', KEYS[2], 'status', 'claimed', 'worker_id', ARGV[2], 'peer_id', ARGV[3], 'claimed_at', ARGV[4])
local event = redis.call('XADD', KEYS[3], '*', 'type', 'job_claimed', 'job_id', ARGV[1], 'worker_id', ARGV[2], 'peer_id', ARGV[3], 'created_at', ARGV[4])
return {1, event}
`
	now := nowUTC()
	value, err := store.client.command(
		ctx,
		"EVAL",
		script,
		"3",
		store.key("job", claim.JobID, "lease"),
		store.key("job", claim.JobID),
		store.key("events"),
		claim.JobID,
		claim.WorkerID,
		claim.PeerID,
		now,
		strconv.Itoa(claim.LeaseSeconds),
	)
	if err != nil {
		return JobClaimResult{}, err
	}
	if len(value.items) != 2 {
		return JobClaimResult{}, fmt.Errorf("unexpected Redis claim response")
	}
	code := value.items[0].num
	detail := value.items[1].stringValue()

	switch code {
	case 1:
		return JobClaimResult{Accepted: true, JobID: claim.JobID, WorkerID: claim.WorkerID, EventID: detail}, nil
	case 0:
		return JobClaimResult{Accepted: false, JobID: claim.JobID, WorkerID: detail, Reason: "job already claimed"}, nil
	default:
		return JobClaimResult{Accepted: false, JobID: claim.JobID, Reason: detail}, nil
	}
}

func (store *RedisStore) RequeueExpiredJobs(ctx context.Context) (RequeueResult, error) {
	ids, err := store.members(ctx, store.key("jobs"))
	if err != nil {
		return RequeueResult{}, err
	}

	requeued := []string{}
	for _, id := range ids {
		fields, err := store.hash(ctx, store.key("job", id))
		if err != nil {
			return RequeueResult{}, err
		}
		if fields["job_id"] == "" || (fields["status"] != "claimed" && fields["status"] != "running") {
			continue
		}
		exists, err := store.client.command(ctx, "EXISTS", store.key("job", id, "lease"))
		if err != nil {
			return RequeueResult{}, err
		}
		if exists.num != 0 {
			continue
		}

		now := nowUTC()
		if _, err := store.client.command(ctx, "HSET", store.key("job", id),
			"status", "queued",
			"worker_id", "",
			"peer_id", "",
			"claimed_at", "",
			"status_message", "lease expired; requeued",
			"status_at", now,
		); err != nil {
			return RequeueResult{}, err
		}
		if fields["worker_id"] != "" {
			if _, err := store.client.command(ctx, "HSET", store.key("worker", fields["worker_id"]),
				"status", "idle",
				"current_job_id", "",
				"last_seen_at", now,
			); err != nil {
				return RequeueResult{}, err
			}
			if _, _, err := store.applyWorkerReputation(ctx, fields["worker_id"], "timeout", now); err != nil {
				return RequeueResult{}, err
			}
		}
		eventFields := map[string]string{
			"job_id":     id,
			"run_id":     fields["run_id"],
			"worker_id":  fields["worker_id"],
			"peer_id":    fields["peer_id"],
			"created_at": now,
		}
		if _, err := store.appendEvent(ctx, "job_requeued", eventFields); err != nil {
			return RequeueResult{}, err
		}
		requeued = append(requeued, id)
	}
	return RequeueResult{Requeued: requeued}, nil
}

func (store *RedisStore) UpdateJobStatus(ctx context.Context, status JobStatus) (Event, error) {
	if status.JobID == "" || status.WorkerID == "" || status.Status == "" {
		return Event{}, fmt.Errorf("job_id, worker_id, and status are required")
	}
	now := nowUTC()
	if _, err := store.client.command(ctx, "HSET", store.key("job", status.JobID), "status", status.Status, "status_message", status.Message, "status_at", now); err != nil {
		return Event{}, err
	}
	if status.Status == "completed" || status.Status == "failed" {
		if _, err := store.client.command(ctx, "DEL", store.key("job", status.JobID, "lease")); err != nil {
			return Event{}, err
		}
		if _, err := store.client.command(ctx, "HSET", store.key("worker", status.WorkerID), "status", "idle", "current_job_id", "", "last_seen_at", now); err != nil {
			return Event{}, err
		}
	}
	return store.appendEvent(ctx, "job_status_updated", map[string]string{
		"job_id":     status.JobID,
		"worker_id":  status.WorkerID,
		"status":     status.Status,
		"message":    status.Message,
		"created_at": now,
	})
}

func (store *RedisStore) PublishArtifact(ctx context.Context, artifact Artifact) (Event, error) {
	if artifact.JobID == "" || artifact.WorkerID == "" || artifact.ArtifactHash == "" || artifact.ArtifactURI == "" {
		return Event{}, fmt.Errorf("job_id, worker_id, artifact_hash, and artifact_uri are required")
	}
	job, err := store.hash(ctx, store.key("job", artifact.JobID))
	if err != nil {
		return Event{}, err
	}
	if job["worker_id"] != artifact.WorkerID {
		return Event{}, fmt.Errorf("artifact worker does not match claimed job worker")
	}
	if artifact.CreatedAt == "" {
		artifact.CreatedAt = nowUTC()
	}

	if _, err := store.client.command(ctx, append([]string{"HSET", store.key("artifact", artifact.JobID)}, mapArgs(map[string]string{
		"job_id":        artifact.JobID,
		"worker_id":     artifact.WorkerID,
		"peer_id":       artifact.PeerID,
		"artifact_type": artifact.ArtifactType,
		"artifact_uri":  artifact.ArtifactURI,
		"artifact_hash": artifact.ArtifactHash,
		"config_hash":   artifact.ConfigHash,
		"metrics_uri":   artifact.MetricsURI,
		"created_at":    artifact.CreatedAt,
	})...)...); err != nil {
		return Event{}, err
	}
	if _, err := store.client.command(ctx, "SADD", store.key("artifacts"), artifact.JobID); err != nil {
		return Event{}, err
	}
	return store.appendEvent(ctx, "artifact_published", map[string]string{
		"job_id":        artifact.JobID,
		"worker_id":     artifact.WorkerID,
		"artifact_type": artifact.ArtifactType,
		"artifact_hash": artifact.ArtifactHash,
		"created_at":    artifact.CreatedAt,
	})
}

func (store *RedisStore) GetArtifact(ctx context.Context, jobID string) (Artifact, error) {
	if jobID == "" {
		return Artifact{}, fmt.Errorf("job_id is required")
	}
	fields, err := store.hash(ctx, store.key("artifact", jobID))
	if err != nil {
		return Artifact{}, err
	}
	if fields["job_id"] == "" {
		return Artifact{}, fmt.Errorf("artifact not found")
	}
	return artifactFromFields(fields), nil
}

func (store *RedisStore) Artifacts(ctx context.Context) ([]Artifact, error) {
	ids, err := store.members(ctx, store.key("artifacts"))
	if err != nil {
		return nil, err
	}
	artifacts := make([]Artifact, 0, len(ids))
	for _, id := range ids {
		fields, err := store.hash(ctx, store.key("artifact", id))
		if err != nil {
			return nil, err
		}
		if fields["job_id"] != "" {
			artifacts = append(artifacts, artifactFromFields(fields))
		}
	}
	return artifacts, nil
}

func (store *RedisStore) RecordArtifactVerdict(ctx context.Context, verdict ArtifactVerdict) (ArtifactVerdictResult, error) {
	if verdict.JobID == "" || verdict.WorkerID == "" || verdict.Verdict == "" {
		return ArtifactVerdictResult{}, fmt.Errorf("job_id, worker_id, and verdict are required")
	}
	normalizedVerdict, err := normalizeVerdict(verdict.Verdict)
	if err != nil {
		return ArtifactVerdictResult{}, err
	}
	artifact, err := store.hash(ctx, store.key("artifact", verdict.JobID))
	if err != nil {
		return ArtifactVerdictResult{}, err
	}
	if artifact["job_id"] == "" {
		return ArtifactVerdictResult{}, fmt.Errorf("artifact not found")
	}
	if artifact["worker_id"] != verdict.WorkerID {
		return ArtifactVerdictResult{}, fmt.Errorf("verdict worker does not match artifact worker")
	}
	if verdict.CreatedAt == "" {
		verdict.CreatedAt = nowUTC()
	}
	quorum := verdict.Quorum
	if quorum <= 0 {
		quorum = 1
	}

	if artifact["verdict"] != "" {
		return store.finalizedArtifactVerdictResult(ctx, verdict.JobID, verdict.WorkerID, artifact, quorum)
	}

	if quorum <= 1 {
		if verdict.ValidatorID != "" {
			if err := store.requireValidatorCanVote(ctx, verdict.ValidatorID, verdict.WorkerID); err != nil {
				return ArtifactVerdictResult{}, err
			}
			if _, err := store.client.command(ctx, "HSET", store.key("artifact", verdict.JobID, "verdict_votes"), verdict.ValidatorID, normalizedVerdict); err != nil {
				return ArtifactVerdictResult{}, err
			}
		}
		return store.finalizeArtifactVerdict(ctx, verdict, normalizedVerdict, quorum, 1, map[string]int{normalizedVerdict: 1})
	}
	if verdict.ValidatorID == "" {
		return ArtifactVerdictResult{}, fmt.Errorf("validator_id is required when quorum is greater than 1")
	}
	if err := store.requireValidatorCanVote(ctx, verdict.ValidatorID, verdict.WorkerID); err != nil {
		return ArtifactVerdictResult{}, err
	}

	votesKey := store.key("artifact", verdict.JobID, "verdict_votes")
	existing, err := store.client.command(ctx, "HGET", votesKey, verdict.ValidatorID)
	if err != nil {
		return ArtifactVerdictResult{}, err
	}
	existingVerdict := existing.stringValue()
	if existingVerdict != "" && existingVerdict != normalizedVerdict {
		return ArtifactVerdictResult{}, fmt.Errorf("validator already voted %s for artifact", existingVerdict)
	}
	if existingVerdict == "" {
		if _, err := store.client.command(ctx, "HSET", votesKey, verdict.ValidatorID, normalizedVerdict); err != nil {
			return ArtifactVerdictResult{}, err
		}
	}

	tally, votes, err := store.artifactVerdictTally(ctx, verdict.JobID)
	if err != nil {
		return ArtifactVerdictResult{}, err
	}
	if _, err := store.client.command(ctx, "HSET", store.key("artifact", verdict.JobID),
		"verdict_status", "pending",
		"verdict_votes", strconv.Itoa(votes),
		"verdict_quorum", strconv.Itoa(quorum),
	); err != nil {
		return ArtifactVerdictResult{}, err
	}

	event, err := store.appendEvent(ctx, "artifact_verdict_vote_recorded", map[string]string{
		"job_id":       verdict.JobID,
		"worker_id":    verdict.WorkerID,
		"validator_id": verdict.ValidatorID,
		"verdict":      normalizedVerdict,
		"reason":       verdict.Reason,
		"votes":        strconv.Itoa(votes),
		"quorum":       strconv.Itoa(quorum),
		"created_at":   verdict.CreatedAt,
	})
	if err != nil {
		return ArtifactVerdictResult{}, err
	}

	finalVerdict := quorumVerdict(tally, quorum)
	if finalVerdict != "" {
		finalReason := fmt.Sprintf("validator quorum reached: %s %d/%d", finalVerdict, tally[finalVerdict], quorum)
		return store.finalizeArtifactVerdict(ctx, ArtifactVerdict{
			JobID:       verdict.JobID,
			WorkerID:    verdict.WorkerID,
			ValidatorID: verdict.ValidatorID,
			Verdict:     finalVerdict,
			Reason:      finalReason,
			CreatedAt:   verdict.CreatedAt,
			Quorum:      quorum,
		}, finalVerdict, quorum, votes, tally)
	}

	reputation, err := store.WorkerReputation(ctx, verdict.WorkerID)
	if err != nil {
		return ArtifactVerdictResult{}, err
	}
	return ArtifactVerdictResult{
		JobID:           verdict.JobID,
		WorkerID:        verdict.WorkerID,
		Verdict:         normalizedVerdict,
		ScoreDelta:      0,
		Reputation:      reputation,
		EventID:         event.ID,
		ParticipationOK: reputation.Status != "suspended",
		Finalized:       false,
		Quorum:          quorum,
		Votes:           votes,
		Tally:           tally,
	}, nil
}

func (store *RedisStore) finalizeArtifactVerdict(ctx context.Context, verdict ArtifactVerdict, normalizedVerdict string, quorum int, votes int, tally map[string]int) (ArtifactVerdictResult, error) {
	lock, err := store.client.command(ctx, "SET", store.key("artifact", verdict.JobID, "verdict_finalize_lock"), normalizedVerdict, "NX", "EX", "30")
	if err != nil {
		return ArtifactVerdictResult{}, err
	}
	if lock.stringValue() != "OK" {
		return store.waitForFinalizedArtifactVerdict(ctx, verdict.JobID, verdict.WorkerID, quorum)
	}
	defer func() {
		_, _ = store.client.command(context.Background(), "DEL", store.key("artifact", verdict.JobID, "verdict_finalize_lock"))
	}()

	artifact, err := store.hash(ctx, store.key("artifact", verdict.JobID))
	if err != nil {
		return ArtifactVerdictResult{}, err
	}
	if artifact["verdict"] != "" {
		return store.finalizedArtifactVerdictResult(ctx, verdict.JobID, verdict.WorkerID, artifact, quorum)
	}

	scoreDelta, reputation, err := store.applyWorkerReputation(ctx, verdict.WorkerID, normalizedVerdict, verdict.CreatedAt)
	if err != nil {
		return ArtifactVerdictResult{}, err
	}
	validatorUpdates, err := store.applyValidatorReputations(ctx, verdict.JobID, verdict.WorkerID, normalizedVerdict, verdict.CreatedAt)
	if err != nil {
		return ArtifactVerdictResult{}, err
	}
	if _, err := store.client.command(ctx, "HSET", store.key("artifact", verdict.JobID),
		"verdict", normalizedVerdict,
		"verdict_reason", verdict.Reason,
		"verdict_validator_id", verdict.ValidatorID,
		"verdict_score_delta", strconv.Itoa(scoreDelta),
		"verdict_at", verdict.CreatedAt,
		"verdict_status", "finalized",
		"verdict_votes", strconv.Itoa(votes),
		"verdict_quorum", strconv.Itoa(quorum),
	); err != nil {
		return ArtifactVerdictResult{}, err
	}
	event, err := store.appendEvent(ctx, "artifact_verdict_recorded", map[string]string{
		"job_id":            verdict.JobID,
		"worker_id":         verdict.WorkerID,
		"validator_id":      verdict.ValidatorID,
		"verdict":           normalizedVerdict,
		"reason":            verdict.Reason,
		"score_delta":       strconv.Itoa(scoreDelta),
		"reputation_score":  strconv.Itoa(reputation.Score),
		"reputation_status": reputation.Status,
		"votes":             strconv.Itoa(votes),
		"quorum":            strconv.Itoa(quorum),
		"created_at":        verdict.CreatedAt,
	})
	if err != nil {
		return ArtifactVerdictResult{}, err
	}
	return ArtifactVerdictResult{
		JobID:                verdict.JobID,
		WorkerID:             verdict.WorkerID,
		Verdict:              normalizedVerdict,
		FinalVerdict:         normalizedVerdict,
		ScoreDelta:           scoreDelta,
		Reputation:           reputation,
		ValidatorReputations: validatorUpdates,
		EventID:              event.ID,
		ParticipationOK:      reputation.Status != "suspended",
		Finalized:            true,
		Quorum:               quorum,
		Votes:                votes,
		Tally:                tally,
	}, nil
}

func (store *RedisStore) waitForFinalizedArtifactVerdict(ctx context.Context, jobID string, workerID string, quorum int) (ArtifactVerdictResult, error) {
	for range 40 {
		artifact, err := store.hash(ctx, store.key("artifact", jobID))
		if err != nil {
			return ArtifactVerdictResult{}, err
		}
		if artifact["verdict"] != "" {
			return store.finalizedArtifactVerdictResult(ctx, jobID, workerID, artifact, quorum)
		}
		select {
		case <-ctx.Done():
			return ArtifactVerdictResult{}, ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
	return ArtifactVerdictResult{}, fmt.Errorf("artifact verdict finalization timed out for %s", jobID)
}

func (store *RedisStore) finalizedArtifactVerdictResult(ctx context.Context, jobID string, workerID string, artifact map[string]string, quorum int) (ArtifactVerdictResult, error) {
	if workerID == "" {
		workerID = artifact["worker_id"]
	}
	reputation, err := store.WorkerReputation(ctx, workerID)
	if err != nil {
		return ArtifactVerdictResult{}, err
	}
	tally, votes, err := store.artifactVerdictTally(ctx, jobID)
	if err != nil {
		return ArtifactVerdictResult{}, err
	}
	if votes == 0 {
		votes = intField(artifact, "verdict_votes", 1)
		tally = map[string]int{artifact["verdict"]: votes}
	}
	return ArtifactVerdictResult{
		JobID:           jobID,
		WorkerID:        workerID,
		Verdict:         artifact["verdict"],
		FinalVerdict:    artifact["verdict"],
		ScoreDelta:      intField(artifact, "verdict_score_delta", 0),
		Reputation:      reputation,
		ParticipationOK: reputation.Status != "suspended",
		Finalized:       true,
		Quorum:          intField(artifact, "verdict_quorum", quorum),
		Votes:           votes,
		Tally:           tally,
	}, nil
}

func (store *RedisStore) requireValidatorCanVote(ctx context.Context, validatorID string, targetWorkerID string) error {
	if validatorID == "" {
		return fmt.Errorf("validator_id is required")
	}
	if validatorID == targetWorkerID {
		return fmt.Errorf("validator cannot validate its own artifact")
	}
	workerFields, err := store.hash(ctx, store.key("worker", validatorID))
	if err != nil {
		return err
	}
	if workerFields["worker_id"] == "" {
		return fmt.Errorf("validator not registered")
	}
	reputation := reputationFromFields(validatorID, workerFields)
	if reputation.Status == "suspended" {
		return fmt.Errorf("validator suspended")
	}
	if !supportsJob(workerFields["supported_jobs"], "validate_artifact") {
		return fmt.Errorf("validator does not support validate_artifact")
	}
	return nil
}

func (store *RedisStore) applyValidatorReputations(ctx context.Context, jobID string, targetWorkerID string, finalVerdict string, createdAt string) ([]ValidatorReputationUpdate, error) {
	votes, err := store.artifactVerdictVotes(ctx, jobID)
	if err != nil {
		return nil, err
	}
	if len(votes) == 0 {
		return nil, nil
	}
	updates := make([]ValidatorReputationUpdate, 0, len(votes))
	for validatorID, vote := range votes {
		if validatorID == "" || validatorID == targetWorkerID {
			continue
		}
		validatorFields, err := store.hash(ctx, store.key("worker", validatorID))
		if err != nil {
			return nil, err
		}
		if validatorFields["worker_id"] == "" {
			continue
		}
		validatorVerdict := validatorReputationVerdict(vote, finalVerdict)
		delta, reputation, err := store.applyWorkerReputation(ctx, validatorID, validatorVerdict, createdAt)
		if err != nil {
			return nil, err
		}
		aligned := vote == finalVerdict
		if _, err := store.appendEvent(ctx, "validator_reputation_updated", map[string]string{
			"job_id":            jobID,
			"target_worker_id":  targetWorkerID,
			"validator_id":      validatorID,
			"vote":              vote,
			"final_verdict":     finalVerdict,
			"aligned":           strconv.FormatBool(aligned),
			"score_delta":       strconv.Itoa(delta),
			"reputation_score":  strconv.Itoa(reputation.Score),
			"reputation_status": reputation.Status,
			"created_at":        createdAt,
		}); err != nil {
			return nil, err
		}
		updates = append(updates, ValidatorReputationUpdate{
			ValidatorID:  validatorID,
			Vote:         vote,
			FinalVerdict: finalVerdict,
			Aligned:      aligned,
			ScoreDelta:   delta,
			Reputation:   reputation,
		})
	}
	return updates, nil
}

func (store *RedisStore) WorkerReputation(ctx context.Context, workerID string) (WorkerReputation, error) {
	if workerID == "" {
		return WorkerReputation{}, fmt.Errorf("worker_id is required")
	}
	fields, err := store.hash(ctx, store.key("worker", workerID))
	if err != nil {
		return WorkerReputation{}, err
	}
	if fields["worker_id"] == "" {
		return WorkerReputation{}, fmt.Errorf("worker not found")
	}
	return reputationFromFields(workerID, fields), nil
}

func (store *RedisStore) Events(ctx context.Context, count int) ([]Event, error) {
	if count <= 0 {
		count = 100
	}
	value, err := store.client.command(ctx, "XREVRANGE", store.key("events"), "+", "-", "COUNT", strconv.Itoa(count))
	if err != nil {
		return nil, err
	}

	events := make([]Event, 0, len(value.items))
	for _, item := range value.items {
		if len(item.items) != 2 {
			continue
		}
		id := item.items[0].stringValue()
		fields := arrayFields(item.items[1])
		events = append(events, Event{
			ID:     id,
			Type:   fields["type"],
			Fields: fields,
		})
	}
	for left, right := 0, len(events)-1; left < right; left, right = left+1, right-1 {
		events[left], events[right] = events[right], events[left]
	}
	return events, nil
}

func (store *RedisStore) appendEvent(ctx context.Context, eventType string, fields map[string]string) (Event, error) {
	fields["type"] = eventType
	value, err := store.client.command(ctx, append([]string{"XADD", store.key("events"), "*"}, mapArgs(fields)...)...)
	if err != nil {
		return Event{}, err
	}
	return Event{ID: value.stringValue(), Type: eventType, Fields: fields}, nil
}

func (store *RedisStore) hash(ctx context.Context, key string) (map[string]string, error) {
	value, err := store.client.command(ctx, "HGETALL", key)
	if err != nil {
		return nil, err
	}
	return arrayFields(value), nil
}

func (store *RedisStore) members(ctx context.Context, key string) ([]string, error) {
	value, err := store.client.command(ctx, "SMEMBERS", key)
	if err != nil {
		return nil, err
	}
	members := make([]string, 0, len(value.items))
	for _, item := range value.items {
		if item.stringValue() != "" {
			members = append(members, item.stringValue())
		}
	}
	return members, nil
}

func (store *RedisStore) artifactVerdictTally(ctx context.Context, jobID string) (map[string]int, int, error) {
	fields, err := store.hash(ctx, store.key("artifact", jobID, "verdict_votes"))
	if err != nil {
		return nil, 0, err
	}
	tally := map[string]int{}
	votes := 0
	for _, verdict := range fields {
		if verdict == "" {
			continue
		}
		tally[verdict] += 1
		votes += 1
	}
	return tally, votes, nil
}

func (store *RedisStore) artifactVerdictVotes(ctx context.Context, jobID string) (map[string]string, error) {
	fields, err := store.hash(ctx, store.key("artifact", jobID, "verdict_votes"))
	if err != nil {
		return nil, err
	}
	votes := map[string]string{}
	for validatorID, verdict := range fields {
		if validatorID != "" && verdict != "" {
			votes[validatorID] = verdict
		}
	}
	return votes, nil
}

func (store *RedisStore) key(parts ...string) string {
	return store.prefix + ":" + strings.Join(parts, ":")
}

func mapArgs(values map[string]string) []string {
	args := make([]string, 0, len(values)*2)
	for key, value := range values {
		args = append(args, key, value)
	}
	return args
}

func arrayFields(value redisValue) map[string]string {
	fields := map[string]string{}
	for index := 0; index+1 < len(value.items); index += 2 {
		fields[value.items[index].stringValue()] = value.items[index+1].stringValue()
	}
	return fields
}

func (store *RedisStore) applyWorkerReputation(ctx context.Context, workerID string, verdict string, createdAt string) (int, WorkerReputation, error) {
	workerFields, err := store.hash(ctx, store.key("worker", workerID))
	if err != nil {
		return 0, WorkerReputation{}, err
	}
	if workerFields["worker_id"] == "" {
		return 0, WorkerReputation{}, fmt.Errorf("worker not found")
	}
	normalizedVerdict, err := normalizeVerdict(verdict)
	if err != nil {
		return 0, WorkerReputation{}, err
	}
	reputation := reputationFromFields(workerID, workerFields)
	delta := reputationDelta(normalizedVerdict)
	reputation.Score = clampInt(reputation.Score+delta, 0, defaultReputationScore)
	reputation.Status = reputationStatus(reputation.Score)
	reputation.ValidationEvents += 1
	reputation.LastVerdictAt = createdAt
	switch normalizedVerdict {
	case "accepted":
		reputation.AcceptedArtifacts += 1
	case "poor":
		reputation.PoorArtifacts += 1
	case "rejected":
		reputation.RejectedArtifacts += 1
	case "malicious":
		reputation.MaliciousArtifacts += 1
	case "timeout":
		reputation.TimeoutJobs += 1
	}
	if _, err := store.client.command(ctx, "HSET", store.key("worker", workerID),
		"reputation_score", strconv.Itoa(reputation.Score),
		"reputation_status", reputation.Status,
		"accepted_artifacts", strconv.Itoa(reputation.AcceptedArtifacts),
		"poor_artifacts", strconv.Itoa(reputation.PoorArtifacts),
		"rejected_artifacts", strconv.Itoa(reputation.RejectedArtifacts),
		"malicious_artifacts", strconv.Itoa(reputation.MaliciousArtifacts),
		"timeout_jobs", strconv.Itoa(reputation.TimeoutJobs),
		"validation_events", strconv.Itoa(reputation.ValidationEvents),
		"last_verdict_at", reputation.LastVerdictAt,
	); err != nil {
		return 0, WorkerReputation{}, err
	}
	if _, err := store.appendEvent(ctx, "worker_reputation_updated", map[string]string{
		"worker_id":         workerID,
		"verdict":           normalizedVerdict,
		"score_delta":       strconv.Itoa(delta),
		"reputation_score":  strconv.Itoa(reputation.Score),
		"reputation_status": reputation.Status,
		"created_at":        createdAt,
	}); err != nil {
		return 0, WorkerReputation{}, err
	}
	return delta, reputation, nil
}

func reputationFromFields(workerID string, fields map[string]string) WorkerReputation {
	score := intField(fields, "reputation_score", defaultReputationScore)
	return WorkerReputation{
		WorkerID:           workerID,
		Score:              score,
		Status:             nonEmpty(fields["reputation_status"], reputationStatus(score)),
		AcceptedArtifacts:  intField(fields, "accepted_artifacts", 0),
		PoorArtifacts:      intField(fields, "poor_artifacts", 0),
		RejectedArtifacts:  intField(fields, "rejected_artifacts", 0),
		MaliciousArtifacts: intField(fields, "malicious_artifacts", 0),
		TimeoutJobs:        intField(fields, "timeout_jobs", 0),
		ValidationEvents:   intField(fields, "validation_events", 0),
		LastVerdictAt:      fields["last_verdict_at"],
	}
}

func normalizeVerdict(value string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "accepted":
		return "accepted", nil
	case "poor":
		return "poor", nil
	case "rejected":
		return "rejected", nil
	case "malicious":
		return "malicious", nil
	case "timeout":
		return "timeout", nil
	default:
		return "", fmt.Errorf("unsupported verdict: %s", value)
	}
}

func quorumVerdict(tally map[string]int, quorum int) string {
	for _, verdict := range []string{"malicious", "rejected", "poor", "accepted", "timeout"} {
		if tally[verdict] >= quorum {
			return verdict
		}
	}
	return ""
}

func reputationDelta(verdict string) int {
	switch verdict {
	case "accepted":
		return 2
	case "poor":
		return -10
	case "rejected":
		return -25
	case "malicious":
		return -100
	case "timeout":
		return -15
	default:
		return 0
	}
}

func validatorReputationVerdict(vote string, finalVerdict string) string {
	if vote == finalVerdict {
		return "accepted"
	}
	if (finalVerdict == "malicious" && vote == "accepted") || (finalVerdict == "accepted" && vote == "malicious") {
		return "malicious"
	}
	return "rejected"
}

func reputationStatus(score int) string {
	if score < suspendedReputationThreshold {
		return "suspended"
	}
	if score < degradedReputationThreshold {
		return "degraded"
	}
	return "active"
}

func intField(fields map[string]string, key string, fallback int) int {
	if fields[key] == "" {
		return fallback
	}
	value, err := strconv.Atoi(fields[key])
	if err != nil {
		return fallback
	}
	return value
}

func nonEmpty(value string, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func supportsJob(supportedJobs string, expected string) bool {
	for _, job := range strings.Split(supportedJobs, ",") {
		if strings.TrimSpace(job) == expected {
			return true
		}
	}
	return false
}

func clampInt(value int, min int, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func jobFromFields(fields map[string]string) Job {
	return Job{
		JobID:      fields["job_id"],
		RunID:      fields["run_id"],
		JobType:    fields["job_type"],
		Backend:    fields["backend"],
		DatasetURI: fields["dataset_uri"],
		Status:     fields["status"],
		WorkerID:   fields["worker_id"],
		PeerID:     fields["peer_id"],
		JobSpec:    json.RawMessage(fields["job_spec"]),
		CreatedAt:  fields["created_at"],
	}
}

func workerFromFields(fields map[string]string) Worker {
	memoryGB, _ := strconv.ParseFloat(fields["memory_gb"], 64)
	supportedJobs := []string{}
	if fields["supported_jobs"] != "" {
		supportedJobs = strings.Split(fields["supported_jobs"], ",")
	}
	return Worker{
		WorkerID:      fields["worker_id"],
		PeerID:        fields["peer_id"],
		PublicKey:     fields["public_key"],
		Backend:       fields["backend"],
		DeviceFamily:  fields["device_family"],
		MemoryGB:      memoryGB,
		SupportedJobs: supportedJobs,
		CreatedAt:     fields["created_at"],
		Status:        fields["status"],
		CurrentJobID:  fields["current_job_id"],
		LastSeenAt:    fields["last_seen_at"],
		Reputation:    reputationFromFields(fields["worker_id"], fields),
	}
}

func artifactFromFields(fields map[string]string) Artifact {
	return Artifact{
		JobID:         fields["job_id"],
		WorkerID:      fields["worker_id"],
		PeerID:        fields["peer_id"],
		ArtifactType:  fields["artifact_type"],
		ArtifactURI:   fields["artifact_uri"],
		ArtifactHash:  fields["artifact_hash"],
		ConfigHash:    fields["config_hash"],
		MetricsURI:    fields["metrics_uri"],
		CreatedAt:     fields["created_at"],
		Verdict:       fields["verdict"],
		VerdictAt:     fields["verdict_at"],
		VerdictStatus: fields["verdict_status"],
		VerdictVotes:  intField(fields, "verdict_votes", 0),
		VerdictQuorum: intField(fields, "verdict_quorum", 0),
	}
}
