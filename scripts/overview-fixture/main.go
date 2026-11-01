// capacity-fixture prepares synthetic accounts offline through the public store API.
// It is not a production account-management command.
package main

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
	"time"
)

func main() {
	key, err := hex.DecodeString(os.Getenv("ROUTEWEAVER_MASTER_KEY"))
	must(err)
	s, err := store.Open(os.Args[1], key)
	must(err)
	defer s.Close()
	if os.Args[2] == "accounts" {
		for i := 0; i < 26; i++ {
			_, token, err := s.CreateInvite(fmt.Sprintf("Overview %02d", i), "user", time.Now().Add(time.Hour))
			must(err)
			_, err = s.AcceptInvite(token, fmt.Sprintf("capacity-%02d", i), os.Getenv("CAPACITY_PASSWORD"))
			must(err)
		}
		return
	}
	if os.Args[2] != "history" {
		panic("accounts or history required")
	}
	accounts, err := s.List("accounts")
	must(err)
	if len(accounts) != 26 {
		panic("exactly 26 synthetic accounts required")
	}
	at := time.Now().UTC().Add(-time.Hour)
	for _, raw := range accounts {
		var a store.Account
		must(json.Unmarshal(raw, &a))
		var index int
		_, err := fmt.Sscanf(a.Username, "capacity-%02d", &index)
		must(err)
		if index == 25 {
			continue
		}
		for base := 0; base < 4000; base += 200 {
			writes := make([]store.RecordWrite, 0, 200)
			for j := base; j < base+200; j++ {
				batch := store.MeterBatch{UserID: a.ID, RouteID: "reference-route", MeterID: "reference-meter", Epoch: "reference-history", Sequence: uint64(j + 1), RawBytes: int64(index + 1), ProviderBytes: int64(2 * (index + 1)), ObservedAt: at}
				key := fmt.Sprintf("%s:%s:%s:%d", a.ID, batch.MeterID, batch.Epoch, batch.Sequence)
				record := store.MeterRecord{MeterBatch: batch, WeightedBytes: (batch.RawBytes*3 + 1) / 2, RateID: "reference-rate", RateMicros: service.RateScale * 3 / 2, RecordedAt: at}
				writes = append(writes, store.RecordWrite{Kind: "ledger", ID: key, Value: record})
			}
			must(s.CompareAndPutRecords(nil, writes))
		}
	}

}
func must(err error) {
	if err != nil {
		panic(err)
	}
}
