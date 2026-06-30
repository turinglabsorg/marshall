package coordinator

import "context"

type Store interface {
	CreateRun(context.Context, Run) (Event, error)
	RegisterWorker(context.Context, Worker) (Event, error)
	WorkerHeartbeat(context.Context, WorkerHeartbeat) (Event, error)
	Workers(context.Context) ([]Worker, error)
	CreateJob(context.Context, Job) (Event, error)
	GetJob(context.Context, string) (Job, error)
	Jobs(context.Context) ([]Job, error)
	ClaimJob(context.Context, JobClaim) (JobClaimResult, error)
	RequeueExpiredJobs(context.Context) (RequeueResult, error)
	UpdateJobStatus(context.Context, JobStatus) (Event, error)
	PublishArtifact(context.Context, Artifact) (Event, error)
	GetArtifact(context.Context, string) (Artifact, error)
	Artifacts(context.Context) ([]Artifact, error)
	RecordArtifactVerdict(context.Context, ArtifactVerdict) (ArtifactVerdictResult, error)
	WorkerReputation(context.Context, string) (WorkerReputation, error)
	Events(context.Context, int) ([]Event, error)
}
