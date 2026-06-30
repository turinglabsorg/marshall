package coordinator

import (
	"encoding/json"
	"time"
)

type Run struct {
	RunID     string `json:"run_id"`
	Objective string `json:"objective"`
	CreatedAt string `json:"created_at,omitempty"`
}

type Worker struct {
	WorkerID                 string           `json:"worker_id"`
	PeerID                   string           `json:"peer_id"`
	PublicKey                string           `json:"public_key,omitempty"`
	Backend                  string           `json:"backend"`
	DeviceFamily             string           `json:"device_family"`
	MemoryGB                 float64          `json:"memory_gb"`
	SupportedJobs            []string         `json:"supported_jobs"`
	CreatedAt                string           `json:"created_at,omitempty"`
	Status                   string           `json:"status,omitempty"`
	CurrentJobID             string           `json:"current_job_id,omitempty"`
	LastSeenAt               string           `json:"last_seen_at,omitempty"`
	ProgressPercent          *float64         `json:"progress_percent,omitempty"`
	ProgressLabel            string           `json:"progress_label,omitempty"`
	WorkUnitsDone            *float64         `json:"work_units_done,omitempty"`
	WorkUnitsTotal           *float64         `json:"work_units_total,omitempty"`
	ThroughputUnitsPerSecond *float64         `json:"throughput_units_per_second,omitempty"`
	ThroughputLabel          string           `json:"throughput_label,omitempty"`
	Reputation               WorkerReputation `json:"reputation"`
}

type WorkerHeartbeat struct {
	WorkerID                 string   `json:"worker_id"`
	PeerID                   string   `json:"peer_id"`
	Status                   string   `json:"status"`
	CurrentJobID             string   `json:"job_id,omitempty"`
	Timestamp                string   `json:"timestamp,omitempty"`
	LeaseSeconds             int      `json:"lease_seconds,omitempty"`
	ProgressPercent          *float64 `json:"progress_percent,omitempty"`
	ProgressLabel            string   `json:"progress_label,omitempty"`
	WorkUnitsDone            *float64 `json:"work_units_done,omitempty"`
	WorkUnitsTotal           *float64 `json:"work_units_total,omitempty"`
	ThroughputUnitsPerSecond *float64 `json:"throughput_units_per_second,omitempty"`
	ThroughputLabel          string   `json:"throughput_label,omitempty"`
}

type Job struct {
	JobID                    string          `json:"job_id"`
	RunID                    string          `json:"run_id"`
	JobType                  string          `json:"job_type"`
	Backend                  string          `json:"backend"`
	DatasetURI               string          `json:"dataset_uri"`
	Status                   string          `json:"status,omitempty"`
	WorkerID                 string          `json:"worker_id,omitempty"`
	PeerID                   string          `json:"peer_id,omitempty"`
	JobSpec                  json.RawMessage `json:"job_spec,omitempty"`
	CreatedAt                string          `json:"created_at,omitempty"`
	ProgressPercent          *float64        `json:"progress_percent,omitempty"`
	ProgressLabel            string          `json:"progress_label,omitempty"`
	WorkUnitsDone            *float64        `json:"work_units_done,omitempty"`
	WorkUnitsTotal           *float64        `json:"work_units_total,omitempty"`
	ThroughputUnitsPerSecond *float64        `json:"throughput_units_per_second,omitempty"`
	ThroughputLabel          string          `json:"throughput_label,omitempty"`
}

type JobClaim struct {
	JobID        string `json:"job_id"`
	WorkerID     string `json:"worker_id"`
	PeerID       string `json:"peer_id"`
	LeaseSeconds int    `json:"lease_seconds,omitempty"`
}

type JobClaimResult struct {
	Accepted bool   `json:"accepted"`
	JobID    string `json:"job_id"`
	WorkerID string `json:"worker_id,omitempty"`
	Reason   string `json:"reason,omitempty"`
	EventID  string `json:"event_id,omitempty"`
}

type JobStatus struct {
	JobID    string `json:"job_id"`
	WorkerID string `json:"worker_id"`
	Status   string `json:"status"`
	Message  string `json:"message,omitempty"`
}

type Artifact struct {
	JobID         string `json:"job_id"`
	WorkerID      string `json:"worker_id"`
	PeerID        string `json:"peer_id"`
	ArtifactType  string `json:"artifact_type"`
	ArtifactURI   string `json:"artifact_uri"`
	ArtifactHash  string `json:"artifact_hash"`
	ConfigHash    string `json:"config_hash"`
	MetricsURI    string `json:"metrics_uri,omitempty"`
	CreatedAt     string `json:"created_at,omitempty"`
	Verdict       string `json:"verdict,omitempty"`
	VerdictAt     string `json:"verdict_at,omitempty"`
	VerdictStatus string `json:"verdict_status,omitempty"`
	VerdictVotes  int    `json:"verdict_votes,omitempty"`
	VerdictQuorum int    `json:"verdict_quorum,omitempty"`
}

