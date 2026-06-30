package coordinator

import (
	"context"
	"testing"
	"time"
)

type dashboardStore struct {
	Store
	workers   []Worker
	jobs      []Job
	artifacts []Artifact
	events    []Event
}

func (store dashboardStore) Workers(context.Context) ([]Worker, error) {
	return store.workers, nil
}

func (store dashboardStore) Jobs(context.Context) ([]Job, error) {
	return store.jobs, nil
}

func (store dashboardStore) Artifacts(context.Context) ([]Artifact, error) {
	return store.artifacts, nil
}

func (store dashboardStore) Events(context.Context, int) ([]Event, error) {
	return store.events, nil
}

func TestDashboardHidesStaleWorkers(t *testing.T) {
	now := time.Now().UTC()
	recent := now.Add(-(dashboardWorkerStaleAfter - time.Minute)).Format(time.RFC3339Nano)
	stale := now.Add(-(dashboardWorkerStaleAfter + time.Minute)).Format(time.RFC3339Nano)

	server := &Server{
		store: dashboardStore{
			workers: []Worker{
				{
					WorkerID:   "worker_recent",
					PeerID:     "12D3KooWRecent",
					Backend:    "mlx",
					Status:     "idle",
					CreatedAt:  stale,
					LastSeenAt: recent,
				},
				{
					WorkerID:   "worker_stale",
					PeerID:     "12D3KooWStale",
					Backend:    "mlx",
					Status:     "idle",
					CreatedAt:  stale,
					LastSeenAt: stale,
				},
			},
			events: []Event{
				{
					Type: "worker_heartbeat",
					Fields: map[string]string{
						"worker_id":  "worker_recent",
						"peer_id":    "12D3KooWRecent",
						"status":     "idle",
						"created_at": recent,
					},
				},
			},
		},
	}

	snapshot, err := server.dashboardSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Summary.WorkersRegistered != 1 {
		t.Fatalf("expected one visible worker, got %+v", snapshot.Summary)
	}
	if len(snapshot.Workers) != 1 || snapshot.Workers[0].Worker.WorkerID != "worker_recent" {
		t.Fatalf("unexpected visible workers: %+v", snapshot.Workers)
	}
}
