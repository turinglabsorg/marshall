package coordinator

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
)

type Server struct {
	store Store
	mux   *http.ServeMux
}

func NewServer(store Store) *Server {
	server := &Server{
		store: store,
		mux:   http.NewServeMux(),
	}
	server.routes()
	return server
}

func (server *Server) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	server.mux.ServeHTTP(response, request)
}

func (server *Server) routes() {
	server.mux.HandleFunc("GET /health", server.health)
	server.mux.HandleFunc("POST /runs", server.createRun)
	server.mux.HandleFunc("POST /workers", server.registerWorker)
	server.mux.HandleFunc("POST /jobs", server.createJob)
	server.mux.HandleFunc("GET /jobs/{job_id}", server.getJob)
	server.mux.HandleFunc("POST /jobs/{job_id}/claim", server.claimJob)
	server.mux.HandleFunc("POST /jobs/{job_id}/status", server.updateJobStatus)
	server.mux.HandleFunc("POST /artifacts", server.publishArtifact)
	server.mux.HandleFunc("GET /artifacts/{job_id}", server.getArtifact)
	server.mux.HandleFunc("GET /events", server.events)
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

func (server *Server) getArtifact(response http.ResponseWriter, request *http.Request) {
	artifact, err := server.store.GetArtifact(request.Context(), request.PathValue("job_id"))
	writeResult(response, artifact, err)
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
