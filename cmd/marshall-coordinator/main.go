package main

import (
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/turinglabsorg/marshall/coordinator"
)

func main() {
	redisAddr := env("MARSHALL_REDIS_ADDR", "127.0.0.1:6379")
	httpAddr := env("MARSHALL_HTTP_ADDR", "127.0.0.1:8080")
	prefix := env("MARSHALL_REDIS_PREFIX", "marshall")
	token := env("MARSHALL_COORDINATOR_TOKEN", "")
	instanceID := env("MARSHALL_COORDINATOR_ID", "coordinator")

	var store coordinator.Store = coordinator.NewRedisStore(redisAddr, prefix)
	peers := parseFederationPeers(os.Getenv("MARSHALL_COORDINATOR_PEERS"))
	if len(peers) > 0 {
		federated, err := coordinator.NewFederatedStore(store, instanceID, peers, token)
		if err != nil {
			log.Fatal(err)
		}
		store = federated
	}
	server := coordinator.NewServer(store, coordinator.WithAuthToken(token), coordinator.WithInstanceID(instanceID))

	log.Printf("marshall coordinator %s listening on %s with redis %s federation_peers=%d", instanceID, httpAddr, redisAddr, len(peers))
	if err := http.ListenAndServe(httpAddr, server); err != nil {
		log.Fatal(err)
	}
}

func env(key string, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}

func parseFederationPeers(value string) []coordinator.FederationPeer {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	peers := make([]coordinator.FederationPeer, 0, len(parts))
	for _, part := range parts {
		id, peerURL, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok || strings.TrimSpace(id) == "" || strings.TrimSpace(peerURL) == "" {
			log.Fatalf("invalid MARSHALL_COORDINATOR_PEERS entry %q, expected id=url", part)
		}
		peers = append(peers, coordinator.FederationPeer{
			ID:  strings.TrimSpace(id),
			URL: strings.TrimSpace(peerURL),
		})
	}
	return peers
}
