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
	WorkerID      string   `json:"worker_id"`
	PeerID        string   `json:"peer_id"`
	Backend       string   `json:"backend"`
	DeviceFamily  string   `json:"device_family"`
	MemoryGB      float64  `json:"memory_gb"`
	SupportedJobs []string `json:"supported_jobs"`
	CreatedAt     string   `json:"created_at,omitempty"`
}

type Job struct {
	JobID      string          `json:"job_id"`
	RunID      string          `json:"run_id"`
	JobType    string          `json:"job_type"`
	Backend    string          `json:"backend"`
	DatasetURI string          `json:"dataset_uri"`
	Status     string          `json:"status,omitempty"`
	WorkerID   string          `json:"worker_id,omitempty"`
	PeerID     string          `json:"peer_id,omitempty"`
	JobSpec    json.RawMessage `json:"job_spec,omitempty"`
	CreatedAt  string          `json:"created_at,omitempty"`
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
	JobID        string `json:"job_id"`
	WorkerID     string `json:"worker_id"`
	PeerID       string `json:"peer_id"`
	ArtifactType string `json:"artifact_type"`
	ArtifactURI  string `json:"artifact_uri"`
	ArtifactHash string `json:"artifact_hash"`
	ConfigHash   string `json:"config_hash"`
	MetricsURI   string `json:"metrics_uri,omitempty"`
	CreatedAt    string `json:"created_at,omitempty"`
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
	WorkersRegistered  int `json:"workers_registered"`
	WorkersBusy        int `json:"workers_busy"`
	JobsQueued         int `json:"jobs_queued"`
	JobsRunning        int `json:"jobs_running"`
	JobsCompleted      int `json:"jobs_completed"`
	JobsFailed         int `json:"jobs_failed"`
	ArtifactsPublished int `json:"artifacts_published"`
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

func nowUTC() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}
