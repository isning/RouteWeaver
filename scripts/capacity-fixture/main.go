// capacity-fixture prepares synthetic accounts offline through the public store API.
// It is not a production account-management command.
package main

import (
	"encoding/hex"
	"fmt"
	"os"
	"routeweaver/internal/store"
	"time"
)

func main() {
	key, err := hex.DecodeString(os.Getenv("ROUTEWEAVER_MASTER_KEY"))
	must(err)
	s, err := store.Open(os.Args[1], key)
	must(err)
	defer s.Close()
	for i := 0; i < 25; i++ {
		_, token, err := s.CreateInvite(fmt.Sprintf("Capacity %02d", i), "user", time.Now().Add(time.Hour))
		must(err)
		_, err = s.AcceptInvite(token, fmt.Sprintf("capacity-%02d", i), os.Getenv("CAPACITY_PASSWORD"))
		must(err)
	}
}
func must(err error) {
	if err != nil {
		panic(err)
	}
}
