//go:build !linux

package backup

import "errors"

func publishSetDirectory(source, target string) error {
	return errors.New("atomic backup-set directory publication is supported only on Linux")
}

func checkSetFreeSpace(path string, required int64) error {
	return errors.New("backup-set workspace checks require Linux")
}
