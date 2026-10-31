package main

import (
	"context"
	"net"
)

func listenControlPlane(ctx context.Context, address string) (net.Listener, error) {
	config := controlPlaneTCPConfig()
	return config.Listen(ctx, "tcp", address)
}

func controlPlaneTCPConfig() net.ListenConfig {
	var config net.ListenConfig
	// Do not inherit the Go default or an operator GODEBUG override.
	// RouteWeaver does not expose MPTCP as a supported transport.
	config.SetMultipathTCP(false)
	return config
}
