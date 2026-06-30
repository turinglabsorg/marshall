package coordinator

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
)

type Server struct {
	store     Store
	mux       *http.ServeMux
	authToken string
}

type ServerOption func(*Server)

func WithAuthToken(token string) ServerOption {
	return func(server *Server) {
		server.authToken = token
	}
}

func NewServer(store Store, options ...ServerOption) *Server {
	server := &Server{
		store: store,
		mux:   http.NewServeMux(),
	}
	for _, option := range options {
		option(server)
	}
	server.routes()
	return server
}

func (server *Server) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	server.mux.ServeHTTP(response, request)
}

func (server *Server) routes() {
	server.mux.HandleFunc("GET /", server.index)
	server.mux.HandleFunc("GET /AGENTS.md", server.participantAgents)
	server.mux.HandleFunc("GET /favicon.svg", server.favicon)
	server.mux.HandleFunc("GET /health", server.health)
	server.mux.HandleFunc("GET /dashboard", server.dashboard)
	server.mux.HandleFunc("POST /runs", server.requireAuth(server.createRun))
	server.mux.HandleFunc("POST /workers", server.requireAuth(server.registerWorker))
	server.mux.HandleFunc("POST /workers/{worker_id}/heartbeat", server.requireAuth(server.workerHeartbeat))
	server.mux.HandleFunc("GET /workers/{worker_id}/reputation", server.workerReputation)
	server.mux.HandleFunc("POST /jobs", server.requireAuth(server.createJob))
	server.mux.HandleFunc("POST /jobs/requeue-expired", server.requireAuth(server.requeueExpiredJobs))
	server.mux.HandleFunc("GET /jobs/{job_id}", server.getJob)
	server.mux.HandleFunc("POST /jobs/{job_id}/claim", server.requireAuth(server.claimJob))
	server.mux.HandleFunc("POST /jobs/{job_id}/status", server.requireAuth(server.updateJobStatus))
	server.mux.HandleFunc("POST /artifacts", server.requireAuth(server.publishArtifact))
	server.mux.HandleFunc("GET /artifacts", server.artifacts)
	server.mux.HandleFunc("GET /artifacts/{job_id}", server.getArtifact)
	server.mux.HandleFunc("POST /artifacts/{job_id}/verdict", server.requireAuth(server.recordArtifactVerdict))
	server.mux.HandleFunc("GET /events", server.events)
	server.mux.HandleFunc("GET /events/stream", server.eventStream)
}

func (server *Server) requireAuth(handler http.HandlerFunc) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		if server.authToken == "" {
			handler(response, request)
			return
		}
		if requestBearerToken(request) != server.authToken {
			writeJSON(response, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		handler(response, request)
	}
}

func requestBearerToken(request *http.Request) string {
	if token := request.Header.Get("X-Marshall-Token"); token != "" {
		return token
	}
	auth := request.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(auth, "Bearer "))
}

func (server *Server) health(response http.ResponseWriter, _ *http.Request) {
	writeJSON(response, http.StatusOK, map[string]string{"status": "ok"})
}

func (server *Server) createRun(response http.ResponseWriter, request *http.Request) {
	var run Run
	if !decodeJSON(response, request, &run) {
		return
	}
	event, err := server.store.CreateRun(request.Context(), run)
	writeResult(response, event, err)
}

func (server *Server) registerWorker(response http.ResponseWriter, request *http.Request) {
	var worker Worker
	if !decodeJSON(response, request, &worker) {
		return
	}
	event, err := server.store.RegisterWorker(request.Context(), worker)
	writeResult(response, event, err)
}

func (server *Server) workerHeartbeat(response http.ResponseWriter, request *http.Request) {
	var heartbeat WorkerHeartbeat
	if !decodeJSON(response, request, &heartbeat) {
		return
	}
	heartbeat.WorkerID = request.PathValue("worker_id")
	event, err := server.store.WorkerHeartbeat(request.Context(), heartbeat)
	writeResult(response, event, err)
}

func (server *Server) workerReputation(response http.ResponseWriter, request *http.Request) {
	reputation, err := server.store.WorkerReputation(request.Context(), request.PathValue("worker_id"))
	writeResult(response, reputation, err)
}

func (server *Server) createJob(response http.ResponseWriter, request *http.Request) {
	var job Job
	if !decodeJSON(response, request, &job) {
		return
	}
	event, err := server.store.CreateJob(request.Context(), job)
	writeResult(response, event, err)
}

func (server *Server) getJob(response http.ResponseWriter, request *http.Request) {
	job, err := server.store.GetJob(request.Context(), request.PathValue("job_id"))
	writeResult(response, job, err)
}

func (server *Server) claimJob(response http.ResponseWriter, request *http.Request) {
	var claim JobClaim
	if !decodeJSON(response, request, &claim) {
		return
	}
	claim.JobID = request.PathValue("job_id")
	result, err := server.store.ClaimJob(request.Context(), claim)
	writeResult(response, result, err)
}

func (server *Server) requeueExpiredJobs(response http.ResponseWriter, request *http.Request) {
	result, err := server.store.RequeueExpiredJobs(request.Context())
	writeResult(response, result, err)
}

func (server *Server) updateJobStatus(response http.ResponseWriter, request *http.Request) {
	var status JobStatus
	if !decodeJSON(response, request, &status) {
		return
	}
	status.JobID = request.PathValue("job_id")
	event, err := server.store.UpdateJobStatus(request.Context(), status)
	writeResult(response, event, err)
}

func (server *Server) publishArtifact(response http.ResponseWriter, request *http.Request) {
	var artifact Artifact
	if !decodeJSON(response, request, &artifact) {
		return
	}
	event, err := server.store.PublishArtifact(request.Context(), artifact)
	writeResult(response, event, err)
}

func (server *Server) artifacts(response http.ResponseWriter, request *http.Request) {
	artifacts, err := server.store.Artifacts(request.Context())
	writeResult(response, artifacts, err)
}

func (server *Server) getArtifact(response http.ResponseWriter, request *http.Request) {
	artifact, err := server.store.GetArtifact(request.Context(), request.PathValue("job_id"))
	writeResult(response, artifact, err)
}

func (server *Server) recordArtifactVerdict(response http.ResponseWriter, request *http.Request) {
	var verdict ArtifactVerdict
	if !decodeJSON(response, request, &verdict) {
		return
	}
	verdict.JobID = request.PathValue("job_id")
	result, err := server.store.RecordArtifactVerdict(request.Context(), verdict)
	writeResult(response, result, err)
}

func (server *Server) events(response http.ResponseWriter, request *http.Request) {
	count, _ := strconv.Atoi(request.URL.Query().Get("count"))
	events, err := server.store.Events(request.Context(), count)
	writeResult(response, events, err)
}

func decodeJSON(response http.ResponseWriter, request *http.Request, target any) bool {
	defer request.Body.Close()
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return false
	}
	return true
}

func writeResult(response http.ResponseWriter, payload any, err error) {
	if err != nil {
		status := http.StatusBadRequest
		if strings.Contains(err.Error(), "connect") {
			status = http.StatusServiceUnavailable
		}
		writeJSON(response, status, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(response, http.StatusOK, payload)
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}
