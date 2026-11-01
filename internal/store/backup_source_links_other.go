//go:build !linux

package store

import (
	"errors"
	"os"
)

func requireSingleLinkBackupSource(info os.FileInfo) error {
	return errors.New("offline backup source link validation requires Linux")
}
