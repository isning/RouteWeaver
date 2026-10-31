package main

import (
	"strings"
	"testing"
)

func TestOfflinePasswordInputIsBoundedAndSingleLine(t *testing.T) {
	for _, raw := range []string{"tiny", strings.Repeat("x", 73), "synthetic-password\nsecond-line"} {
		if _, e := readRecoveryPassword(strings.NewReader(raw)); e == nil {
			t.Fatal("invalid password input accepted")
		}
	}
	if v, e := readRecoveryPassword(strings.NewReader("synthetic-private-password\n")); e != nil || v != "synthetic-private-password" {
		t.Fatal(v, e)
	}
}
