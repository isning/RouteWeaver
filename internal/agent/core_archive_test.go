package agent

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"os"
	"strings"
	"testing"

	"routeweaver/internal/controlprotocol"
)

func archiveFixture(t *testing.T, format, name string, mode os.FileMode, content string) []byte {
	t.Helper()
	var data bytes.Buffer
	if format == "zip" {
		z := zip.NewWriter(&data)
		h := &zip.FileHeader{Name: name, Method: zip.Deflate}
		h.SetMode(mode)
		w, err := z.CreateHeader(h)
		if err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(content))
		z.Close()
	} else {
		gz := gzip.NewWriter(&data)
		tw := tar.NewWriter(gz)
		kind := byte(tar.TypeReg)
		link := ""
		size := int64(len(content))
		if mode&os.ModeSymlink != 0 {
			kind = tar.TypeSymlink
			link = "/tmp/outside"
			size = 0
		}
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0600, Size: size, Typeflag: kind, Linkname: link}); err != nil {
			t.Fatal(err)
		}
		if size > 0 {
			tw.Write([]byte(content))
		}
		tw.Close()
		gz.Close()
	}
	return data.Bytes()
}
func TestVerifyCoreArchiveRejectsDangerousPinnedPackaging(t *testing.T) {
	for _, format := range []string{"zip", "tar.gz"} {
		for _, name := range []string{"../core", "/tmp/core", "dir/../../core", "dir\\core", "C:core"} {
			t.Run(format+name, func(t *testing.T) {
				data := archiveFixture(t, format, name, 0600, "binary")
				release := controlprotocol.CoreRelease{ArchiveFormat: format, ExecutablePath: name, ArchiveSHA256: digestBytes(data), ExecutableSHA256: digestBytes([]byte("binary"))}
				if _, err := VerifyCoreArchive(data, release); err == nil {
					t.Fatal("unsafe pinned archive accepted")
				}
			})
		}
		t.Run(format+"symlink", func(t *testing.T) {
			data := archiveFixture(t, format, "core", os.ModeSymlink|0600, "target")
			release := controlprotocol.CoreRelease{ArchiveFormat: format, ExecutablePath: "core", ArchiveSHA256: digestBytes(data), ExecutableSHA256: digestBytes([]byte("target"))}
			if _, err := VerifyCoreArchive(data, release); err == nil {
				t.Fatal("archive symlink accepted")
			}
		})
		t.Run(format+"safe", func(t *testing.T) {
			data := archiveFixture(t, format, "bundle/core", 0700, "binary")
			release := controlprotocol.CoreRelease{ArchiveFormat: format, ExecutablePath: "bundle/core", ArchiveSHA256: digestBytes(data), ExecutableSHA256: digestBytes([]byte("binary"))}
			got, err := VerifyCoreArchive(data, release)
			if err != nil || string(got) != "binary" {
				t.Fatalf("safe archive: %q %v", got, err)
			}
		})
	}
}

func TestVerifyCoreArchiveRejectsDuplicateAndExpansionBombMetadata(t *testing.T) {
	var duplicated bytes.Buffer
	zw := zip.NewWriter(&duplicated)
	for i := 0; i < 2; i++ {
		w, _ := zw.Create("core")
		w.Write([]byte("fixture"))
	}
	zw.Close()
	duplicate := duplicated.Bytes()
	release := controlprotocol.CoreRelease{ArchiveFormat: "zip", ExecutablePath: "core", ArchiveSHA256: digestBytes(duplicate), ExecutableSHA256: digestBytes([]byte("fixture"))}
	if _, err := VerifyCoreArchive(duplicate, release); err == nil {
		t.Fatal("duplicate executable archive accepted")
	}
	var bomb bytes.Buffer
	gz := gzip.NewWriter(&bomb)
	tw := tar.NewWriter(gz)
	tw.WriteHeader(&tar.Header{Name: "core", Mode: 0700, Typeflag: tar.TypeReg, Size: 129 << 20})
	tw.Close()
	gz.Close()
	data := bomb.Bytes()
	release.ArchiveFormat = "tar.gz"
	release.ArchiveSHA256 = digestBytes(data)
	if _, err := VerifyCoreArchive(data, release); err == nil {
		t.Fatal("oversize tar entry accepted")
	}
	valid := archiveFixture(t, "zip", "core", 0700, "fixture")
	release.ArchiveFormat = "zip"
	release.ArchiveSHA256 = digestBytes(valid)
	release.ExecutableSHA256 = strings.Repeat("0", 64)
	if _, err := VerifyCoreArchive(valid, release); err == nil {
		t.Fatal("unpinned executable accepted")
	}
}
