package agent

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"errors"
	"io"
	"path"
	"strings"

	"routeweaver/internal/controlprotocol"
)

const maxCoreExpandedBytes int64 = 512 << 20

// All archive entries are checked even though only the selected executable is
// retained. No archive-selected path is ever passed to filesystem extraction.
func extractCoreExecutable(data []byte, release controlprotocol.CoreRelease) ([]byte, error) {
	seen := map[string]bool{}
	var total int64
	count := 0
	check := func(name string, size int64, directory bool) error {
		clean := strings.TrimSuffix(name, "/")
		count++
		if count > 1024 || size < 0 || size > 128<<20 || total > maxCoreExpandedBytes-size {
			return errors.New("core archive expansion bounds exceeded")
		}
		total += size
		if clean == "" || clean == "." || clean == ".." || path.IsAbs(clean) || path.Clean(clean) != clean || strings.HasPrefix(clean, "../") || strings.ContainsAny(clean, "\\\x00\r\n:") || len(clean) > 240 || seen[clean] {
			return errors.New("unsafe or duplicate core archive path")
		}
		seen[clean] = true
		if directory && size != 0 {
			return errors.New("core archive directory contains data")
		}
		return nil
	}
	var result []byte
	switch release.ArchiveFormat {
	case "zip":
		archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
		if err != nil {
			return nil, errors.New("invalid core zip archive")
		}
		for _, file := range archive.File {
			if !file.Mode().IsRegular() && !file.Mode().IsDir() {
				return nil, errors.New("links and special files are forbidden in core archives")
			}
			if file.UncompressedSize64 > uint64(128<<20) {
				return nil, errors.New("core archive entry exceeds limit")
			}
			if err = check(file.Name, int64(file.UncompressedSize64), file.FileInfo().IsDir()); err != nil {
				return nil, err
			}
			stream, e := file.Open()
			if e != nil {
				return nil, e
			}
			content, e := io.ReadAll(io.LimitReader(stream, int64(file.UncompressedSize64)+1))
			closeErr := stream.Close()
			if e != nil || closeErr != nil || uint64(len(content)) != file.UncompressedSize64 {
				return nil, errors.New("core archive entry integrity mismatch")
			}
			if file.Name == release.ExecutablePath && !file.FileInfo().IsDir() {
				result = content
			}
		}
	case "tar.gz":
		compressed, err := gzip.NewReader(bytes.NewReader(data))
		if err != nil {
			return nil, errors.New("invalid core gzip archive")
		}
		defer compressed.Close()
		bounded := &io.LimitedReader{R: compressed, N: maxCoreExpandedBytes + 1}
		archive := tar.NewReader(bounded)
		for {
			header, e := archive.Next()
			if e == io.EOF {
				break
			}
			if e != nil {
				return nil, errors.New("invalid core tar archive")
			}
			if header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeDir {
				return nil, errors.New("links and special files are forbidden in core archives")
			}
			if e = check(header.Name, header.Size, header.Typeflag == tar.TypeDir); e != nil {
				return nil, e
			}
			content, e := io.ReadAll(io.LimitReader(archive, header.Size+1))
			if e != nil || int64(len(content)) != header.Size {
				return nil, errors.New("core archive entry integrity mismatch")
			}
			if header.Name == release.ExecutablePath && header.Typeflag == tar.TypeReg {
				result = content
			}
		}
		if _, err = io.Copy(io.Discard, bounded); err != nil || bounded.N <= 0 {
			return nil, errors.New("core archive expansion bounds or gzip integrity failed")
		}
	default:
		return nil, errors.New("core archive format is not supported by this installer")
	}
	if len(result) == 0 {
		return nil, errors.New("reviewed executable is missing from core archive")
	}
	return result, nil
}

// VerifyCoreArchive is the offline release-review seam. The supplied release is
// trusted review data, not remote authority. Prepare only supplies built-in
// catalog entries. This function never executes or writes an archive member.
func VerifyCoreArchive(data []byte, release controlprotocol.CoreRelease) ([]byte, error) {
	if int64(len(data)) > maxCoreArchiveBytes {
		return nil, errors.New("core archive exceeds compressed size limit")
	}
	if digestBytes(data) != release.ArchiveSHA256 {
		return nil, errors.New("official core archive checksum mismatch; no executable was installed")
	}
	executable, err := extractCoreExecutable(data, release)
	if err != nil {
		return nil, err
	}
	if digestBytes(executable) != release.ExecutableSHA256 {
		return nil, errors.New("official core executable checksum mismatch")
	}
	return executable, nil
}
