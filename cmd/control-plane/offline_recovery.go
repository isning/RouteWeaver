package main

import (
	"fmt"
	"io"
	"strings"
)

// Passwords are read from a private stdin pipe, not argv, environment or logs.
func readRecoveryPassword(r io.Reader) (string, error) {
	b, e := io.ReadAll(io.LimitReader(r, 75))
	if e != nil {
		return "", fmt.Errorf("cannot read recovery password")
	}
	text := strings.TrimSuffix(strings.TrimSuffix(string(b), "\n"), "\r")
	if len(text) < 12 || len(text) > 72 || strings.ContainsAny(text, "\r\n") {
		return "", fmt.Errorf("supply exactly one 12–72 byte temporary password on standard input")
	}
	return text, nil
}
