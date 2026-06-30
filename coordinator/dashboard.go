package coordinator

import (
	"context"
	"net/http"
	"sort"
)

func (server *Server) dashboard(response http.ResponseWriter, request *http.Request) {
	snapshot, err := server.dashboardSnapshot(request.Context())
	writeResult(response, snapshot, err)
}

func (server *Server) dashboardSnapshot(ctx context.Context) (DashboardSnapshot, error) {
	workers, err := server.store.Workers(ctx)
	if err != nil {
		return DashboardSnapshot{}, err
	}
	jobs, err := server.store.Jobs(ctx)
	if err != nil {
		return DashboardSnapshot{}, err
	}
	artifacts, err := server.store.Artifacts(ctx)
	if err != nil {
		return DashboardSnapshot{}, err
	}
	events, err := server.store.Events(ctx, 100)
	if err != nil {
		return DashboardSnapshot{}, err
	}

	sort.Slice(workers, func(left, right int) bool {
		return workers[left].WorkerID < workers[right].WorkerID
	})
	sort.Slice(jobs, func(left, right int) bool {
		if jobs[left].CreatedAt == jobs[right].CreatedAt {
			return jobs[left].JobID < jobs[right].JobID
		}
		return jobs[left].CreatedAt < jobs[right].CreatedAt
	})
	sort.Slice(artifacts, func(left, right int) bool {
		if artifacts[left].CreatedAt == artifacts[right].CreatedAt {
			return artifacts[left].JobID < artifacts[right].JobID
		}
		return artifacts[left].CreatedAt < artifacts[right].CreatedAt
	})

	artifactByJob := map[string]Artifact{}
	for _, artifact := range artifacts {
		artifactByJob[artifact.JobID] = artifact
	}

	workerActivities := map[string]*WorkerActivity{}
	for _, worker := range workers {
		worker := worker
		lastSeenAt := worker.LastSeenAt
		if lastSeenAt == "" {
			lastSeenAt = worker.CreatedAt
		}
		workerActivities[worker.WorkerID] = &WorkerActivity{
			Worker:       worker,
			Busy:         worker.Status == "working",
			CurrentJobID: worker.CurrentJobID,
			LastStatus:   worker.Status,
			LastSeenAt:   lastSeenAt,
		}
	}

	summary := DashboardSummary{
		WorkersRegistered:  len(workers),
		ArtifactsPublished: len(artifacts),
	}
	jobActivities := make([]JobActivity, 0, len(jobs))
	for _, job := range jobs {
		switch job.Status {
		case "queued":
			summary.JobsQueued += 1
		case "claimed", "running":
			summary.JobsRunning += 1
		case "completed":
			summary.JobsCompleted += 1
		case "failed":
			summary.JobsFailed += 1
		}

		if activity, ok := workerActivities[job.WorkerID]; ok {
			if job.Status == "claimed" || job.Status == "running" {
				activity.Busy = true
				activity.CurrentJobID = job.JobID
				activity.CurrentJobType = job.JobType
				activity.LastStatus = job.Status
			}
		}

		var artifactPointer *Artifact
		if artifact, ok := artifactByJob[job.JobID]; ok {
			artifact := artifact
			artifactPointer = &artifact
		}
		jobActivities = append(jobActivities, JobActivity{
			Job:      job,
			Artifact: artifactPointer,
		})
	}

	for _, event := range events {
		workerID := event.Fields["worker_id"]
		if workerID == "" {
			continue
		}
		activity, ok := workerActivities[workerID]
		if !ok {
			activity = &WorkerActivity{
				Worker: Worker{
					WorkerID: workerID,
					PeerID:   event.Fields["peer_id"],
					Backend:  event.Fields["backend"],
				},
			}
			workerActivities[workerID] = activity
		}
		activity.LastEventType = event.Type
		activity.LastSeenAt = event.Fields["created_at"]
		if event.Type == "job_status_updated" {
			activity.LastStatus = event.Fields["status"]
		}
		if event.Type == "artifact_published" {
			activity.LastArtifactType = event.Fields["artifact_type"]
			activity.LastArtifactHash = event.Fields["artifact_hash"]
		}
	}

	activities := make([]WorkerActivity, 0, len(workerActivities))
	for _, activity := range workerActivities {
		if activity.Busy {
			summary.WorkersBusy += 1
		}
		activities = append(activities, *activity)
	}
	sort.Slice(activities, func(left, right int) bool {
		if activities[left].Busy != activities[right].Busy {
			return activities[left].Busy
		}
		return activities[left].Worker.WorkerID < activities[right].Worker.WorkerID
	})

	return DashboardSnapshot{
		GeneratedAt:  nowUTC(),
		Summary:      summary,
		Workers:      activities,
		Jobs:         jobActivities,
		Artifacts:    artifacts,
		RecentEvents: events,
	}, nil
}
