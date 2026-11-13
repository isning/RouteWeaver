package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"time"

	"routeweaver/internal/httpapi"
)

func configuredOIDC(path, origin string) (*httpapi.OIDCProvider, error) {
	if path == "" {
		return nil, nil
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, errors.New("cannot open OIDC configuration")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 1<<20 || info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("OIDC configuration must be a private regular file (0600), at most 1 MiB")
	}
	var config httpapi.OIDCConfig
	decoder := json.NewDecoder(io.LimitReader(file, 1<<20))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&config) != nil {
		return nil, errors.New("invalid OIDC configuration JSON")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return nil, errors.New("invalid OIDC configuration JSON")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return httpapi.NewOIDCProvider(ctx, config, origin)
}
