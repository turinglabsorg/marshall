package coordinator

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

const defaultLeaseSeconds = 300

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
	if worker.CreatedAt == "" {
		worker.CreatedAt = nowUTC()
	}

	if _, err := store.client.command(ctx, append([]string{"HSET", store.key("worker", worker.WorkerID)}, mapArgs(map[string]string{
		"worker_id":      worker.WorkerID,
		"peer_id":        worker.PeerID,
		"backend":        worker.Backend,
		"device_family":  worker.DeviceFamily,
		"memory_gb":      strconv.FormatFloat(worker.MemoryGB, 'f', -1, 64),
		"supported_jobs": strings.Join(worker.SupportedJobs, ","),
		"created_at":     worker.CreatedAt,
	})...)...); err != nil {
		return Event{}, err
	}
	if _, err := store.client.command(ctx, "SADD", store.key("workers"), worker.WorkerID); err != nil {
		return Event{}, err
	}
	return store.appendEvent(ctx, "worker_registered", map[string]string{
		"worker_id":  worker.WorkerID,
		"peer_id":    worker.PeerID,
		"backend":    worker.Backend,
		"created_at": worker.CreatedAt,
	})
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

func (store *RedisStore) ClaimJob(ctx context.Context, claim JobClaim) (JobClaimResult, error) {
	if claim.JobID == "" || claim.WorkerID == "" || claim.PeerID == "" {
		return JobClaimResult{}, fmt.Errorf("job_id, worker_id, and peer_id are required")
	}
	if claim.LeaseSeconds <= 0 {
		claim.LeaseSeconds = defaultLeaseSeconds
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

func (store *RedisStore) UpdateJobStatus(ctx context.Context, status JobStatus) (Event, error) {
	if status.JobID == "" || status.WorkerID == "" || status.Status == "" {
		return Event{}, fmt.Errorf("job_id, worker_id, and status are required")
	}
	now := nowUTC()
	if _, err := store.client.command(ctx, "HSET", store.key("job", status.JobID), "status", status.Status, "status_message", status.Message, "status_at", now); err != nil {
		return Event{}, err
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

func (store *RedisStore) Events(ctx context.Context, count int) ([]Event, error) {
	if count <= 0 {
		count = 100
	}
	value, err := store.client.command(ctx, "XRANGE", store.key("events"), "-", "+", "COUNT", strconv.Itoa(count))
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

func artifactFromFields(fields map[string]string) Artifact {
	return Artifact{
		JobID:        fields["job_id"],
		WorkerID:     fields["worker_id"],
		PeerID:       fields["peer_id"],
		ArtifactType: fields["artifact_type"],
		ArtifactURI:  fields["artifact_uri"],
		ArtifactHash: fields["artifact_hash"],
		ConfigHash:   fields["config_hash"],
		MetricsURI:   fields["metrics_uri"],
		CreatedAt:    fields["created_at"],
	}
}
