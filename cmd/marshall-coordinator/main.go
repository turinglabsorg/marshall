package main

import (
	"log"
	"net/http"
	"os"

	"github.com/turinglabsorg/marshall/coordinator"
)

func main() {
	redisAddr := env("MARSHALL_REDIS_ADDR", "127.0.0.1:6379")
	httpAddr := env("MARSHALL_HTTP_ADDR", "127.0.0.1:8080")
	prefix := env("MARSHALL_REDIS_PREFIX", "marshall")

	store := coordinator.NewRedisStore(redisAddr, prefix)
	server := coordinator.NewServer(store)

	log.Printf("marshall coordinator listening on %s with redis %s", httpAddr, redisAddr)
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
