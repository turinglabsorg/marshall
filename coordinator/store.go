package coordinator

import "context"

type Store interface {
	CreateRun(context.Context, Run) (Event, error)
	RegisterWorker(context.Context, Worker) (Event, error)
	CreateJob(context.Context, Job) (Event, error)
	GetJob(context.Context, string) (Job, error)
	ClaimJob(context.Context, JobClaim) (JobClaimResult, error)
	UpdateJobStatus(context.Context, JobStatus) (Event, error)
	PublishArtifact(context.Context, Artifact) (Event, error)
	GetArtifact(context.Context, string) (Artifact, error)
	Events(context.Context, int) ([]Event, error)
}