type WorkerReputation struct {
	WorkerID           string `json:"worker_id"`
	Score              int    `json:"score"`
	Status             string `json:"status"`
	AcceptedArtifacts  int    `json:"accepted_artifacts"`
	PoorArtifacts      int    `json:"poor_artifacts"`
	RejectedArtifacts  int    `json:"rejected_artifacts"`
	MaliciousArtifacts int    `json:"malicious_artifacts"`
	TimeoutJobs        int    `json:"timeout_jobs"`
	ValidationEvents   int    `json:"validation_events"`
	LastVerdictAt      string `json:"last_verdict_at,omitempty"`
}

type ArtifactVerdict struct {
	JobID       string `json:"job_id"`
	WorkerID    string `json:"worker_id"`
	ValidatorID string `json:"validator_id,omitempty"`
	Verdict     string `json:"verdict"`
	Reason      string `json:"reason,omitempty"`
	CreatedAt   string `json:"created_at,omitempty"`
	Quorum      int    `json:"quorum,omitempty"`
}

type ArtifactVerdictResult struct {
	JobID                string                      `json:"job_id"`
	WorkerID             string                      `json:"worker_id"`
	Verdict              string                      `json:"verdict"`
	FinalVerdict         string                      `json:"final_verdict,omitempty"`
	ScoreDelta           int                         `json:"score_delta"`
	Reputation           WorkerReputation            `json:"reputation"`
	ValidatorReputations []ValidatorReputationUpdate `json:"validator_reputations,omitempty"`
	EventID              string                      `json:"event_id,omitempty"`
	ParticipationOK      bool                        `json:"participation_ok"`
	Finalized            bool                        `json:"finalized"`
	Quorum               int                         `json:"quorum"`
	Votes                int                         `json:"votes"`
	Tally                map[string]int              `json:"tally,omitempty"`
}

type ValidatorReputationUpdate struct {
	ValidatorID  string           `json:"validator_id"`
	Vote         string           `json:"vote"`
	FinalVerdict string           `json:"final_verdict"`
	Aligned      bool             `json:"aligned"`
	ScoreDelta   int              `json:"score_delta"`
	Reputation   WorkerReputation `json:"reputation"`
}

type Event struct {
	ID     string            `json:"id"`
	Type   string            `json:"type"`
	Fields map[string]string `json:"fields"`
}

type DashboardSnapshot struct {
	GeneratedAt  string           `json:"generated_at"`
	Summary      DashboardSummary `json:"summary"`
	Workers      []WorkerActivity `json:"workers"`
	Jobs         []JobActivity    `json:"jobs"`
	Artifacts    []Artifact       `json:"artifacts"`
	RecentEvents []Event          `json:"recent_events"`
}

type DashboardSummary struct {
	WorkersRegistered               int     `json:"workers_registered"`
	WorkersBusy                     int     `json:"workers_busy"`
	JobsQueued                      int     `json:"jobs_queued"`
	JobsRunning                     int     `json:"jobs_running"`
	JobsCompleted                   int     `json:"jobs_completed"`
	JobsFailed                      int     `json:"jobs_failed"`
	ArtifactsPublished              int     `json:"artifacts_published"`
	ClusterThroughputUnitsPerSecond float64 `json:"cluster_throughput_units_per_second,omitempty"`
	ClusterThroughputLabel          string  `json:"cluster_throughput_label,omitempty"`
	ActiveThroughputWorkers         int     `json:"active_throughput_workers,omitempty"`
}

type WorkerActivity struct {
	Worker           Worker `json:"worker"`
	Busy             bool   `json:"busy"`
	CurrentJobID     string `json:"current_job_id,omitempty"`
	CurrentJobType   string `json:"current_job_type,omitempty"`
	LastStatus       string `json:"last_status,omitempty"`
	LastSeenAt       string `json:"last_seen_at,omitempty"`
	LastEventType    string `json:"last_event_type,omitempty"`
	LastArtifactType string `json:"last_artifact_type,omitempty"`
	LastArtifactHash string `json:"last_artifact_hash,omitempty"`
}

type JobActivity struct {
	Job      Job       `json:"job"`
	Artifact *Artifact `json:"artifact,omitempty"`
}

type RequeueResult struct {
	Requeued []string `json:"requeued"`
}

func nowUTC() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}
