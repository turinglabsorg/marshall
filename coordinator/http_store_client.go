package coordinator

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const federationHeader = "X-Marshall-Federation"

type RemoteStore struct {
	baseURL string
	token   string
	client  *http.Client
}

func NewRemoteStore(baseURL string, token string) *RemoteStore {
	return &RemoteStore{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		client:  &http.Client{Timeout: 10 * time.Second},
	}
}

func (store *RemoteStore) CreateRun(ctx context.Context, run Run) (Event, error) {
	var event Event
	err := store.do(ctx, http.MethodPost, "/runs", run, &event)
	return event, err
}

func (store *RemoteStore) RegisterWorker(ctx context.Context, worker Worker) (Event, error) {
	var event Event
	err := store.do(ctx, http.MethodPost, "/workers", worker, &event)
	return event, err
}

func (store *RemoteStore) WorkerHeartbeat(ctx context.Context, heartbeat WorkerHeartbeat) (Event, error) {
	var event Event
	err := store.do(ctx, http.MethodPost, "/workers/"+url.PathEscape(heartbeat.WorkerID)+"/heartbeat", heartbeat, &event)
	return event, err
}

func (store *RemoteStore) Workers(ctx context.Context) ([]Worker, error) {
	var workers []Worker
	err := store.do(ctx, http.MethodGet, "/workers", nil, &workers)
	return workers, err
}

func (store *RemoteStore) CreateJob(ctx context.Context, job Job) (Event, error) {
	var event Event
	err := store.do(ctx, http.MethodPost, "/jobs", job, &event)
	return event, err
}

func (store *RemoteStore) GetJob(ctx context.Context, jobID string) (Job, error) {
	var job Job
	err := store.do(ctx, http.MethodGet, "/jobs/"+url.PathEscape(jobID), nil, &job)
	return job, err
}

func (store *RemoteStore) Jobs(ctx context.Context) ([]Job, error) {
	var jobs []Job
	err := store.do(ctx, http.MethodGet, "/jobs", nil, &jobs)
	return jobs, err
}

func (store *RemoteStore) ClaimJob(ctx context.Context, claim JobClaim) (JobClaimResult, error) {
	var result JobClaimResult
	err := store.do(ctx, http.MethodPost, "/jobs/"+url.PathEscape(claim.JobID)+"/claim", claim, &result)
	return result, err
}

func (store *RemoteStore) RequeueExpiredJobs(ctx context.Context) (RequeueResult, error) {
	var result RequeueResult
	err := store.do(ctx, http.MethodPost, "/jobs/requeue-expired", map[string]string{}, &result)
	return result, err
}

func (store *RemoteStore) UpdateJobStatus(ctx context.Context, status JobStatus) (Event, error) {
	var event Event
	err := store.do(ctx, http.MethodPost, "/jobs/"+url.PathEscape(status.JobID)+"/status", status, &event)
	return event, err
}

func (store *RemoteStore) PublishArtifact(ctx context.Context, artifact Artifact) (Event, error) {
	var event Event
	err := store.do(ctx, http.MethodPost, "/artifacts", artifact, &event)
	return event, err
}

func (store *RemoteStore) GetArtifact(ctx context.Context, jobID string) (Artifact, error) {
	var artifact Artifact
	err := store.do(ctx, http.MethodGet, "/artifacts/"+url.PathEscape(jobID), nil, &artifact)
	return artifact, err
}

func (store *RemoteStore) Artifacts(ctx context.Context) ([]Artifact, error) {
	var artifacts []Artifact
	err := store.do(ctx, http.MethodGet, "/artifacts", nil, &artifacts)
	return artifacts, err
}

func (store *RemoteStore) RecordArtifactVerdict(ctx context.Context, verdict ArtifactVerdict) (ArtifactVerdictResult, error) {
	var result ArtifactVerdictResult
	err := store.do(ctx, http.MethodPost, "/artifacts/"+url.PathEscape(verdict.JobID)+"/verdict", verdict, &result)
	return result, err
}

func (store *RemoteStore) WorkerReputation(ctx context.Context, workerID string) (WorkerReputation, error) {
	var reputation WorkerReputation
	err := store.do(ctx, http.MethodGet, "/workers/"+url.PathEscape(workerID)+"/reputation", nil, &reputation)
	return reputation, err
}

func (store *RemoteStore) Events(ctx context.Context, count int) ([]Event, error) {
	var events []Event
	path := fmt.Sprintf("/events?count=%d", count)
	err := store.do(ctx, http.MethodGet, path, nil, &events)
	return events, err
}

func (store *RemoteStore) do(ctx context.Context, method string, path string, payload any, target any) error {
	var body *bytes.Reader
	if payload == nil {
		body = bytes.NewReader(nil)
	} else {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, store.baseURL+path, body)
	if err != nil {
		return err
	}
	request.Header.Set(federationHeader, "1")
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if store.token != "" {
		request.Header.Set("X-Marshall-Token", store.token)
	}
	response, err := store.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var errorBody struct {
			Error string `json:"error"`
		}
		_ = json.NewDecoder(response.Body).Decode(&errorBody)
		if errorBody.Error == "" {
			errorBody.Error = response.Status
		}
		return fmt.Errorf("remote coordinator %s %s failed: %s", method, path, errorBody.Error)
	}
	if target == nil {
		return nil
	}
	return json.NewDecoder(response.Body).Decode(target)
}
