package coordinator

import (
	_ "embed"
	"io"
	"net/http"
)

//go:embed public/index.html
var indexHTML string

//go:embed public/AGENTS.md
var participantAgentsMarkdown string

//go:embed public/favicon.svg
var faviconSVG string

func (server *Server) index(response http.ResponseWriter, request *http.Request) {
	if request.URL.Path != "/" {
		http.NotFound(response, request)
		return
	}
	response.Header().Set("Content-Type", "text/html; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	_, _ = io.WriteString(response, indexHTML)
}

func (server *Server) participantAgents(response http.ResponseWriter, _ *http.Request) {
	response.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	_, _ = io.WriteString(response, participantAgentsMarkdown)
}

func (server *Server) favicon(response http.ResponseWriter, _ *http.Request) {
	response.Header().Set("Content-Type", "image/svg+xml")
	response.Header().Set("Cache-Control", "public, max-age=3600")
	_, _ = io.WriteString(response, faviconSVG)
}
